import { error, HttpError, ok } from "./http.js";
import {
  createApplication,
  deleteExpiredSessions,
  findApplicationForConfirmPush,
  findApplicationForNotification,
  findPlayerByLineUserId,
  getConversationState,
  getLineStats,
  linkLineUserIdToPlayer,
  listApplicationsByPlayer,
  listGamesWithDeadlineTomorrow,
  listUpcomingGamesForLine,
  saveConversationState,
  clearConversationState,
} from "./repo.js";

const LINE_STATE_TTL_SECONDS = 10 * 60;
const LINE_LINK_FAILURE_LIMIT = 5;
const LINE_LINK_LOCK_SECONDS = 10 * 60;

export async function handleLineWebhook(request, env, origin, nowIso, randomToken) {
  try {
    const secret = env.LINE_CHANNEL_SECRET || "";
    if (!secret) throw new HttpError(503, "LINE_UNAVAILABLE", "Service Unavailable");

    const bodyText = await request.text();
    const signature = request.headers.get("X-Line-Signature") || "";
    const verified = await verifyLineSignature(bodyText, signature, secret);
    if (!verified) {
      return error(401, "UNAUTHORIZED", "Unauthorized", origin);
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new HttpError(400, "BAD_REQUEST", "Invalid JSON");
    }

    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const event of events) {
      await processLineEvent(event, env, nowIso, randomToken);
    }
    return ok({ accepted: true }, origin);
  } catch (err) {
    // LINE の無限リトライを防ぐため、いかなるエラーでも 200 を返す
    console.error("handleLineWebhook_error", { error: err?.message, stack: err?.stack });
    return ok({ accepted: true, error: err?.message }, origin);
  }
}

export async function handleScheduledLineJobs(controller, env) {
  const nowIso = new Date(controller?.scheduledTime || Date.now()).toISOString();
  await deleteExpiredSessions(env.DB, nowIso);

  // 締切前日アナウンス（毎日 18:00 JST = UTC 09:00, cron "0 9 * * *"）
  // 翌日12:00 JST 締切の試合があれば LINE broadcast する。
  // 手動配信は POST /api/admin/announce-deadline でも可能。
  await broadcastDeadlineAnnouncement(env, nowIso);
}

/**
 * 締切前日18:00 LINE broadcast アナウンス。
 * 翌日12:00 JST 締切の試合が1件以上あれば broadcast する。0件なら何もしない。
 */
export async function broadcastDeadlineAnnouncement(env, nowIso) {
  const games = await listGamesWithDeadlineTomorrow(env.DB, nowIso);
  if (!games.length) {
    console.log("broadcast_deadline_skip", { reason: "no_target_games", nowIso });
    return { sent: false, reason: "no_target_games", gameCount: 0 };
  }

  const stats = await getLineStats(env);
  // broadcast は友だち全員に1通 = quota 1消費
  if (typeof stats.remaining === "number" && stats.remaining < 1) {
    console.log("broadcast_deadline_skip", { reason: "quota_insufficient", remaining: stats.remaining });
    return { sent: false, reason: "quota_insufficient", remaining: stats.remaining };
  }

  const messages = buildDeadlineAnnouncementMessages(games);
  await broadcastToLine(env, messages);
  console.log("broadcast_deadline_sent", { gameCount: games.length, nowIso });
  return { sent: true, gameCount: games.length };
}

/**
 * 締切前日アナウンスのメッセージを組み立てる（日本語＋英語を1通に収める）。
 */
export function buildDeadlineAnnouncementMessages(games) {
  const jaLines = [
    "【締切のアナウンス】",
    "明日の12時で記載の試合のチケットの申込みは終了になります",
    "",
    "対象試合",
  ];
  for (const g of games) {
    const date = formatGameDate(g.date);
    jaLines.push(`・${date} vs ${g.opponent}`);
  }
  jaLines.push("＝＝＝＝＝＝＝");

  const enLines = [
    "[Application Deadline]",
    "Ticket applications for the games below will close tomorrow at 12:00.",
    "",
    "Games:",
  ];
  for (const g of games) {
    const date = formatGameDate(g.date);
    enLines.push(`・${date} vs ${g.opponent}`);
  }
  enLines.push("＝＝＝＝＝＝＝");

  const fullText = [...jaLines, "", ...enLines].join("\n");
  return [{ type: "text", text: fullText }];
}

/**
 * 試合日を YYYY/MM/DD 形式にフォーマット。
 */
function formatGameDate(date) {
  const [year = "", month = "", day = ""] = String(date).split("-");
  return `${year}/${month}/${day}`;
}

export async function verifyLineSignature(bodyText, signature, secret) {
  if (!signature || !secret) return false;
  let signatureBytes;
  try {
    signatureBytes = decodeBase64(signature);
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(bodyText));
}

export async function sendStatusUpdatePush(env, applicationId, status) {
  const record = await findApplicationForNotification(env.DB, applicationId);
  if (!record?.line_user_id) return { pushed: false, reason: "line_unlinked" };
  await pushToLine(env, record.line_user_id, [buildStatusMessage(record, status)]);
  return { pushed: true };
}

/**
 * 申込完了後に選手のLINEへ確認メッセージをpushする。
 * - line_user_id 未連携はスキップ（ログのみ）
 * - LINE quota の push 残量を確認し不足ならログのみ
 * @param {object} env - Cloudflare Workers env
 * @param {string} appId - 作成した applicationId
 * @returns {Promise<{pushed: boolean, reason?: string}>}
 */
export async function sendApplicationConfirmPush(env, appId) {
  try {
    const record = await findApplicationForConfirmPush(env.DB, appId);
    if (!record) {
      console.log("confirm_push_skip", { appId, reason: "record_not_found" });
      return { pushed: false, reason: "record_not_found" };
    }
    if (!record.lineUserId) {
      console.log("confirm_push_skip", { appId, reason: "line_unlinked" });
      return { pushed: false, reason: "line_unlinked" };
    }

    // quota確認（push は友だち1人に1通 = 1消費）
    const stats = await getLineStats(env);
    if (typeof stats.remaining === "number" && stats.remaining < 1) {
      console.log("confirm_push_skip", { appId, reason: "quota_insufficient", remaining: stats.remaining });
      return { pushed: false, reason: "quota_insufficient", remaining: stats.remaining };
    }

    const message = buildApplicationConfirmMessage(record);
    const pushResult = await pushToLine(env, record.lineUserId, [message]);
    if (pushResult?.ok) {
      console.log("confirm_push_sent", { appId, gameNo: record.gameNo, lang: record.lang, status: pushResult.status });
      return { pushed: true };
    } else {
      console.error("confirm_push_failed", { appId, gameNo: record.gameNo, status: pushResult?.status, message: pushResult?.message });
      return { pushed: false, reason: "api_error", status: pushResult?.status };
    }
  } catch (err) {
    // push失敗は申込成功を妨げない（ログのみ）
    console.error("confirm_push_error", { appId, error: err?.message, stack: err?.stack });
    return { pushed: false, reason: "error" };
  }
}

/**
 * 申込確認メッセージを言語に応じて組み立てる。
 * @param {object} record - findApplicationForConfirmPush の返却値
 */
function buildApplicationConfirmMessage(record) {
  const dateStr = formatGameDate(record.date);
  const gameTitle = `${dateStr} vs ${record.opponent}`;
  const thisQty = record.quantityAdult;
  const totals = record.categoryTotals || {};

  let text;
  if (record.lang === "en") {
    const categoryEn = ticketTypeEn(record.category);
    const totalLines = buildCategoryTotalLinesEn(totals);
    text = [
      "[Application Received]",
      `${gameTitle}`,
      `Category: ${categoryEn}`,
      `This application: ${thisQty} ticket${thisQty !== 1 ? "s" : ""}`,
      "Total for this game (by type):",
      ...totalLines,
    ].join("\n");
  } else {
    const categoryJa = ticketTypeJa(record.category);
    const totalLines = buildCategoryTotalLinesJa(totals);
    text = [
      "【申込を受け付けました】",
      `${gameTitle}`,
      `種別: ${categoryJa}`,
      `今回の申込: ${thisQty}枚`,
      "これまでの合計（種別ごと）:",
      ...totalLines,
    ].join("\n");
  }

  return { type: "text", text };
}

/**
 * 種別ごとの累計行（日本語）。申込のある種別のみ出力。
 * @param {{invite?: number, family?: number, paid?: number}} totals
 */
function buildCategoryTotalLinesJa(totals) {
  const map = [
    ["invite", "招待"],
    ["family", "家族席"],
    ["paid", "2F自由(有料)"],
  ];
  return map
    .filter(([key]) => Number(totals[key] || 0) > 0)
    .map(([key, label]) => `  ${label}: ${totals[key]}枚`);
}

/**
 * 種別ごとの累計行（英語）。申込のある種別のみ出力。
 * @param {{invite?: number, family?: number, paid?: number}} totals
 */
function buildCategoryTotalLinesEn(totals) {
  const map = [
    ["invite", "Invite"],
    ["family", "Family Seats"],
    ["paid", "2F Free (Paid)"],
  ];
  return map
    .filter(([key]) => Number(totals[key] || 0) > 0)
    .map(([key, label]) => {
      const n = Number(totals[key]);
      return `  ${label}: ${n} ticket${n !== 1 ? "s" : ""}`;
    });
}

function ticketTypeEn(value) {
  return { invite: "Invitation", family: "Family Seat", paid: "Paid Ticket" }[value] || value;
}

async function processLineEvent(event, env, nowIso, randomToken) {
  const userId = event?.source?.userId;
  if (!userId) return;

  if (event.type === "follow") {
    await replyToLine(env, event.replyToken, [buildFollowMessage()]);
    return;
  }

  const linkedPlayer = await findPlayerByLineUserId(env.DB, userId);

  if (event.type === "message" && event.message?.type === "text") {
    const text = String(event.message.text || "").trim();
    await handleTextMessage(env, event.replyToken, userId, linkedPlayer, text, nowIso);
    return;
  }

  if (event.type === "postback") {
    await handlePostback(env, event.replyToken, userId, linkedPlayer, event.postback?.data || "", nowIso, randomToken);
  }
}

async function handleTextMessage(env, replyToken, userId, linkedPlayer, text, nowIso) {
  if (!linkedPlayer) {
    // 先頭ゼロ付き4桁以内の番号（例: 006 / 0005）を受け付ける。DB照合は repo の normalizePlayerNo で正規化済み
    if (/^\d{1,4}$/.test(text)) {
      const linkState = await getConversationState(env.DB, userId, nowIso) || {};
      if (isLineLinkLocked(linkState, nowIso)) {
        await replyToLine(env, replyToken, [{
          type: "text",
          text: "連携試行が上限に達したため、一時的に受付を停止しています。\n10分ほど待ってから再度お試しください。\n\nToo many attempts. Please wait about 10 minutes and try again.",
        }]);
        return;
      }
      const saved = await linkLineUserIdToPlayer(env.DB, text, userId);
      if (saved) {
        await clearConversationState(env.DB, userId);
        await replyToLine(env, replyToken, [buildMainMenuMessage(
          "Registration complete! / 登録完了しました！\nUse the menu to apply for tickets or check your applications.\nチケット申込や確認はメニューから操作できます。"
        )]);
      } else {
        await persistLineLinkFailure(env, userId, linkState, nowIso);
        await replyToLine(env, replyToken, [{
          type: "text",
          text: "Player number not found. / 選手番号が見つかりませんでした。\nPlease enter the correct number.\n正しい番号を入力してください（例：006 / 101）",
        }]);
      }
      return;
    }

    await replyToLine(env, replyToken, [{
      type: "text",
      text: "個別のご連絡は本アカウントでは承っておりません。\nチームマネージャーまたはチケットチームまでお願いします。\n\nThis account cannot respond to individual messages.\nPlease contact your team manager or the ticket team.",
    }]);
    return;
  }

  if (/^\d{1,4}$/.test(text)) {
    await replyToLine(env, replyToken, [{
      type: "text",
      text: "このLINEアカウントは既に選手連携済みのため、番号の再登録はできません。\n\nThis LINE account is already linked to a player.",
    }]);
    return;
  }

  const state = await getConversationState(env.DB, userId, nowIso);
  if (state?.step === "SELECTING_COUNT") {
    const count = Number.parseInt(text, 10);
    if (!count || count < 1 || count > 6) {
      await replyToLine(env, replyToken, [{ type: "text", text: "1〜6の数字を入力してください。" }]);
      return;
    }
    state.adultCount = count;
    if (state.ticketType === "paid") {
      state.step = "SELECTING_SEAT_TYPE";
      await persistState(env, userId, state, nowIso);
      await replyToLine(env, replyToken, [{
        type: "text",
        text: "席種を選んでください。",
        quickReply: buildQuickReply([
          { label: "コートサイドシート", data: "seat:courtside" },
          { label: "2F自由席", data: "seat:free" },
          { label: "その他", data: "seat:other" },
        ]),
      }]);
      return;
    }
    state.step = "SELECTING_RECEIVER";
    await persistState(env, userId, state, nowIso);
    await replyToLine(env, replyToken, [{ type: "text", text: "受取者氏名を入力してください。" }]);
    return;
  }

  // session timeout: state が null の場合、各ステップの先頭で TTL切れを検知して案内
  if (!state) {
    await replyToLine(env, replyToken, [buildMainMenuMessage("セッションが切れました。もう一度「チケット申込」から始めてください。")]);
    return;
  }

  if (state?.step === "SELECTING_RECEIVER") {
    // バリデーション: 受取者名の入力チェック
    const trimmedText = text.trim();
    if (!trimmedText || trimmedText.length > 100) {
      await replyToLine(env, replyToken, [{ type: "text", text: "受取者氏名を正しく入力してください（1〜100文字）。" }]);
      return;
    }
    state.receiverName = trimmedText;
    state.step = "CONFIRMING";
    await persistState(env, userId, state, nowIso);
    await replyToLine(env, replyToken, [await buildConfirmMessage(env, state)]);
    return;
  }

  if (state?.step === "SELECTING_SEAT_TYPE") {
    await replyToLine(env, replyToken, [{ type: "text", text: "下のボタンから席種を選んでください。" }]);
    return;
  }

  if (state?.step === "SELECTING_PAYMENT") {
    await replyToLine(env, replyToken, [{ type: "text", text: "下のボタンから支払方法を選んでください。" }]);
    return;
  }

  if (state?.step === "CONFIRMING") {
    await replyToLine(env, replyToken, [await buildConfirmMessage(env, state)]);
    return;
  }

  await replyToLine(env, replyToken, [buildMainMenuMessage(
    "Individual inquiries cannot be accepted through this account.\n個別のご連絡は本アカウントでは承っておりません。\n\nPlease contact the team manager or ticket team.\nチームマネージャーまたはチケットチームまでお願いします。\n\nPlease use the menu below.\n以下のメニューからご利用ください。"
  )]);
}

async function handlePostback(env, replyToken, userId, linkedPlayer, data, nowIso, randomToken) {
  if (!linkedPlayer) return;

  if (data === "menu:apply") {
    await clearConversationState(env.DB, userId);
    await persistState(env, userId, { step: "SELECTING_TYPE" }, nowIso);
    await replyToLine(env, replyToken, [{
      type: "text",
      text: "チケット種別を選んでください。",
      quickReply: buildQuickReply([
        { label: "招待チケット", data: "type:invite" },
        { label: "家族席", data: "type:family" },
        { label: "有料チケット", data: "type:paid" },
      ]),
    }]);
    return;
  }

  if (data === "menu:check") {
    const applications = await listApplicationsByPlayer(env.DB, linkedPlayer.id);
    const recent = applications.slice(0, 5);
    const lines = recent.length
      ? recent.map((item) => `${statusEmoji(item.status)} ${statusJa(item.status)}: ${item.gameLabel} ${ticketTypeJa(item.ticketType)}`)
      : ["申込はありません。"];
    await replyToLine(env, replyToken, [{ type: "text", text: `直近の申込状況\n\n${lines.join("\n")}` }]);
    return;
  }

  if (data === "menu:help") {
    await replyToLine(env, replyToken, [{ type: "text", text: "ご不明な点はチケット担当にお問い合わせください。" }]);
    return;
  }

  if (data.startsWith("type:")) {
    const state = { ticketType: data.split(":")[1], step: "SELECTING_GAME" };
    await persistState(env, userId, state, nowIso);
    const games = await listUpcomingGamesForLine(env.DB, nowIso, 20);
    if (!games.length) {
      await replyToLine(env, replyToken, [{ type: "text", text: "現在申込可能な試合はありません。" }]);
      return;
    }
    await replyToLine(env, replyToken, [{
      type: "text",
      text: "試合を選んでください。",
      quickReply: buildQuickReply(games.map((game) => ({
        label: `${formatMonthDay(game.date)} vs ${game.opponent}`,
        data: `game:${game.gameId}`,
      }))),
    }]);
    return;
  }

  if (data.startsWith("game:")) {
    const state = await getConversationState(env.DB, userId, nowIso) || {};
    state.gameId = data.split(":")[1];
    state.step = "SELECTING_COUNT";
    await persistState(env, userId, state, nowIso);
    await replyToLine(env, replyToken, [{ type: "text", text: "大人の枚数を入力してください（1〜6）。" }]);
    return;
  }

  if (data.startsWith("seat:")) {
    const state = await getConversationState(env.DB, userId, nowIso);
    if (!state) {
      await replyToLine(env, replyToken, [buildMainMenuMessage("セッションが切れました。もう一度「チケット申込」から始めてください。")]);
      return;
    }
    state.seatType = data.split(":")[1];
    state.step = "SELECTING_PAYMENT";
    await persistState(env, userId, state, nowIso);
    await replyToLine(env, replyToken, [{
      type: "text",
      text: "支払方法を選んでください。",
      quickReply: buildQuickReply([
        { label: "給与天引き", data: "payment:salary" },
        { label: "当日現金", data: "payment:cash" },
      ]),
    }]);
    return;
  }

  if (data.startsWith("payment:")) {
    const state = await getConversationState(env.DB, userId, nowIso);
    if (!state) {
      await replyToLine(env, replyToken, [buildMainMenuMessage("セッションが切れました。もう一度「チケット申込」から始めてください。")]);
      return;
    }
    state.payment = data.split(":")[1];
    state.step = "CONFIRMING";
    await persistState(env, userId, state, nowIso);
    await replyToLine(env, replyToken, [await buildConfirmMessage(env, state)]);
    return;
  }

  if (data === "confirm:yes") {
    const state = await getConversationState(env.DB, userId, nowIso);
    if (!state) {
      await replyToLine(env, replyToken, [buildMainMenuMessage("セッションが切れました。もう一度「チケット申込」から始めてください。")]);
      return;
    }
    // 二重加算防止: clearConversationState を先に実行し、2回目の確定タップは state=null で弾く
    await clearConversationState(env.DB, userId);
    try {
      await submitLineApplication(env, linkedPlayer, state, nowIso, randomToken);
      await replyToLine(env, replyToken, [buildMainMenuMessage("申込が完了しました！担当から確定の連絡が届きます。")]);
    } catch (err) {
      // 409 DUPLICATE
      if (err?.status === 409) {
        await replyToLine(env, replyToken, [buildMainMenuMessage(err.message || "この内容は既に申込済みです。")]);
      } else {
        // その他エラー
        await replyToLine(env, replyToken, [buildMainMenuMessage(err.message || "申込に失敗しました。もう一度お試しください。")]);
      }
    }
    return;
  }

  if (data === "confirm:no") {
    await clearConversationState(env.DB, userId);
    await replyToLine(env, replyToken, [buildMainMenuMessage("キャンセルしました。")]);
  }
}

async function submitLineApplication(env, player, state, nowIso, randomToken) {
  try {
    const result = await createApplication(env.DB, { player_id: player.id }, {
      gameId: state.gameId,
      category: state.ticketType,
      quantityAdult: Number.parseInt(String(state.adultCount || 1), 10) || 1,
      quantityChild: 0,
      quantityInfant: 0,
      seatType: state.seatType || "",
      seatRequest: "",
      receiverName: state.receiverName || player.name,
      pickupMethod: "pre",
      paymentMethod: state.payment || "",
      parkingCount: 0,
      note: "LINE申込",
      lang: "ja",
      source: "line",
      createdAt: nowIso,
    }, randomToken(), nowIso);

    // 申込成功後、確認メッセージをpushする
    await sendApplicationConfirmPush(env, result.appId);
  } catch (err) {
    // 409 DUPLICATE: 既に同内容で申込済み
    if (err?.status === 409) {
      throw new HttpError(409, "DUPLICATE", "この内容は既に申込済みです");
    }
    // その他のエラー: 汎用エラーメッセージ
    console.error("submitLineApplication_error", { playerId: player.id, error: err?.message, stack: err?.stack });
    throw new HttpError(400, "SUBMIT_ERROR", "申込に失敗しました。もう一度お試しください");
  }
}

async function persistState(env, userId, state, nowIso) {
  await saveConversationState(env.DB, userId, state, addSeconds(nowIso, LINE_STATE_TTL_SECONDS));
}

async function persistLineLinkFailure(env, userId, currentState, nowIso) {
  const failures = Number(currentState?.linkFailures || 0) + 1;
  const lockedUntil = failures >= LINE_LINK_FAILURE_LIMIT ? addSeconds(nowIso, LINE_LINK_LOCK_SECONDS) : null;
  await saveConversationState(
    env.DB,
    userId,
    {
      ...currentState,
      linkFailures: failures,
      linkLockedUntil: lockedUntil,
    },
    lockedUntil || addSeconds(nowIso, LINE_STATE_TTL_SECONDS)
  );
}

function isLineLinkLocked(state, nowIso) {
  return Boolean(state?.linkLockedUntil && state.linkLockedUntil > nowIso);
}

async function buildConfirmMessage(env, state) {
  const games = await listUpcomingGamesForLine(env.DB, "1970-01-01T00:00:00.000Z", 50);
  const game = games.find((item) => item.gameId === state.gameId);
  const lines = [
    "以下の内容で申込みます",
    "",
    `試合: ${game ? `${formatMonthDay(game.date)}（${game.dayOfWeek}）vs ${game.opponent}` : state.gameId}`,
    `種別: ${ticketTypeJa(state.ticketType)}`,
    `大人: ${state.adultCount}枚`,
  ];
  if (state.receiverName) lines.push(`受取者: ${state.receiverName}`);
  if (state.seatType) lines.push(`席種: ${seatTypeJa(state.seatType)}`);
  if (state.payment) lines.push(`支払: ${paymentJa(state.payment)}`);
  return {
    type: "text",
    text: lines.join("\n"),
    quickReply: buildQuickReply([
      { label: "はい（送信）", data: "confirm:yes" },
      { label: "キャンセル", data: "confirm:no" },
    ]),
  };
}

function buildMainMenuMessage(text) {
  return {
    type: "text",
    text,
    quickReply: buildQuickReply([
      { label: "チケット申込", data: "menu:apply" },
      { label: "申込確認", data: "menu:check" },
      { label: "ヘルプ", data: "menu:help" },
    ]),
  };
}

function buildFollowMessage() {
  return {
    type: "text",
    text:
      "🏀 Akita Northern Happinets\n\n" +
      "This account is exclusively for the Player Family Ticket Application System.\n" +
      "このアカウントは選手家族チケット申込システム専用です。\n\n" +
      "Please enter your player number (3 digits) or staff number.\n" +
      "選手番号（3桁）またはスタッフ番号を入力してください。\n\n" +
      "Your number can be confirmed with the team manager.\n" +
      "番号はチームマネージャーにご確認ください。\n\n" +
      "This system is only available for Akita Northern Happinets home games.\n" +
      "このシステムは秋田ノーザンハピネッツのホームゲームのみ対象です。\n\n" +
      "Example / 例）006 / 101",
  };
}

function buildQuickReply(items) {
  return {
    items: items.map((item) => ({
      type: "action",
      action: {
        type: "postback",
        label: item.label,
        data: item.data,
        displayText: item.label,
      },
    })),
  };
}

function buildStatusMessage(record, status) {
  return {
    type: "text",
    text: [
      "🏀 チケット申込ステータス更新",
      "",
      `試合: ${record.game_label}`,
      `種別: ${ticketTypeJa(record.category)}`,
      `ステータス: ${statusJa(status)}`,
    ].join("\n"),
  };
}

async function replyToLine(env, replyToken, messages) {
  if (!replyToken) return;
  await callLineApi(env, "https://api.line.me/v2/bot/message/reply", {
    replyToken,
    messages,
  });
}

async function pushToLine(env, to, messages) {
  if (!to) return { ok: false, message: "missing_to" };
  return await callLineApi(env, "https://api.line.me/v2/bot/message/push", {
    to,
    messages,
  });
}

async function broadcastToLine(env, messages) {
  return await callLineApi(env, "https://api.line.me/v2/bot/message/broadcast", {
    messages,
  });
}

/**
 * LINE API を呼び出して、ステータス・レスポンスボディを返す。
 * @returns {{ok: boolean, status: number, message?: string}}
 */
async function callLineApi(env, url, body) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN || "";
  if (!token) {
    console.warn("line_api_skip", { url, reason: "no_token" });
    return { ok: false, status: 0, message: "no_token" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();
    if (response.ok) {
      console.log("line_api_ok", { url, status: response.status });
      return { ok: true, status: response.status };
    } else {
      const errorMsg = responseBody ? `(${responseBody})` : "";
      console.error("line_api_error", { url, status: response.status, message: errorMsg });
      return { ok: false, status: response.status, message: responseBody };
    }
  } catch (err) {
    console.error("line_api_network_error", { url, error: err?.message });
    return { ok: false, status: 0, message: err?.message };
  }
}

function decodeBase64(input) {
  const binary = atob(input);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function addSeconds(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + seconds * 1000).toISOString();
}

function formatMonthDay(date) {
  const [, month = "", day = ""] = String(date).match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  return `${Number(month)}/${Number(day)}`;
}

function ticketTypeJa(value) {
  return { invite: "招待チケット", family: "家族席", paid: "有料チケット" }[value] || value;
}

function seatTypeJa(value) {
  return { courtside: "コートサイドシート", free: "2F自由席", other: "その他" }[value] || value;
}

function paymentJa(value) {
  return { salary: "給与天引き", cash: "当日現金" }[value] || value;
}

function statusJa(value) {
  return { pending: "確認中", confirmed: "確保済み", rejected: "対応不可", cancelled: "キャンセル" }[value] || value;
}

function statusEmoji(value) {
  return { pending: "⏳", confirmed: "✅", rejected: "❌", cancelled: "🚫" }[value] || "📋";
}
