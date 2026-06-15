import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { broadcastDeadlineAnnouncement, buildDeadlineAnnouncementMessages, sendApplicationConfirmPush } from "../src/line.js";

function createDbMock(config = {}) {
  const batchCalls = [];
  const prepareCalls = [];
  return {
    batchCalls,
    prepareCalls,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            prepareCalls.push({ sql, values });
            return {
              sql,
              values,
              async first() {
                return config.first ? config.first(sql, values) : null;
              },
              async all() {
                return config.all ? config.all(sql, values) : { results: [] };
              },
              async run() {
                return config.run ? config.run(sql, values) : { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch(statements) {
        batchCalls.push(statements);
        return config.batch ? config.batch(statements) : [];
      },
    },
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("POST /line/webhook returns 401 for invalid signature", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "APP-LINE",
  });
  const request = new Request("https://example.com/line/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Line-Signature": "invalid-signature",
    },
    body: JSON.stringify({ events: [] }),
  });
  const { DB } = createDbMock();
  const env = {
    DB,
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    ALLOWED_ORIGIN: "http://127.0.0.1:8787",
  };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 401);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "UNAUTHORIZED");
});

test("POST /line/webhook throttles repeated link failures, then allows one successful link and blocks relink", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "APP-LINE",
  });
  const stateByUserId = new Map();
  const linkedByUserId = new Map();
  const mock = createDbMock({
    first(sql, values) {
      if (sql.includes("FROM line_conv_state")) {
        const state = stateByUserId.get(values[0]);
        return state ? { state: JSON.stringify(state.state), expires_at: state.expiresAt } : null;
      }
      if (sql.includes("WHERE line_user_id = ?1 AND is_active = 1")) {
        const linkedPlayer = linkedByUserId.get(values[0]);
        return linkedPlayer ? { ...linkedPlayer, line_user_id: values[0] } : null;
      }
      if (sql.includes("WHERE player_no")) {
        return values[0] === "6" ? { id: 6, player_no: "6", name: "#6 赤穂雷太" } : null;
      }
      return null;
    },
    batch(statements) {
      for (const statement of statements) {
        if (statement.sql.includes("INSERT INTO line_conv_state")) {
          stateByUserId.set(statement.values[0], {
            state: JSON.parse(statement.values[1]),
            expiresAt: statement.values[2],
          });
        }
        if (statement.sql.includes("DELETE FROM line_conv_state")) {
          stateByUserId.delete(statement.values[0]);
        }
        if (statement.sql.includes("UPDATE players SET line_user_id")) {
          linkedByUserId.set(statement.values[0], { id: 6, player_no: "6", name: "#6 赤穂雷太" });
        }
      }
      return [];
    },
  });
  const env = {
    DB: mock.DB,
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    ALLOWED_ORIGIN: "http://127.0.0.1:8787",
  };

  for (let i = 1; i <= 5; i += 1) {
    const failureBody = JSON.stringify({
      events: [
        {
          type: "message",
          replyToken: `reply-fail-${i}`,
          source: { userId: "U123" },
          message: { type: "text", text: "9999" },
        },
      ],
    });
    const failureRequest = new Request("https://example.com/line/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Line-Signature": await signBody(failureBody, "line-secret"),
      },
      body: failureBody,
    });
    const response = await app.fetch(failureRequest, env, {});
    assert.equal(response.status, 200);
  }

  const lockedBody = JSON.stringify({
    events: [
      {
        type: "message",
        replyToken: "reply-locked",
        source: { userId: "U123" },
        message: { type: "text", text: "006" },
      },
    ],
  });
  const lockedRequest = new Request("https://example.com/line/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Line-Signature": await signBody(lockedBody, "line-secret"),
    },
    body: lockedBody,
  });
  const lockedResponse = await app.fetch(lockedRequest, env, {});
  assert.equal(lockedResponse.status, 200);
  assert.match(JSON.parse(fetchCalls.at(-1).options.body).messages[0].text, /Too many attempts/);

  stateByUserId.set("U123", {
    state: { linkFailures: 5, linkLockedUntil: "2026-06-12T23:59:59.000Z" },
    expiresAt: "2026-06-12T23:59:59.000Z",
  });
  const successBody = JSON.stringify({
    events: [
      {
        type: "message",
        replyToken: "reply-success",
        source: { userId: "U123" },
        message: { type: "text", text: "006" },
      },
    ],
  });
  const successRequest = new Request("https://example.com/line/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Line-Signature": await signBody(successBody, "line-secret"),
    },
    body: successBody,
  });
  const successResponse = await app.fetch(successRequest, env, {});
  const successJson = await successResponse.json();

  assert.equal(successResponse.status, 200);
  assert.equal(successJson.ok, true);
  assert.equal(linkedByUserId.get("U123")?.player_no, "6");
  assert.equal(stateByUserId.has("U123"), false);
  assert.match(JSON.parse(fetchCalls.at(-1).options.body).messages[0].text, /Registration complete!/);

  const relinkBody = JSON.stringify({
    events: [
      {
        type: "message",
        replyToken: "reply-relink",
        source: { userId: "U123" },
        message: { type: "text", text: "007" },
      },
    ],
  });
  const relinkRequest = new Request("https://example.com/line/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Line-Signature": await signBody(relinkBody, "line-secret"),
    },
    body: relinkBody,
  });
  const relinkResponse = await app.fetch(relinkRequest, env, {});
  assert.equal(relinkResponse.status, 200);
  assert.match(JSON.parse(fetchCalls.at(-1).options.body).messages[0].text, /already linked/);
});

test("POST /line/webhook menu:apply saves state and returns type quick reply", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const body = JSON.stringify({
    events: [
      {
        type: "postback",
        replyToken: "reply-token",
        source: { userId: "U123" },
        postback: { data: "menu:apply" },
      },
    ],
  });
  const signature = await signBody(body, "line-secret");
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "APP-LINE",
  });
  const request = new Request("https://example.com/line/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Line-Signature": signature,
    },
    body,
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("WHERE line_user_id")) {
        return { id: 6, player_no: "6", name: "#6 赤穂雷太", line_user_id: "U123" };
      }
      return null;
    },
  });
  const env = {
    DB: mock.DB,
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    ALLOWED_ORIGIN: "http://127.0.0.1:8787",
  };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 200);
  assert.equal(mock.batchCalls.length, 2);
  const replyPayload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(replyPayload.messages[0].text, "チケット種別を選んでください。");
  assert.equal(replyPayload.messages[0].quickReply.items.length, 3);
});

// ─── 締切前日アナウンス テスト ───────────────────────────────────────────────

test("buildDeadlineAnnouncementMessages: 日本語・英語両方の文面が1メッセージに含まれる", () => {
  const games = [
    { date: "2026-07-05", opponent: "横浜ビー・コルセアーズ" },
    { date: "2026-07-06", opponent: "信州ブレイブウォリアーズ" },
  ];
  const messages = buildDeadlineAnnouncementMessages(games);
  assert.equal(messages.length, 1);
  const text = messages[0].text;
  // 日本語部分
  assert.match(text, /締切のアナウンス/);
  assert.match(text, /明日の12時/);
  assert.match(text, /2026\/07\/05 vs 横浜ビー・コルセアーズ/);
  assert.match(text, /2026\/07\/06 vs 信州ブレイブウォリアーズ/);
  // 英語部分
  assert.match(text, /Application Deadline/);
  assert.match(text, /close tomorrow at 12:00/);
});

test("broadcastDeadlineAnnouncement: 対象ゲームなし → broadcast を呼ばない", async () => {
  const broadcastCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    broadcastCalls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() { return { results: [] }; },
            async first() { return null; },
          };
        },
      };
    },
    async batch() { return []; },
  };

  // UTC 09:00 = JST 18:00, tomorrow = 翌日（ゲームなし）
  const nowIso = "2026-07-04T09:00:00.000Z";
  const result = await broadcastDeadlineAnnouncement(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    nowIso
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, "no_target_games");
  // LINE broadcast は呼ばれていない
  assert.equal(broadcastCalls.filter((c) => c.url.includes("broadcast")).length, 0);
});

test("broadcastDeadlineAnnouncement: 対象ゲームあり → broadcast 1回 LINE API 呼び出し", async () => {
  const broadcastCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    broadcastCalls.push({ url, options });
    // quota: 1000残あり
    if (url.includes("quota/consumption")) {
      return new Response(JSON.stringify({ totalUsage: 0 }), { status: 200 });
    }
    if (url.includes("quota") && !url.includes("consumption")) {
      return new Response(JSON.stringify({ value: 1000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare(sql) {
      return {
        bind(tomorrowDate) {
          return {
            async all() {
              // "2026-07-05" が締切の試合を返す
              return {
                results: [
                  { game_no: "G01", date: "2026-07-10", day_of_week: "金", opponent: "横浜ビー・コルセアーズ" },
                ],
              };
            },
            async first() { return null; },
          };
        },
      };
    },
    async batch() { return []; },
  };

  // UTC 09:00 実行 = JST 18:00。明日(JST)は 2026-07-05
  const nowIso = "2026-07-04T09:00:00.000Z";
  const result = await broadcastDeadlineAnnouncement(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    nowIso
  );

  assert.equal(result.sent, true);
  assert.equal(result.gameCount, 1);
  const broadcastCall = broadcastCalls.find((c) => c.url.includes("broadcast"));
  assert.ok(broadcastCall, "broadcast エンドポイントが呼ばれていない");
  const body = JSON.parse(broadcastCall.options.body);
  assert.equal(body.messages[0].type, "text");
  assert.match(body.messages[0].text, /横浜ビー・コルセアーズ/);
});

test("broadcastDeadlineAnnouncement: quota不足 → broadcast しない", async () => {
  const broadcastCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    broadcastCalls.push({ url, options });
    if (url.includes("quota/consumption")) {
      return new Response(JSON.stringify({ totalUsage: 1000 }), { status: 200 });
    }
    if (url.includes("quota") && !url.includes("consumption")) {
      return new Response(JSON.stringify({ value: 1000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return {
                results: [
                  { game_no: "G01", date: "2026-07-10", day_of_week: "金", opponent: "横浜ビー・コルセアーズ" },
                ],
              };
            },
            async first() { return null; },
          };
        },
      };
    },
    async batch() { return []; },
  };

  const nowIso = "2026-07-04T09:00:00.000Z";
  const result = await broadcastDeadlineAnnouncement(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    nowIso
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, "quota_insufficient");
  assert.equal(broadcastCalls.filter((c) => c.url.includes("broadcast")).length, 0);
});

// ─── 申込完了push通知 テスト ─────────────────────────────────────────────────

test("sendApplicationConfirmPush: line_user_id 未連携はスキップ", async () => {
  const pushCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    pushCalls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM applications a")) {
                // line_user_id がない選手
                return {
                  app_id: "APP-1",
                  category: "invite",
                  quantity_adult: 2,
                  lang: "ja",
                  line_user_id: null,
                  player_id: 1,
                  game_id: 1,
                  game_no: "G01",
                  date: "2026-10-10",
                  day_of_week: "土",
                  opponent: "琉球",
                };
              }
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    async batch() { return []; },
  };

  const result = await sendApplicationConfirmPush(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    "APP-1"
  );

  assert.equal(result.pushed, false);
  assert.equal(result.reason, "line_unlinked");
  assert.equal(pushCalls.filter((c) => c.url.includes("/v2/bot/message/push")).length, 0);
});

test("sendApplicationConfirmPush: ja言語で正しい文面・枚数をpush", async () => {
  const pushCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    pushCalls.push({ url, options });
    if (url.includes("quota/consumption")) {
      return new Response(JSON.stringify({ totalUsage: 0 }), { status: 200 });
    }
    if (url.includes("quota") && !url.includes("consumption")) {
      return new Response(JSON.stringify({ value: 1000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM applications a")) {
                return {
                  app_id: "APP-2",
                  category: "family",
                  quantity_adult: 2,
                  lang: "ja",
                  line_user_id: "U456",
                  player_id: 2,
                  game_id: 3,
                  game_no: "G03",
                  date: "2026-10-17",
                  day_of_week: "土",
                  opponent: "島根",
                };
              }
              return null;
            },
            async all() {
              if (sql.includes("GROUP BY category")) {
                // 今回2枚含む家族席累計 = 5枚、招待 = 3枚（A9修正後: total_adult/child/infant 形式）
                return { results: [
                  { category: "family", total_adult: 5, total_child: 0, total_infant: 0 },
                  { category: "invite", total_adult: 3, total_child: 0, total_infant: 0 },
                ]};
              }
              return { results: [] };
            },
          };
        },
      };
    },
    async batch() { return []; },
  };

  const result = await sendApplicationConfirmPush(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    "APP-2"
  );

  assert.equal(result.pushed, true);
  const pushCall = pushCalls.find((c) => c.url.includes("/v2/bot/message/push"));
  assert.ok(pushCall, "push API が呼ばれていない");
  const body = JSON.parse(pushCall.options.body);
  assert.equal(body.to, "U456");
  const text = body.messages[0].text;
  assert.match(text, /申込を受け付けました/);
  assert.match(text, /2026\/10\/17 vs 島根/);
  assert.match(text, /家族席/);
  assert.match(text, /今回の申込: 2枚/);
  assert.match(text, /これまでの合計（種別ごと）/);
  assert.match(text, /招待: 3枚/);
  assert.match(text, /家族席: 5枚/);
});

test("sendApplicationConfirmPush: en言語で英語文面をpush", async () => {
  const pushCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    pushCalls.push({ url, options });
    if (url.includes("quota/consumption")) {
      return new Response(JSON.stringify({ totalUsage: 0 }), { status: 200 });
    }
    if (url.includes("quota") && !url.includes("consumption")) {
      return new Response(JSON.stringify({ value: 1000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM applications a")) {
                return {
                  app_id: "APP-3",
                  category: "invite",
                  quantity_adult: 3,
                  lang: "en",
                  line_user_id: "U789",
                  player_id: 3,
                  game_id: 5,
                  game_no: "G05",
                  date: "2026-10-24",
                  day_of_week: "土",
                  opponent: "千葉J",
                };
              }
              return null;
            },
            async all() {
              if (sql.includes("GROUP BY category")) {
                return { results: [{ category: "invite", total_adult: 3, total_child: 0, total_infant: 0 }] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
    async batch() { return []; },
  };

  const result = await sendApplicationConfirmPush(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    "APP-3"
  );

  assert.equal(result.pushed, true);
  const pushCall = pushCalls.find((c) => c.url.includes("/v2/bot/message/push"));
  const body = JSON.parse(pushCall.options.body);
  const text = body.messages[0].text;
  assert.match(text, /Application Received/);
  assert.match(text, /2026\/10\/24 vs 千葉J/);
  assert.match(text, /Invitation/);
  assert.match(text, /This application: 3 tickets/);
  assert.match(text, /Total for this game \(by type\)/);
  assert.match(text, /Invite: 3 tickets/);
});

test("sendApplicationConfirmPush: quota不足はpushをスキップ", async () => {
  const pushCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    pushCalls.push({ url, options });
    if (url.includes("quota/consumption")) {
      return new Response(JSON.stringify({ totalUsage: 1000 }), { status: 200 });
    }
    if (url.includes("quota") && !url.includes("consumption")) {
      return new Response(JSON.stringify({ value: 1000 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockDB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM applications a")) {
                return {
                  app_id: "APP-4",
                  category: "paid",
                  quantity_adult: 1,
                  lang: "ja",
                  line_user_id: "U999",
                  player_id: 4,
                  game_id: 7,
                  game_no: "G07",
                  date: "2026-11-07",
                  day_of_week: "土",
                  opponent: "群馬",
                };
              }
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    async batch() { return []; },
  };

  const result = await sendApplicationConfirmPush(
    { DB: mockDB, LINE_CHANNEL_ACCESS_TOKEN: "line-token" },
    "APP-4"
  );

  assert.equal(result.pushed, false);
  assert.equal(result.reason, "quota_insufficient");
  assert.equal(pushCalls.filter((c) => c.url.includes("/v2/bot/message/push")).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────

async function signBody(body, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Buffer.from(signature).toString("base64");
}
