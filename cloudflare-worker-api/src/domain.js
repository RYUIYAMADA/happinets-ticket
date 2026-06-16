import { HttpError } from "./http.js";

const VALID_STATUSES = ["pending", "confirmed", "rejected", "cancelled"];
const VALID_CATEGORIES = ["invite", "family", "paid"];
const VALID_DAYS = ["月", "火", "水", "木", "金", "土", "日"];

export function normalizePlayerNo(playerId) {
  const normalized = String(parseInt(String(playerId), 10));
  return normalized === "NaN" ? "" : normalized;
}

export function formatPlayerNo(playerNo) {
  return String(playerNo).padStart(3, "0");
}

/**
 * 締切判定基準: 締切日の 12:00 JST (= UTC 03:00)
 * deadline カラムは 'YYYY-MM-DD' 形式。締切時刻は一律 12:00 JST 固定。
 */
export function deadlineAt(deadlineDate) {
  // 締切日の 12:00 JST = UTC 03:00 = deadlineDate T03:00:00Z
  if (!deadlineDate) return null;
  return `${deadlineDate}T03:00:00.000Z`;
}

export function mapGameRow(row, nowIso) {
  const dl = row.deadline ? deadlineAt(row.deadline) : null;
  return {
    gameId: row.game_no,
    gameNo: row.game_no,
    date: row.date,
    dayOfWeek: row.day_of_week,
    tipoff: row.tipoff ?? null,
    opponent: row.opponent,
    deadline: row.deadline ?? null,
    isDeadlinePassed: Boolean(dl && dl < nowIso),
    season: row.season,
    isActive: row.is_active === 1,
  };
}

export function buildGameLabel(row) {
  const [, , month = "", day = ""] = String(row.game_date || row.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return `${Number(month)}月${Number(day)}日（${row.game_day_of_week || row.day_of_week}）vs ${row.opponent}`;
}

export function mapApplicationRow(row) {
  const receivers = parseReceivers(row.receivers);
  return {
    applicationId: row.app_id,
    playerId: normalizePlayerNo(row.player_no),
    playerNo: formatPlayerNo(row.player_no),
    playerName: row.player_name,
    gameId: row.game_no,
    gameLabel: buildGameLabel(row),
    category: row.category,
    ticketType: row.category,
    applicantName: row.applicant_name || "",
    quantityAdult: row.quantity_adult,
    quantityChild: row.quantity_child,
    quantityInfant: row.quantity_infant,
    seatType: row.seat_type,
    seatRequest: row.seat_request,
    receiverName: receivers[0]?.name || row.applicant_name || "",
    receivers,
    pickupMethod: row.pickup_method,
    paymentMethod: row.payment_method,
    parkingCount: row.parking,
    note: row.note,
    status: row.status,
    lang: row.lang,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapPlayerRow(row) {
  return {
    playerId: normalizePlayerNo(row.player_no),
    playerNo: formatPlayerNo(row.player_no),
    name: row.name,
    nameEn: row.name_en,
    lineLinked: Boolean(row.line_user_id),
    isActive: row.is_active === 1,
  };
}

export function parseApplicationInput(body, nowIso) {
  const category = body?.category || body?.ticketType;
  if (!VALID_CATEGORIES.includes(category)) {
    throw new HttpError(400, "BAD_REQUEST", "category is invalid");
  }
  if (!body?.gameId) {
    throw new HttpError(400, "BAD_REQUEST", "gameId is required");
  }
  const quantityAdult = toInt(body.quantityAdult, 0);
  const quantityChild = toInt(body.quantityChild, 0);
  const quantityInfant = toInt(body.quantityInfant, 0);
  const parkingCount = toInt(body.parkingCount, 0);
  if ([quantityAdult, quantityChild, quantityInfant, parkingCount].some((value) => value < 0 || value > 10)) {
    throw new HttpError(400, "BAD_REQUEST", "quantity is invalid");
  }
  const receiverName = String(body.receiverName || "");
  if (!receiverName) {
    throw new HttpError(400, "BAD_REQUEST", "receiverName is required");
  }
  return {
    gameId: String(body.gameId),
    category,
    quantityAdult,
    quantityChild,
    quantityInfant,
    seatType: String(body.seatType || ""),
    seatRequest: String(body.seatRequest || ""),
    receiverName,
    pickupMethod: String(body.pickupMethod || ""),
    paymentMethod: String(body.paymentMethod || ""),
    parkingCount,
    note: String(body.note || ""),
    lang: body?.lang === "en" ? "en" : "ja",
    source: body?.source === "line" ? "line" : "web",
    createdAt: nowIso,
  };
}

export function parseStatusInput(body) {
  const status = body?.status;
  if (!VALID_STATUSES.includes(status)) {
    throw new HttpError(422, "INVALID_STATUS", "Invalid status");
  }
  return status;
}

export function parsePlayerInput(body, playerNoFromPath) {
  const normalized = normalizePlayerNo(playerNoFromPath ?? body?.playerId);
  if (!normalized) {
    throw new HttpError(400, "BAD_REQUEST", "playerId is required");
  }
  if (!body?.name && playerNoFromPath === undefined) {
    throw new HttpError(400, "BAD_REQUEST", "name is required");
  }
  return {
    playerNo: normalized,
    name: body?.name,
    nameEn: body?.nameEn,
    lineUserId: body?.lineUserId,
    isActive: body?.isActive,
  };
}

/**
 * 枚数絶対値パース（利用者 PATCH / 管理者 PUT 共通）。
 * 各値は 0〜10 の整数のみ許可。
 */
export function parseQuantityInput(body) {
  const quantityAdult = toInt(body?.quantityAdult, null);
  const quantityChild = toInt(body?.quantityChild, null);
  const quantityInfant = toInt(body?.quantityInfant, null);

  if (quantityAdult === null && quantityChild === null && quantityInfant === null) {
    throw new HttpError(400, "BAD_REQUEST", "at least one of quantityAdult/quantityChild/quantityInfant is required");
  }

  const qA = quantityAdult ?? 0;
  const qC = quantityChild ?? 0;
  const qI = quantityInfant ?? 0;

  if ([qA, qC, qI].some((v) => v < 0 || v > 10 || !Number.isInteger(v))) {
    throw new HttpError(400, "BAD_REQUEST", "quantity values must be integers between 0 and 10");
  }

  return { quantityAdult: qA, quantityChild: qC, quantityInfant: qI };
}

export function parseGameInput(body, gameNoFromPath) {
  const gameNo = gameNoFromPath || body?.gameNo;
  const parsed = {
    gameNo: gameNo ? String(gameNo) : "",
    date: body?.date,
    dayOfWeek: body?.dayOfWeek,
    tipoff: body?.tipoff ?? null,
    opponent: body?.opponent,
    deadline: body?.deadline ?? null,
    season: body?.season || "2026-27",
    isActive: body?.isActive,
  };
  if (!gameNoFromPath && (!parsed.date || !parsed.opponent)) {
    throw new HttpError(400, "BAD_REQUEST", "date and opponent are required");
  }
  if (parsed.dayOfWeek && !VALID_DAYS.includes(parsed.dayOfWeek)) {
    throw new HttpError(400, "BAD_REQUEST", "dayOfWeek is invalid");
  }
  return parsed;
}

export function deriveDeadline(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 7);
  return value.toISOString().slice(0, 10);
}

export function deriveDayOfWeek(date) {
  const value = new Date(`${date}T00:00:00Z`);
  return VALID_DAYS[(value.getUTCDay() + 6) % 7];
}

function parseReceivers(receivers) {
  try {
    const parsed = JSON.parse(receivers || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
