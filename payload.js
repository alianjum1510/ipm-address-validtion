// Payload/token parsing for monday automations and webhooks.
// Carried over from prev_version/address-validation-app/index.js, which already handles the
// different shapes monday Code, integration recipes and webhooks send.

const { safeJsonParse } = require("./monday");

function normalizeId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function firstId(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (Array.isArray(v)) {
    const first = v.find(x => x !== undefined && x !== null && x !== "");
    if (first === undefined) return undefined;
    return typeof first === "object" ? first.id ?? undefined : first;
  }
  if (typeof v === "object") return v.id ?? undefined;
  return v;
}

function payloadSources(payload) {
  const parsed = safeJsonParse(payload?.payload) ||
    (payload?.payload && typeof payload.payload === "object" ? payload.payload : {});
  return [
    payload || {},
    payload?.event || {},
    payload?.inputFields || {},
    payload?.inboundFieldValues || {},
    parsed || {},
    payload?.body || {}
  ];
}

function findKey(src, keys) {
  if (!src || typeof src !== "object") return undefined;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const found = firstId(src[k]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function extractIdsFromPayload(payload) {
  const boardKeys = ["boardId", "board_id", "board", "boardID", "boardid", "boardIds", "board_ids"];
  const itemKeys = ["itemId", "item_id", "pulseId", "pulse_id", "pulse", "item", "itemID", "itemid",
    "pulseIds", "pulse_ids", "itemIds", "item_ids"];

  let boardId;
  let itemId;
  for (const src of payloadSources(payload)) {
    if (boardId === undefined) boardId = findKey(src, boardKeys);
    if (itemId === undefined) itemId = findKey(src, itemKeys);
    if (boardId !== undefined && itemId !== undefined) break;
  }

  return { boardId: normalizeId(boardId), itemId: normalizeId(itemId) };
}

function extractChangedColumnIds(payload) {
  const columnKeys = ["columnId", "column_id", "column", "column_ids", "columnIdList"];
  const found = new Set();

  for (const src of payloadSources(payload)) {
    if (!src || typeof src !== "object") continue;
    for (const k of columnKeys) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const val = firstId(src[k]);
      if (val !== undefined) found.add(String(val));
    }
  }
  return [...found].filter(Boolean);
}

// Decode a JWT's payload without verifying it. monday wraps the usable API
// token (shortLivedToken) inside an outer JWT.
function decodeJwtPayload(jwt) {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function resolveApiToken(tokenString) {
  if (typeof tokenString !== "string" || !tokenString.trim()) return undefined;
  const raw = tokenString.replace(/^Bearer\s+/i, "").trim();
  const claims = decodeJwtPayload(raw);
  if (claims && typeof claims.shortLivedToken === "string" && claims.shortLivedToken.trim()) {
    return claims.shortLivedToken.trim();
  }
  return raw;
}

function findTokenInObject(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = ["shortLivedToken", "shortlivedtoken", "short_lived_token", "monday_api_token",
    "mondayApiToken", "sessionToken", "session_token", "token", "authorization", "Authorization"];
  for (const k of keys) {
    if (typeof obj[k] === "string" && obj[k].trim()) return resolveApiToken(obj[k]);
  }
  return undefined;
}

// Prefer MONDAY_API_TOKEN: a personal token has full account scopes, whereas the
// short-lived token monday sends only has the app's granted scopes.
function getToken(payload, context) {
  if (process.env.MONDAY_API_TOKEN && process.env.MONDAY_API_TOKEN.trim()) {
    return resolveApiToken(process.env.MONDAY_API_TOKEN);
  }
  return (
    findTokenInObject(context) ||
    findTokenInObject(context?.payload) ||
    findTokenInObject(payload) ||
    findTokenInObject(payload?.inputFields) ||
    findTokenInObject(payload?.payload)
  );
}

function normalizeActionPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const parsedPayload = safeJsonParse(payload.payload);
  const parsedBody = safeJsonParse(payload.body);
  const nestedPayload = (parsedPayload && typeof parsedPayload === "object") ? parsedPayload
    : (payload.payload && typeof payload.payload === "object" ? payload.payload : null);
  const nestedBody = (parsedBody && typeof parsedBody === "object") ? parsedBody
    : (payload.body && typeof payload.body === "object" ? payload.body : null);

  if (!nestedPayload && !nestedBody) return payload;
  return {
    ...payload,
    ...(nestedPayload || {}),
    payload: nestedPayload || payload.payload,
    body: nestedBody || payload.body
  };
}

function looksLikePayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  return ["inboundFieldValues", "inputFields", "payload", "event", "itemId", "pulseId", "boardId",
    "columnId", "challenge"].some(k => Object.prototype.hasOwnProperty.call(obj, k));
}

// monday Code calls action(payload, context); the HTTP server calls
// action(context, payload). Work out which is which by content.
function resolveActionArgs(argA = {}, argB = {}) {
  const a = argA || {};
  const b = argB || {};

  if (looksLikePayload(a) && !looksLikePayload(b)) return { context: b, payload: a };
  if (looksLikePayload(b) && !looksLikePayload(a)) return { context: a, payload: b };
  if (a.payload && typeof a.payload === "object") return { context: a, payload: a.payload };
  if (b.payload && typeof b.payload === "object") return { context: b, payload: b.payload };
  if (Object.keys(b).length > 0) return { context: a, payload: b };
  return { context: b, payload: a };
}

module.exports = {
  extractIdsFromPayload,
  extractChangedColumnIds,
  getToken,
  normalizeActionPayload,
  resolveActionArgs,
  normalizeId
};
