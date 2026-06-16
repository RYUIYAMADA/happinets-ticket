import {
  deadlineAt,
  parseApplicationInput,
  parseGameInput,
  parsePlayerInput,
  parseQuantityInput,
  parseStatusInput,
} from "./domain.js";
import { requireAdminSession, requirePlayerSession, requireTicketAdmin, verifyAdminPassword } from "./auth.js";
import { error, HttpError, ok } from "./http.js";
import { broadcastDeadlineAnnouncement, buildDeadlineAnnouncementMessages, handleLineWebhook, handleScheduledLineJobs, sendApplicationConfirmPush, sendStatusUpdatePush } from "./line.js";
import { listGamesWithDeadlineTomorrow } from "./repo.js";
import {
  cancelApplication,
  createAdminSession,
  createApplication,
  createGame,
  createPlayer,
  createPlayerSession,
  deleteGame,
  findAdminByRole,
  findGameByIdentifier,
  findPlayerByLineUserId,
  findPlayerByPlayerNo,
  getLineStats,
  linkLineUserIdToPlayer,
  listAdminApplications,
  listApplicationsByPlayer,
  listGames,
  listPlayers,
  logoutSession,
  recordAdminLoginFailure,
  replaceSeason,
  setApplicationQuantity,
  updateApplicationStatus,
  updateGame,
  updateGameDeadline,
  updatePlayer,
} from "./repo.js";

const PLAYER_SESSION_TTL_SECONDS = 6 * 60 * 60;
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function createApp(options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const randomToken = options.randomToken || (() => crypto.randomUUID());
  const checkAdminPassword = options.verifyAdminPassword || verifyAdminPassword;
  const sendConfirmPush = options.sendConfirmPush || sendApplicationConfirmPush;

  return {
    async fetch(request, env) {
      const origin = await resolveOrigin(request, env);
      try {
        if (request.method === "OPTIONS") {
          const corsOpts = {
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          };
          if (origin) corsOpts["Access-Control-Allow-Origin"] = origin;
          return new Response(null, { status: 204, headers: corsOpts });
        }

        const url = new URL(request.url);
        const nowIso = now();

        if (request.method === "POST" && url.pathname === "/api/auth/login") {
          return await handlePlayerLogin(request, env, origin, nowIso, randomToken);
        }
        if (request.method === "POST" && url.pathname === "/api/auth/liff-login") {
          return await handleLiffLogin(request, env, origin, nowIso, randomToken);
        }
        if (request.method === "POST" && url.pathname === "/api/auth/link-liff") {
          return await handleLinkLiff(request, env, origin, nowIso, randomToken);
        }
        if (request.method === "POST" && url.pathname === "/line/webhook") {
          return await handleLineWebhook(request, env, origin, nowIso, randomToken);
        }
        if (request.method === "POST" && url.pathname === "/api/auth/admin-login") {
          return await handleAdminLogin(request, env, origin, nowIso, randomToken, checkAdminPassword);
        }
        if (request.method === "POST" && url.pathname === "/api/auth/logout") {
          return await handleLogout(request, env, origin);
        }
        if (request.method === "GET" && url.pathname === "/api/games") {
          return await handleListGames(url, env, origin, nowIso);
        }
        if (request.method === "POST" && url.pathname === "/api/applications") {
          return await handleCreateApplication(request, env, origin, nowIso, randomToken, sendConfirmPush);
        }
        if (request.method === "GET" && url.pathname === "/api/applications") {
          return await handleListOwnApplications(request, url, env, origin, nowIso);
        }
        {
          const matched = url.pathname.match(/^\/api\/applications\/([^/]+)\/cancel$/);
          if (request.method === "PUT" && matched) {
            return await handleCancelApplication(request, env, origin, nowIso, decodeURIComponent(matched[1]));
          }
        }
        {
          // PATCH /api/applications/:id — 利用者が枚数を絶対値で変更（締切後403・他人申込403）
          const matched = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
          if (request.method === "PATCH" && matched) {
            return await handlePatchApplication(request, env, origin, nowIso, decodeURIComponent(matched[1]));
          }
        }
        if (request.method === "GET" && url.pathname === "/api/admin/applications") {
          return await handleAdminApplications(request, url, env, origin, nowIso);
        }
        {
          const matched = url.pathname.match(/^\/api\/admin\/applications\/([^/]+)\/status$/);
          if (request.method === "PUT" && matched) {
            return await handleAdminUpdateStatus(request, env, origin, nowIso, decodeURIComponent(matched[1]));
          }
        }
        {
          // PUT /api/admin/applications/:id — 管理者が枚数を絶対値で変更（締切無視）
          const matched = url.pathname.match(/^\/api\/admin\/applications\/([^/]+)$/);
          if (request.method === "PUT" && matched) {
            return await handleAdminUpdateApplicationQuantity(request, env, origin, nowIso, decodeURIComponent(matched[1]));
          }
        }
        if (request.method === "GET" && url.pathname === "/api/admin/players") {
          return await handleAdminPlayers(request, env, origin, nowIso);
        }
        if (request.method === "POST" && url.pathname === "/api/admin/players") {
          return await handleAdminCreatePlayer(request, env, origin, nowIso);
        }
        {
          const matched = url.pathname.match(/^\/api\/admin\/players\/([^/]+)$/);
          if (request.method === "PUT" && matched) {
            return await handleAdminUpdatePlayer(request, env, origin, nowIso, decodeURIComponent(matched[1]));
          }
        }
        if (request.method === "POST" && url.pathname === "/api/admin/games") {
          return await handleAdminCreateGame(request, env, origin, nowIso);
        }
        {
          const deadlineMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)\/deadline$/);
          if (request.method === "PUT" && deadlineMatch) {
            return await handleAdminUpdateDeadline(request, env, origin, nowIso, decodeURIComponent(deadlineMatch[1]));
          }
        }
        if (request.method === "POST" && url.pathname === "/api/admin/games/replace-season") {
          return await handleReplaceSeason(request, env, origin, nowIso);
        }
        if (request.method === "GET" && url.pathname === "/api/admin/line-stats") {
          return await handleLineStats(request, env, origin, nowIso);
        }
        if (request.method === "POST" && url.pathname === "/api/admin/announce-deadline") {
          return await handleAnnounceDeadline(request, url, env, origin, nowIso);
        }
        {
          const gameMatch = url.pathname.match(/^\/api\/admin\/games\/([^/]+)$/);
          if (request.method === "PUT" && gameMatch) {
            return await handleAdminUpdateGame(request, env, origin, nowIso, decodeURIComponent(gameMatch[1]));
          }
          if (request.method === "DELETE" && gameMatch) {
            return await handleAdminDeleteGame(request, env, origin, nowIso, decodeURIComponent(gameMatch[1]));
          }
        }
        if (request.method === "GET" && url.pathname === "/api/admin/export") {
          return await handleAdminExport(request, url, env, origin, nowIso);
        }
        return error(404, "NOT_FOUND", "Not Found", origin);
      } catch (err) {
        if (err instanceof HttpError) {
          return error(err.status, err.code, err.message, origin);
        }
        console.error("worker_error", err);
        return error(500, "INTERNAL_ERROR", "Internal Server Error", origin);
      }
    },
  };
}

async function handlePlayerLogin(request, env, origin, nowIso, randomToken) {
  const body = await readJson(request);
  const rawPlayerId = body?.playerId;
  if (!rawPlayerId) throw new HttpError(400, "BAD_REQUEST", "playerId is required");
  const player = await findPlayerByPlayerNo(env.DB, rawPlayerId);
  if (!player) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
  const expiresAt = addSeconds(nowIso, PLAYER_SESSION_TTL_SECONDS);
  const token = randomToken();
  await createPlayerSession(env.DB, token, player.id, expiresAt);
  return ok({
    token,
    playerId: String(player.player_no),
    playerNo: String(player.player_no).padStart(3, "0"),
    name: player.name,
    role: "player",
    expiresAt,
  }, origin);
}

/**
 * POST /api/auth/liff-login
 * LIFFのIDトークンをLINE verify APIで検証し、player特定 → セッション発行。
 * 未連携の場合は 409 UNLINKED を返す。
 */
async function handleLiffLogin(request, env, origin, nowIso, randomToken) {
  let body;
  try {
    body = await readJson(request);
    const idToken = body?.idToken;
    if (!idToken || typeof idToken !== "string" || idToken.split(".").length !== 3) {
      throw new HttpError(400, "BAD_REQUEST", "idToken is required or invalid format");
    }
    const channelId = env.LINE_LOGIN_CHANNEL_ID;
    if (!channelId) {
      throw new HttpError(503, "CONFIGURATION_ERROR", "LINE_LOGIN_CHANNEL_ID is not configured");
    }
    const lineUserId = await verifyLineIdToken(idToken, channelId);
    const player = await findPlayerByLineUserId(env.DB, lineUserId);
    if (!player) {
      return new Response(JSON.stringify({ ok: false, error: { code: "UNLINKED", message: "Player not linked" } }), {
        status: 409,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
    const token = randomToken();
    const expiresAt = addSeconds(nowIso, PLAYER_SESSION_TTL_SECONDS);
    await createPlayerSession(env.DB, token, player.id, expiresAt);
    return ok({
      token,
      playerId: String(player.player_no),
      playerNo: String(player.player_no).padStart(3, "0"),
      name: player.name,
      role: "player",
      expiresAt,
    }, origin);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : (e.message || "Authentication failed");
    const code = e instanceof HttpError ? e.code : "AUTH_ERROR";
    const status = e instanceof HttpError ? e.status : 400;
    console.error("handleLiffLogin error:", { code, message: msg, idTokenLen: body?.idToken?.length });
    return error(status, code, msg, origin);
  }
}

/**
 * POST /api/auth/link-liff
 * 初回連携: IDトークン検証 → line_user_id を players に紐付け → セッション発行。
 * body: { idToken, playerId }  playerId は背番号 (例: "006")
 */
async function handleLinkLiff(request, env, origin, nowIso, randomToken) {
  let body;
  try {
    body = await readJson(request);
    const idToken = body?.idToken;
    const rawPlayerId = body?.playerId;
    if (!idToken || typeof idToken !== "string" || idToken.split(".").length !== 3) {
      throw new HttpError(400, "BAD_REQUEST", "idToken is required or invalid format");
    }
    if (!rawPlayerId) {
      throw new HttpError(400, "BAD_REQUEST", "playerId is required");
    }
    const channelId = env.LINE_LOGIN_CHANNEL_ID;
    if (!channelId) {
      throw new HttpError(503, "CONFIGURATION_ERROR", "LINE_LOGIN_CHANNEL_ID is not configured");
    }
    // IDトークン再検証（lineUserIdをフロントから受け取らずWorker側で取得する = 改ざん防止）
    const lineUserId = await verifyLineIdToken(idToken, channelId);
    // 既に連携済みのアカウントが存在するか確認
    const alreadyLinked = await findPlayerByLineUserId(env.DB, lineUserId);
    if (alreadyLinked) {
      // 既連携ならそのままセッション発行（再連携操作として扱う）
      const token = randomToken();
      const expiresAt = addSeconds(nowIso, PLAYER_SESSION_TTL_SECONDS);
      await createPlayerSession(env.DB, token, alreadyLinked.id, expiresAt);
      return ok({
        token,
        playerId: String(alreadyLinked.player_no),
        playerNo: String(alreadyLinked.player_no).padStart(3, "0"),
        name: alreadyLinked.name,
        role: "player",
        expiresAt,
      }, origin);
    }
    // 背番号で選手を検索して line_user_id を登録
    const player = await linkLineUserIdToPlayer(env.DB, rawPlayerId, lineUserId);
    if (!player) {
      throw new HttpError(401, "UNAUTHORIZED", "Player not found");
    }
    const token = randomToken();
    const expiresAt = addSeconds(nowIso, PLAYER_SESSION_TTL_SECONDS);
    await createPlayerSession(env.DB, token, player.id, expiresAt);
    return ok({
      token,
      playerId: String(player.player_no),
      playerNo: String(player.player_no).padStart(3, "0"),
      name: player.name,
      role: "player",
      expiresAt,
    }, origin, 201);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : (e.message || "Link failed");
    const code = e instanceof HttpError ? e.code : "LINK_ERROR";
    const status = e instanceof HttpError ? e.status : 400;
    console.error("handleLinkLiff error:", { code, message: msg, playerId: body?.playerId });
    return error(status, code, msg, origin);
  }
}

/**
 * LINE verify API でIDトークンを検証し line_user_id (sub) を返す。
 * iss / aud / exp の必須チェックを含む。
 */
async function verifyLineIdToken(idToken, channelId) {
  const verifyRes = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  if (!verifyRes.ok) {
    // LINEが検証エラーを返した場合（期限切れ・不正トークン等）
    // idToken・ユーザー情報の全文ログを避け error フィールドのみ記録する
    try {
      const errorBody = await verifyRes.text();
      let errorCode;
      try {
        errorCode = JSON.parse(errorBody)?.error;
      } catch {
        // parse失敗時は error コードなし
      }
      console.error("verifyLineIdToken_error", errorCode ? { status: verifyRes.status, error: errorCode } : { status: verifyRes.status });
    } catch (e) {
      // レスポンス読み込み失敗時もログには出す
      console.error("verifyLineIdToken_error", { status: verifyRes.status });
    }
    throw new HttpError(401, "INVALID_ID_TOKEN", "ID token verification failed");
  }
  const payload = await verifyRes.json();
  // 必須フィールド検証
  if (payload.iss !== "https://access.line.me") {
    throw new HttpError(401, "INVALID_ID_TOKEN", "Invalid issuer");
  }
  if (String(payload.aud) !== String(channelId)) {
    throw new HttpError(401, "INVALID_ID_TOKEN", "Invalid audience");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSec) {
    throw new HttpError(401, "INVALID_ID_TOKEN", "ID token expired");
  }
  if (!payload.sub) {
    throw new HttpError(401, "INVALID_ID_TOKEN", "Missing sub claim");
  }
  return String(payload.sub);
}

async function handleAdminLogin(request, env, origin, nowIso, randomToken, checkAdminPassword) {
  const body = await readJson(request);
  if (!body?.password) throw new HttpError(400, "BAD_REQUEST", "password is required");
  const admin = await findAdminByRole(env.DB, "ticket");
  if (!admin) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
  if (admin.locked_until && admin.locked_until > nowIso) {
    throw new HttpError(429, "RATE_LIMITED", "LOCKED");
  }
  const verified = await checkAdminPassword(body.password, env.ADMIN_SALT || "", admin.pw_hash);
  if (!verified) {
    await recordAdminLoginFailure(env.DB, admin, nowIso);
    throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
  }
  const token = randomToken();
  const expiresAt = addSeconds(nowIso, ADMIN_SESSION_TTL_SECONDS);
  await createAdminSession(env.DB, token, admin, expiresAt);
  return ok({ token, role: "admin", adminRole: admin.role, expiresAt }, origin);
}

async function handleLogout(request, env, origin) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/, "") || "";
  if (token) await logoutSession(env.DB, token);
  return ok(undefined, origin);
}

async function handleListGames(url, env, origin, nowIso) {
  const activeParam = url.searchParams.get("active");
  const games = await listGames(env.DB, {
    season: url.searchParams.get("season") || "",
    active: activeParam === null ? undefined : activeParam === "true",
  }, nowIso);
  return ok({
    serverNow: nowIso,
    games,
  }, origin);
}

async function handleCreateApplication(request, env, origin, nowIso, randomToken, sendConfirmPush) {
  const auth = await requirePlayerSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  const payload = parseApplicationInput(body, nowIso);
  const appId = randomToken();
  const { appId: resolvedAppId } = await createApplication(env.DB, auth.session, payload, appId, nowIso);
  // 申込完了後、非同期でLINE push（失敗しても申込成功を妨げない）
  // resolvedAppId = INSERTされた実appId を渡す（別レコード化により毎回新規INSERT）
  sendConfirmPush(env, resolvedAppId).catch((err) => {
    console.error("confirm_push_unhandled", { appId: resolvedAppId, error: err?.message });
  });
  return ok({ applicationId: resolvedAppId }, origin, 201);
}

async function handleCancelApplication(request, env, origin, nowIso, appId) {
  const auth = await requirePlayerSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  return ok(await cancelApplication(env.DB, appId, auth.session.player_id, nowIso), origin);
}

/**
 * PATCH /api/applications/:id
 * 利用者が枚数を絶対値で変更する。
 * - 締切後は 403
 * - 他人の申込は 403（setApplicationQuantity内でplayerIdチェック）
 * - 合計0枚でキャンセル扱い
 */
async function handlePatchApplication(request, env, origin, nowIso, appId) {
  const auth = await requirePlayerSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;

  // 申込の game を取得して締切確認
  const appRow = await env.DB.prepare(
    `SELECT a.player_id, g.deadline FROM applications a INNER JOIN games g ON g.id = a.game_id WHERE a.app_id = ?1`
  ).bind(appId).first();
  if (!appRow) throw new HttpError(404, "NOT_FOUND", "Application not found");

  // 所有権を先にチェック（締切より先にチェックすることで情報漏洩を防ぐ）
  if (appRow.player_id !== auth.session.player_id) {
    throw new HttpError(403, "FORBIDDEN", "Forbidden");
  }

  // 締切チェック（domain.js の deadlineAt に統一）
  const dl = appRow.deadline ? deadlineAt(appRow.deadline) : null;
  if (dl && dl < nowIso) {
    throw new HttpError(403, "DEADLINE_PASSED", "Deadline has passed");
  }

  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  const qty = parseQuantityInput(body);
  return ok(
    await setApplicationQuantity(
      env.DB, appId, qty,
      `player:${auth.session.player_id}`,
      auth.session.player_id,
      nowIso
    ),
    origin
  );
}

/**
 * PUT /api/admin/applications/:id
 * 管理者が枚数を絶対値で変更する（締切を無視、admin_sessions 必須）。
 */
async function handleAdminUpdateApplicationQuantity(request, env, origin, nowIso, appId) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  const qty = parseQuantityInput(body);
  return ok(
    await setApplicationQuantity(
      env.DB, appId, qty,
      `admin:${auth.session.admin_role}`,
      null,  // playerId=null → 所有権チェックなし（管理者は全申込を操作可）
      nowIso
    ),
    origin
  );
}

async function handleListOwnApplications(request, url, env, origin, nowIso) {
  const auth = await requirePlayerSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  if (url.searchParams.has("playerId")) throw new HttpError(400, "BAD_REQUEST", "playerId query is not allowed");
  return ok(await listApplicationsByPlayer(env.DB, auth.session.player_id), origin);
}

async function handleAdminApplications(request, url, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  // A6修正: requireTicketAdmin を追加（管理者認可）
  requireTicketAdmin(auth.session);
  return ok(await listAdminApplications(env.DB, {
    gameId: url.searchParams.get("gameId") || "",
    category: url.searchParams.get("category") || "",
    status: url.searchParams.get("status") || "",
    playerId: url.searchParams.get("playerId") || "",
  }), origin);
}

async function handleAdminUpdateStatus(request, env, origin, nowIso, appId) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  const status = parseStatusInput(body);
  const result = await updateApplicationStatus(env.DB, appId, status, auth.session, nowIso);
  // push失敗がステータス更新の500に昇格しないよう非同期fire-and-forget化
  sendStatusUpdatePush(env, appId, status).catch((err) => {
    console.error("status_update_push_unhandled", { appId, status, error: err?.message });
  });
  return ok(result, origin);
}

async function handleAdminPlayers(request, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  return ok(await listPlayers(env.DB), origin);
}

async function handleAdminCreatePlayer(request, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  const payload = parsePlayerInput(body);
  return ok(await createPlayer(env.DB, payload), origin, 201);
}

async function handleAdminUpdatePlayer(request, env, origin, nowIso, playerNo) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  const payload = parsePlayerInput(body, playerNo);
  return ok(await updatePlayer(env.DB, payload.playerNo, payload), origin);
}

async function handleAdminCreateGame(request, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  return ok(await createGame(env.DB, parseGameInput(body)), origin, 201);
}

async function handleAdminUpdateGame(request, env, origin, nowIso, gameNo) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  return ok(await updateGame(env.DB, gameNo, parseGameInput(body, gameNo), nowIso), origin);
}

async function handleAdminDeleteGame(request, env, origin, nowIso, gameNo) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  return ok(await deleteGame(env.DB, gameNo), origin);
}

async function handleAdminUpdateDeadline(request, env, origin, nowIso, gameNo) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  if (!body?.deadline) throw new HttpError(400, "BAD_REQUEST", "deadline is required");
  return ok(await updateGameDeadline(env.DB, gameNo, body.deadline), origin);
}

async function handleReplaceSeason(request, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  const body = await readJson(request);
  if (!body) throw new HttpError(400, "BAD_REQUEST", "Request body must be JSON");
  if (!body?.season || !Array.isArray(body.games)) throw new HttpError(400, "BAD_REQUEST", "season and games are required");
  return ok(await replaceSeason(env.DB, body.season, body.games), origin);
}

async function handleLineStats(request, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);
  return ok(await getLineStats(env), origin);
}

/**
 * POST /api/admin/announce-deadline?dryRun=true
 * 締切前日アナウンスをプレビューまたは実送信する。
 * dryRun=true: 文面のみ返却（実 broadcast しない）。
 * dryRun=false or 省略: 実際に broadcast を実行。
 */
async function handleAnnounceDeadline(request, url, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  requireTicketAdmin(auth.session);

  const dryRun = url.searchParams.get("dryRun") === "true";
  const games = await listGamesWithDeadlineTomorrow(env.DB, nowIso);

  if (dryRun) {
    const messages = games.length ? buildDeadlineAnnouncementMessages(games) : [];
    return ok({
      dryRun: true,
      gameCount: games.length,
      preview: messages.map((m) => m.text).join("\n---\n"),
    }, origin);
  }

  const result = await broadcastDeadlineAnnouncement(env, nowIso);
  return ok({ dryRun: false, ...result }, origin);
}

/**
 * GET /api/admin/export?category=invite|family|paid
 * 申込履歴を種別ごとにCSV（UTF-8 BOM付き）でダウンロード。
 * admin セッション必須。全件出力（cancelled を含む）。
 * 選手番号は先頭ゼロ保持のため ="006" 形式でエスケープ。
 */
async function handleAdminExport(request, url, env, origin, nowIso) {
  const auth = await requireAdminSession(request, env, origin, nowIso);
  if (!auth.ok) return auth.response;
  // A6修正: requireTicketAdmin を追加（管理者認可）
  requireTicketAdmin(auth.session);

  const category = url.searchParams.get("category") || "";
  const VALID_EXPORT_CATEGORIES = ["invite", "family", "paid"];
  if (category && !VALID_EXPORT_CATEGORIES.includes(category)) {
    throw new HttpError(400, "BAD_REQUEST", "category must be invite, family, or paid");
  }

  const CATEGORY_LABELS = { invite: "招待チケット", family: "家族席", paid: "2F自由有料" };
  const STATUS_JP = { pending: "確認中", confirmed: "確保済み", rejected: "対応不可", cancelled: "キャンセル" };
  const PICKUP_JP = { pre: "事前受取", day: "当日受取" };
  const PAYMENT_JP = { salary: "給与天引き", cash: "当日現金", free: "無料（招待）" };

  // 対象カテゴリ決定
  const targetCategories = category ? [category] : VALID_EXPORT_CATEGORIES;

  // 全カテゴリをまとめて1クエリ（ORDER BY category, created_at）
  const catFilter = targetCategories.map((_, i) => `?${i + 1}`).join(",");
  const result = await env.DB.prepare(`
    SELECT
      a.app_id,
      p.player_no,
      p.name  AS player_name,
      g.game_no,
      g.date  AS game_date,
      g.day_of_week,
      g.opponent,
      a.category,
      a.quantity_adult,
      a.quantity_child,
      a.quantity_infant,
      a.seat_type,
      a.seat_request,
      a.receivers,
      a.pickup_method,
      a.payment_method,
      a.parking,
      a.note,
      a.status,
      a.created_at
    FROM applications a
    INNER JOIN players p ON p.id = a.player_id
    INNER JOIN games   g ON g.id  = a.game_id
    WHERE a.category IN (${catFilter})
    ORDER BY a.category ASC, a.created_at ASC
  `).bind(...targetCategories).all();

  const rows = result.results || [];

  // CSV ヘッダー行
  const HEADERS = [
    "申込ID", "種別", "選手番号", "選手名",
    "試合ID", "試合日", "曜日", "対戦相手",
    "大人枚数", "子ども枚数", "乳幼児枚数",
    "受取者氏名", "受取方法", "支払方法",
    "席種", "座席希望", "駐車場台数", "特記事項",
    "ステータス", "申込日時",
  ];

  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // A4修正: CSV式インジェクション対策。先頭が =/+/-/@ の場合はシングルクォートを前置
    const needsQuote = s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r");
    const injectionChars = /^[=+\-@\t\r]/;
    if (injectionChars.test(s)) {
      return "'" + (needsQuote ? '"' + s.replace(/"/g, '""') + '"' : s);
    }
    if (needsQuote) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // 先頭ゼロ保持: Excelが文字列として扱うよう ="006" 形式
  function zeroSafe(no) {
    if (!no) return "";
    const padded = String(no).padStart(3, "0");
    return `="${padded}"`;
  }

  function parseReceiversName(receiversJson) {
    try {
      const arr = JSON.parse(receiversJson || "[]");
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map(r => r.name || "").filter(Boolean).join(" / ");
      }
    } catch {}
    return "";
  }

  const csvRows = rows.map(r => [
    csvEscape(r.app_id),
    csvEscape(CATEGORY_LABELS[r.category] || r.category),
    csvEscape(zeroSafe(r.player_no)),
    csvEscape(r.player_name),
    csvEscape(r.game_no),
    csvEscape(r.game_date),
    csvEscape(r.day_of_week),
    csvEscape(r.opponent),
    csvEscape(r.quantity_adult),
    csvEscape(r.quantity_child),
    csvEscape(r.quantity_infant),
    csvEscape(parseReceiversName(r.receivers)),
    csvEscape(PICKUP_JP[r.pickup_method] || r.pickup_method || ""),
    csvEscape(PAYMENT_JP[r.payment_method] || r.payment_method || ""),
    csvEscape(r.seat_type || ""),
    csvEscape(r.seat_request || ""),
    csvEscape(r.parking),
    csvEscape(r.note || ""),
    csvEscape(STATUS_JP[r.status] || r.status),
    csvEscape(r.created_at),
  ].join(","));

  const headerLine = HEADERS.map(csvEscape).join(",");
  const csvContent = [headerLine, ...csvRows].join("\r\n");

  // UTF-8 BOM 付き（Excel/Sheets 文字化け防止）
  const BOM = "﻿";
  const fullCsv = BOM + csvContent;

  const catLabel = category ? (CATEGORY_LABELS[category] || category) : "全種別";
  const dateStr = nowIso.slice(0, 10).replace(/-/g, "");
  const filename = `family-tickets-${category || "all"}-${dateStr}.csv`;

  const corsHeaders = {};
  if (origin) corsHeaders["Access-Control-Allow-Origin"] = origin;

  return new Response(fullCsv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=UTF-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      ...corsHeaders,
    },
  });
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) return null;
  return request.json();
}

/**
 * リクエストのOriginヘッダと設定値からCORSオリジンを判定。
 * ALLOWED_ORIGIN がカンマ区切り複数値の場合は全て検証対象にする。
 */
async function resolveOrigin(request, env) {
  const requestOrigin = request.headers.get("Origin") || "";
  const configOrigins = (env.ALLOWED_ORIGIN || "").split(",").map(o => o.trim()).filter(Boolean);

  if (!configOrigins.length) return "";
  if (configOrigins.length === 1) return configOrigins[0];
  // 複数許可オリジンがある場合、リクエストOriginが一致すれば反射（厳密チェック）
  return configOrigins.includes(requestOrigin) ? requestOrigin : "";
}

function addSeconds(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + seconds * 1000).toISOString();
}

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    return handleScheduledLineJobs(controller, env, ctx);
  },
};
