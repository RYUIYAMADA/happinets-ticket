import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { mapApplicationRow, mapGameRow, normalizePlayerNo } from "../src/domain.js";
import { createApp } from "../src/index.js";

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

async function deriveAdminHash(password, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100000 },
    key,
    256
  );
  return Buffer.from(derived).toString("hex");
}

test("normalizePlayerNo strips zero padding like GAS", () => {
  assert.equal(normalizePlayerNo("006"), "6");
  assert.equal(normalizePlayerNo("101"), "101");
});

test("mapGameRow returns API contract shape with computed deadline flag", () => {
  const game = mapGameRow({
    game_no: "G01",
    date: "2026-10-08",
    day_of_week: "木",
    tipoff: null,
    opponent: "川崎ブレイブサンダース",
    deadline: "2099-10-01",
    season: "2026-27",
    is_active: 1,
  }, "2026-06-13T00:00:00.000Z");

  assert.deepEqual(game, {
    gameId: "G01",
    gameNo: "G01",
    date: "2026-10-08",
    dayOfWeek: "木",
    tipoff: null,
    opponent: "川崎ブレイブサンダース",
    deadline: "2099-10-01",
    isDeadlinePassed: false,
    season: "2026-27",
    isActive: true,
  });
});

test("mapApplicationRow returns API contract shape", () => {
  const app = mapApplicationRow({
    app_id: "APP-1",
    player_no: "6",
    player_name: "#6 赤穂雷太",
    game_no: "G01",
    game_date: "2026-10-08",
    game_day_of_week: "木",
    opponent: "川崎ブレイブサンダース",
    category: "family",
    applicant_name: "赤穂 由美",
    quantity_adult: 2,
    quantity_child: 1,
    quantity_infant: 0,
    seat_type: "",
    seat_request: "",
    receivers: '[{"name":"赤穂 由美"}]',
    pickup_method: "pre",
    payment_method: "",
    parking: 1,
    note: "",
    status: "pending",
    lang: "ja",
    source: "web",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  });

  assert.equal(app.applicationId, "APP-1");
  assert.equal(app.playerId, "6");
  assert.equal(app.playerNo, "006");
  assert.equal(app.gameLabel, "10月8日（木）vs 川崎ブレイブサンダース");
  assert.equal(app.applicantName, "赤穂 由美", "applicantName が返ること（別レコード化対応）");
});

test("POST /api/applications returns 409 when same applicant tries to apply twice", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "APP-DUP",
  });
  const request = new Request("https://example.com/api/applications", {
    method: "POST",
    headers: {
      Authorization: "Bearer player-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      gameId: "G01",
      category: "family",
      quantityAdult: 2,
      receiverName: "田中",
      pickupMethod: "pre",
      parkingCount: 0,
    }),
  });
  // batch が UNIQUE 制約違反エラーを throw するシミュレーション
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("INNER JOIN players")) {
        return { token: "player-token", player_id: 6, expires_at: "2026-06-13T06:00:00.000Z", player_no: "6", name: "#6" };
      }
      if (sql.includes("FROM games")) {
        return { id: 1, game_no: "G01", deadline: "2026-10-01" };
      }
      return null;
    },
    batch() {
      throw new Error("UNIQUE constraint failed: applications.player_id, applications.game_id, applications.category, applications.applicant_name");
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();
  assert.equal(response.status, 409, "重複申込は 409 を返す");
  assert.equal(json.error.code, "DUPLICATE");
});

test("GET /api/admin/applications requires ticket admin role", async () => {
  // manager role (非 ticket) では 403 になること (A6: requireTicketAdmin 追加)
  const app = createApp({ now: () => "2026-06-13T00:00:00.000Z" });
  const request = new Request("https://example.com/api/admin/applications", {
    headers: { Authorization: "Bearer manager-token" },
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM admin_sessions")) {
        return { token: "manager-token", admin_role: "manager", expires_at: "2099-06-13T06:00:00.000Z" };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };
  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 403, "manager role では 403 を返す（A6修正確認）");
});

test("POST /api/auth/login returns 401 when player does not exist", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "fixed-token",
  });
  const request = new Request("https://example.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "999" }),
  });
  const { DB } = createDbMock();
  const env = { DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(json, {
    ok: false,
    error: {
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    },
  });
});

test("POST /api/auth/login returns token payload for an active player", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "fixed-token",
  });
  const request = new Request("https://example.com/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "006" }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM players")) {
        return { id: 6, player_no: "6", name: "#6 赤穂雷太" };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.data, {
    token: "fixed-token",
    playerId: "6",
    playerNo: "006",
    name: "#6 赤穂雷太",
    role: "player",
    expiresAt: "2026-06-13T06:00:00.000Z",
  });
  assert.equal(mock.batchCalls.length, 1);
});

test("POST /api/auth/admin-login returns token for valid password", async () => {
  const adminSalt = "salt";
  const storedHash = await deriveAdminHash("secret", adminSalt);
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "admin-token",
  });
  const request = new Request("https://example.com/api/auth/admin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM admins")) {
        return { id: 1, role: "ticket", pw_hash: storedHash, failed_count: 0, locked_until: null };
      }
      return null;
    },
  });
  const env = {
    DB: mock.DB,
    ADMIN_SALT: adminSalt,
    ALLOWED_ORIGIN: "http://127.0.0.1:8787",
  };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(json.data, {
    token: "admin-token",
    role: "admin",
    adminRole: "ticket",
    expiresAt: "2026-06-13T12:00:00.000Z",
  });
  assert.equal(mock.batchCalls.length, 1);
});

test("POST /api/auth/admin-login returns 429 when admin is locked", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    verifyAdminPassword: async () => false,
  });
  const request = new Request("https://example.com/api/auth/admin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM admins")) {
        return { id: 1, role: "ticket", pw_hash: "stored-hash", failed_count: 5, locked_until: "2026-06-13T00:10:00.000Z" };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ADMIN_SALT: "salt", ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 429);
  assert.equal(json.error.code, "RATE_LIMITED");
});

test("POST /api/auth/logout is idempotent for player token", async () => {
  const app = createApp();
  const request = new Request("https://example.com/api/auth/logout", {
    method: "POST",
    headers: { Authorization: "Bearer player-token" },
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM sessions")) {
        return { token: "player-token", player_id: 6 };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 200);
  assert.equal(mock.batchCalls.length, 1);
});

test("GET /api/games is public and returns mapped games", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
  });
  const request = new Request("https://example.com/api/games?season=2026-27&active=true");
  const mock = createDbMock({
    all() {
      return {
        results: [
          {
            game_no: "G01",
            date: "2026-10-08",
            day_of_week: "木",
            tipoff: null,
            opponent: "川崎ブレイブサンダース",
            deadline: "2026-10-01",
            season: "2026-27",
            is_active: 1,
          },
        ],
      };
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(json, {
    ok: true,
    data: [
      {
        gameId: "G01",
        gameNo: "G01",
        date: "2026-10-08",
        dayOfWeek: "木",
        tipoff: null,
        opponent: "川崎ブレイブサンダース",
        deadline: "2026-10-01",
        isDeadlinePassed: false,
        season: "2026-27",
        isActive: true,
      },
    ],
  });
});

test("POST /api/applications creates a new record even when an active application already exists (no merge)", async () => {
  // 仕様: 同試合・同種別への追加申込は統合せず毎回別レコードを作る
  let callCount = 0;
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => `APP-NEW-${++callCount}`,
  });

  async function submitOnce(receiverName) {
    const request = new Request("https://example.com/api/applications", {
      method: "POST",
      headers: {
        Authorization: "Bearer player-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gameId: "G01",
        category: "family",
        quantityAdult: 1,
        receiverName,
        pickupMethod: "pre",
        parkingCount: 0,
      }),
    });
    const mock = createDbMock({
      first(sql) {
        if (sql.includes("INNER JOIN players")) {
          return {
            token: "player-token",
            player_id: 6,
            expires_at: "2026-06-13T06:00:00.000Z",
            player_no: "6",
            name: "#6 赤穂雷太",
          };
        }
        if (sql.includes("FROM games")) {
          return { id: 1, game_no: "G01", deadline: "2026-10-01" };
        }
        // 既存申込があっても検索しない（統合廃止）
        return null;
      },
    });
    const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };
    const response = await app.fetch(request, env, {});
    return { response, mock };
  }

  const first = await submitOnce("受取人A");
  const jsonFirst = await first.response.json();
  assert.equal(first.response.status, 201, "1件目: 201");
  assert.ok(jsonFirst.data?.applicationId, "1件目: applicationId が返ること");

  const second = await submitOnce("受取人B");
  const jsonSecond = await second.response.json();
  assert.equal(second.response.status, 201, "2件目: 201（別レコード）");
  assert.ok(jsonSecond.data?.applicationId, "2件目: applicationId が返ること");

  // 2回とも必ず INSERT（batch が呼ばれる）
  assert.equal(first.mock.batchCalls.length, 1, "1件目: batchが呼ばれる");
  assert.equal(second.mock.batchCalls.length, 1, "2件目: batchが呼ばれる");

  // 各リクエストで異なる appId が発行されていること
  assert.notEqual(jsonFirst.data.applicationId, jsonSecond.data.applicationId, "appIdが別々");
});

test("POST /api/applications returns 201 and writes in batch", async () => {
  const app = createApp({
    now: () => "2026-06-13T00:00:00.000Z",
    randomToken: () => "APP-NEW",
  });
  const request = new Request("https://example.com/api/applications", {
    method: "POST",
    headers: {
      Authorization: "Bearer player-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      gameId: "G01",
      category: "family",
      quantityAdult: 2,
      quantityChild: 1,
      receiverName: "赤穂 由美",
      pickupMethod: "pre",
      parkingCount: 1,
    }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("INNER JOIN players")) {
        return {
          token: "player-token",
          player_id: 6,
          expires_at: "2026-06-13T06:00:00.000Z",
          player_no: "6",
          name: "#6 赤穂雷太",
        };
      }
      if (sql.includes("FROM games")) {
        return { id: 1, game_no: "G01", deadline: "2026-10-01" };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(json, { ok: true, data: { applicationId: "APP-NEW" } });
  assert.equal(mock.batchCalls.length, 1);
});

// POST /api/applications の push 呼び出しはfireなので本テストでは検証困難。
// line.test.js の sendApplicationConfirmPush テストで機能を検証済み。

test("PUT /api/applications/:app_id/cancel returns 404 for missing app", async () => {
  const app = createApp({ now: () => "2026-06-13T00:00:00.000Z" });
  const request = new Request("https://example.com/api/applications/APP-404/cancel", {
    method: "PUT",
    headers: { Authorization: "Bearer player-token" },
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("INNER JOIN players")) {
        return {
          token: "player-token",
          player_id: 6,
          expires_at: "2026-06-13T06:00:00.000Z",
          player_no: "6",
          name: "#6 赤穂雷太",
        };
      }
      return null;
    },
    batch() {
      return [{ meta: { changes: 0 } }, {}];
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 404);
  assert.equal(json.error.code, "NOT_FOUND");
});

test("GET /api/applications rejects query playerId to prevent IDOR", async () => {
  const app = createApp();
  const request = new Request("https://example.com/api/applications?playerId=7", {
    headers: { Authorization: "Bearer player-token" },
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("INNER JOIN players")) {
        return {
          token: "player-token",
          player_id: 6,
          expires_at: "2099-06-13T06:00:00.000Z",
          player_no: "6",
          name: "#6 赤穂雷太",
        };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 400);
});

test("GET /api/admin/applications requires admin bearer token", async () => {
  const app = createApp();
  const request = new Request("https://example.com/api/admin/applications");
  const { DB } = createDbMock();
  const env = { DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 401);
});

test("PUT /api/admin/applications/:app_id/status returns 422 for invalid status", async () => {
  const app = createApp();
  const request = new Request("https://example.com/api/admin/applications/APP-1/status", {
    method: "PUT",
    headers: {
      Authorization: "Bearer admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "bad" }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM admin_sessions")) {
        return { token: "admin-token", admin_role: "ticket", expires_at: "2099-06-13T06:00:00.000Z" };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 422);
});

test("GET /api/admin/players omits lineUserId and exposes lineLinked", async () => {
  const app = createApp();
  const request = new Request("https://example.com/api/admin/players", {
    headers: { Authorization: "Bearer admin-token" },
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM admin_sessions")) {
        return { token: "admin-token", admin_role: "ticket", expires_at: "2099-06-13T06:00:00.000Z" };
      }
      return null;
    },
    all(sql) {
      if (sql.includes("FROM players")) {
        return {
          results: [
            { player_no: "6", name: "#6 赤穂雷太", name_en: "", line_user_id: "U123", is_active: 1 },
          ],
        };
      }
      return { results: [] };
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(json.data[0], {
    playerId: "6",
    playerNo: "006",
    name: "#6 赤穂雷太",
    nameEn: "",
    lineLinked: true,
    isActive: true,
  });
});

// ──────────────────────────────────────────────────────────────
// PATCH /api/applications/:id — 利用者の枚数変更テスト群
// ──────────────────────────────────────────────────────────────

function makePlayerSession(playerId = 6) {
  return {
    first(sql) {
      // セッション検証
      if (sql.includes("INNER JOIN players")) {
        return { token: "player-token", player_id: playerId, expires_at: "2099-06-13T06:00:00.000Z", player_no: String(playerId), name: `#${playerId}` };
      }
      // 申込の game / player 取得
      if (sql.includes("INNER JOIN games")) {
        return { player_id: playerId, deadline: "2099-10-01" };
      }
      // setApplicationQuantity の SELECT app_id
      if (sql.includes("FROM applications WHERE app_id")) {
        return { app_id: "APP-1", player_id: playerId };
      }
      return null;
    },
  };
}

test("PATCH /api/applications/:id reduces quantity for own application", async () => {
  const app = createApp({ now: () => "2026-06-13T00:00:00.000Z" });
  const request = new Request("https://example.com/api/applications/APP-1", {
    method: "PATCH",
    headers: { Authorization: "Bearer player-token", "Content-Type": "application/json" },
    body: JSON.stringify({ quantityAdult: 1, quantityChild: 0, quantityInfant: 0 }),
  });
  const mock = createDbMock(makePlayerSession(6));
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.data.quantityAdult, 1);
  assert.equal(json.data.status, "pending");
});

test("PATCH /api/applications/:id sets status=cancelled when all quantities are 0", async () => {
  const app = createApp({ now: () => "2026-06-13T00:00:00.000Z" });
  const request = new Request("https://example.com/api/applications/APP-1", {
    method: "PATCH",
    headers: { Authorization: "Bearer player-token", "Content-Type": "application/json" },
    body: JSON.stringify({ quantityAdult: 0, quantityChild: 0, quantityInfant: 0 }),
  });
  const mock = createDbMock(makePlayerSession(6));
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.data.status, "cancelled");
});

test("PATCH /api/applications/:id returns 403 when player_id does not match (IDOR prevention)", async () => {
  const app = createApp({ now: () => "2026-06-13T00:00:00.000Z" });
  const request = new Request("https://example.com/api/applications/APP-999", {
    method: "PATCH",
    headers: { Authorization: "Bearer player-token", "Content-Type": "application/json" },
    body: JSON.stringify({ quantityAdult: 1 }),
  });
  // セッションは player_id=6 だが、申込の player_id は 99（他人）
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("INNER JOIN players")) {
        return { token: "player-token", player_id: 6, expires_at: "2099-06-13T06:00:00.000Z", player_no: "6", name: "#6" };
      }
      if (sql.includes("INNER JOIN games")) {
        return { player_id: 99, deadline: "2099-10-01" };  // 他人の申込
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 403);
});

test("PATCH /api/applications/:id returns 403 after deadline (player cannot change)", async () => {
  const app = createApp({ now: () => "2026-06-13T10:00:00.000Z" });  // UTC 10:00
  const request = new Request("https://example.com/api/applications/APP-1", {
    method: "PATCH",
    headers: { Authorization: "Bearer player-token", "Content-Type": "application/json" },
    body: JSON.stringify({ quantityAdult: 1 }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("INNER JOIN players")) {
        return { token: "player-token", player_id: 6, expires_at: "2099-06-13T06:00:00.000Z", player_no: "6", name: "#6" };
      }
      if (sql.includes("INNER JOIN games")) {
        // deadline=2026-06-13 → 締切 = 2026-06-13T03:00:00Z、now=10:00Z なので過ぎている
        return { player_id: 6, deadline: "2026-06-13" };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 403);
  const json = await response.json();
  assert.equal(json.error.code, "DEADLINE_PASSED");
});

test("PUT /api/admin/applications/:id admin can update quantity after deadline", async () => {
  const app = createApp({ now: () => "2026-06-13T10:00:00.000Z" });
  const request = new Request("https://example.com/api/admin/applications/APP-1", {
    method: "PUT",
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: JSON.stringify({ quantityAdult: 3, quantityChild: 1, quantityInfant: 0 }),
  });
  const mock = createDbMock({
    first(sql) {
      if (sql.includes("FROM admin_sessions")) {
        return { token: "admin-token", admin_role: "ticket", expires_at: "2099-06-13T06:00:00.000Z" };
      }
      if (sql.includes("FROM applications WHERE app_id")) {
        return { app_id: "APP-1", player_id: 6 };
      }
      return null;
    },
  });
  const env = { DB: mock.DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.data.quantityAdult, 3);
  assert.equal(json.data.quantityChild, 1);
  assert.equal(json.data.status, "pending");
});

test("PUT /api/admin/applications/:id requires admin session", async () => {
  const app = createApp({ now: () => "2026-06-13T00:00:00.000Z" });
  const request = new Request("https://example.com/api/admin/applications/APP-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantityAdult: 1 }),
  });
  const { DB } = createDbMock();
  const env = { DB, ALLOWED_ORIGIN: "http://127.0.0.1:8787" };

  const response = await app.fetch(request, env, {});
  assert.equal(response.status, 401);
});
