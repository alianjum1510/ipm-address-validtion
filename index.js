const http = require("http");
const fs = require("fs");
const path = require("path");

loadLocalEnv();

const { getBoardConfig, ADDRESS_TRIGGER_IDS, FIELD_TRIGGER_IDS, REQUIRED_FIELDS } = require("./config");
const here = require("./here");
const { getItemData, updateItem, getColumnValue, makeLocationValue } = require("./monday");
const {
  extractIdsFromPayload,
  extractChangedColumnIds,
  getToken,
  normalizeActionPayload,
  resolveActionArgs,
  normalizeId
} = require("./payload");

const PORT = Number(process.env.PORT || 8080);

// Two run modes:
//   "address" — Full Address changed: geocode it and fill Address Line 1, Postcode
//               and every other field. Full Address itself is never overwritten.
//   "fields"  — Address Line 1 or Postcode changed: geocode those two, check HERE
//               agrees on the postcode, then refresh the other fields and Full
//               Address. Address Line 1 and Postcode themselves are never overwritten.
const ALL_TRIGGER_IDS = [...ADDRESS_TRIGGER_IDS, ...FIELD_TRIGGER_IDS];

// Output fields written in each mode (keys of the board's column map).
const ADDRESS_MODE_FIELDS = ["address_line_1", "postcode", "city", "district", "state", "country", "latitude", "longitude"];
const FIELDS_MODE_FIELDS = ["city", "district", "state", "country", "latitude", "longitude", "full_address"];

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

// ---------- loop guard ----------
// The app writes to trigger columns (mode "address" writes Address Line 1 and
// Postcode; mode "fields" writes Full Address), and monday fires the automation
// again for those writes. monday's action block doesn't say which column changed,
// so after each write we remember the item's trigger-column values and ignore an
// event when none of them has changed since. Writes are also diff-only, so even if
// this memory is lost (restart, second instance) the echo run finds nothing to
// change and the chain stops.
const SELF_WRITE_TTL_MS = 2 * 60 * 1000;
const recentWrites = new Map(); // itemId -> { values: { columnId: value }, at }

function triggerColumns(cols) {
  return [cols.full_address, cols.address_line_1, cols.postcode].filter(Boolean);
}

function rememberWrites(item, cols, updates) {
  const values = {};
  for (const columnId of triggerColumns(cols)) {
    values[columnId] = typeof updates[columnId] === "string"
      ? updates[columnId]
      : getColumnValue(item.column_values, columnId);
  }
  recentWrites.set(String(item.id), { values, at: Date.now() });
}

function isEcho(item, cols) {
  const entry = recentWrites.get(String(item.id));
  if (!entry) return false;
  if (Date.now() - entry.at > SELF_WRITE_TTL_MS) {
    recentWrites.delete(String(item.id));
    return false;
  }
  return triggerColumns(cols).every(id => entry.values[id] === getColumnValue(item.column_values, id));
}

// ---------- helpers ----------

function getMissingFields(addr) {
  return REQUIRED_FIELDS
    .filter(field => !addr?.[field.key] || String(addr[field.key]).trim() === "")
    .map(field => field.label);
}

// Same order as the client sheet: street, postcode, city, district, state, country.
function composeFullAddress(addr) {
  return [addr.address_line_1, addr.postcode, addr.city, addr.district, addr.state, addr.country]
    .map(p => (p || "").trim())
    .filter(Boolean)
    .join(", ");
}

// Decide which mode this event is. Returns null to skip.
// forcedMode comes from the URL the automation block calls (/action/address or
// /action/fields), since monday's action block payload has no column ID.
function resolveMode(changedIds, item, cols, forcedMode) {
  if (forcedMode) return forcedMode;
  if (changedIds.includes(cols.full_address)) return "address";
  if (changedIds.includes(cols.address_line_1) || changedIds.includes(cols.postcode)) return "fields";
  if (changedIds.length > 0) return null; // a trigger column, but not on this item's board

  // No column ID and no mode in the URL (the existing /action block): go by what's filled.
  const hasFields = getColumnValue(item.column_values, cols.address_line_1) &&
    getColumnValue(item.column_values, cols.postcode);
  if (hasFields) return "fields";
  if (getColumnValue(item.column_values, cols.full_address)) return "address";
  return "fields"; // nothing filled — ends as Stuck with a clear reason
}

// Build a diff-only column update: unchanged values are left out.
function buildUpdates(item, board, addr, fieldKeys, isComplete) {
  const cols = board.columns;
  const updates = {};

  for (const key of fieldKeys) {
    const columnId = cols[key];
    const value = addr[key];
    if (!columnId || !value) continue;
    if (getColumnValue(item.column_values, columnId) === value) continue;
    updates[columnId] = value;
  }

  if (cols.location && Object.keys(updates).length > 0) {
    const location = makeLocationValue(addr, addr.label || composeFullAddress(addr));
    if (location) updates[cols.location] = location;
  }

  const label = isComplete ? board.labels.done : board.labels.stuck;
  if (getColumnValue(item.column_values, cols.status) !== label) {
    updates[cols.status] = { label };
  }

  return updates;
}

async function writeUpdates(item, boardId, board, updates, token) {
  if (Object.keys(updates).length === 0) return [];
  rememberWrites(item, board.columns, updates); // before the write: monday may fire the echo before we get the response
  await updateItem(boardId, item.id, updates, token);
  return Object.keys(updates);
}

async function markStuck(item, boardId, board, reason, mode, token) {
  console.log(`Item ${item.id} [${mode}]: Stuck — ${reason}`);
  const written = await writeUpdates(item, boardId, board, buildUpdates(item, board, {}, [], false), token);
  return { itemId: String(item.id), mode, isComplete: false, reason, written };
}

async function finish(item, boardId, board, addr, fieldKeys, mode, token) {
  const missing = getMissingFields(addr);
  const isComplete = missing.length === 0;
  const updates = buildUpdates(item, board, addr, fieldKeys, isComplete);
  const written = await writeUpdates(item, boardId, board, updates, token);

  console.log(
    `Item ${item.id} [${mode}]: ${isComplete ? "Complete" : `Stuck — missing: ${missing.join(", ")}`} ` +
    `(${addr.note}; ${written.length} column(s) written)`
  );
  return { itemId: String(item.id), mode, isComplete, missing, geo: addr, written };
}

// ---------- the two modes ----------

// Mode "address": Full Address → fill everything else.
async function processFromAddress(item, boardId, board, token) {
  const cols = board.columns;
  const fullAddress = getColumnValue(item.column_values, cols.full_address);
  if (!fullAddress) return markStuck(item, boardId, board, "Full Address is empty", "address", token);

  const parsed = here.parseFullAddress(fullAddress);
  console.log(`Item ${item.id} [address]: HERE query "${parsed.query}"${parsed.cc ? ` in ${parsed.cc}` : ""}`);

  const addr = await here.geocode(parsed.query, parsed.cc);
  if (!addr) return markStuck(item, boardId, board, `HERE found no match for "${fullAddress}"`, "address", token);

  if (parsed.postcode && !here.postcodesMatch(parsed.postcode, addr.postcode)) {
    return markStuck(item, boardId, board,
      `Postcode mismatch — Full Address has ${parsed.postcode} but HERE says ${addr.postcode || "none"} (${addr.label})`,
      "address", token);
  }

  return finish(item, boardId, board, addr, ADDRESS_MODE_FIELDS, "address", token);
}

// Mode "fields": Address Line 1 + Postcode → refresh everything else.
async function processFromFields(item, boardId, board, token) {
  const cols = board.columns;
  const addressLine1 = getColumnValue(item.column_values, cols.address_line_1);
  const postcode = getColumnValue(item.column_values, cols.postcode);

  if (!addressLine1 || !postcode) {
    return markStuck(item, boardId, board, "Address Line 1 or Postcode is empty", "fields", token);
  }

  // The current Land column (filled by an earlier run) narrows the search to that country.
  const cc = here.countryCodeFor(getColumnValue(item.column_values, cols.country));
  const query = `${addressLine1}, ${postcode}`;
  console.log(`Item ${item.id} [fields]: HERE query "${query}"${cc ? ` in ${cc}` : ""}`);

  const addr = await here.geocode(query, cc);
  if (!addr) return markStuck(item, boardId, board, `HERE found no match for "${query}"`, "fields", token);

  if (!here.postcodesMatch(postcode, addr.postcode)) {
    return markStuck(item, boardId, board,
      `Postcode mismatch — you entered ${postcode} but HERE says ${addr.postcode || "none"} (${addr.label})`,
      "fields", token);
  }

  addr.full_address = composeFullAddress(addr);
  return finish(item, boardId, board, addr, FIELDS_MODE_FIELDS, "fields", token);
}

// ---------- entry point ----------

// monday Code invokes action(payload, context); the local HTTP server invokes
// action(context, payload). resolveActionArgs works out which is which.
async function action(argA = {}, argB = {}) {
  const resolved = resolveActionArgs(argA, argB);
  const payload = normalizeActionPayload(resolved.payload);
  const token = getToken(payload, resolved.context);
  if (!token) {
    throw new Error("Missing monday API token. Set MONDAY_API_TOKEN or send a shortLivedToken.");
  }

  const changed = extractChangedColumnIds(payload);
  if (changed.length > 0 && !changed.some(id => ALL_TRIGGER_IDS.includes(id))) {
    return { success: true, skipped: true, reason: `Column ${changed.join(", ")} is not a trigger column.` };
  }

  const { boardId: rawBoardId, itemId } = extractIdsFromPayload(payload);
  if (!itemId) {
    return { success: false, skipped: true, reason: "No item ID in payload. Use an item-scoped trigger." };
  }

  const item = await getItemData(itemId, token);
  if (!item) throw new Error(`Item ${itemId} not found.`);

  const boardId = normalizeId(item.board?.id || rawBoardId);
  const board = getBoardConfig(boardId);

  const mode = resolveMode(changed, item, board.columns, resolved.context?.mode);
  if (!mode) {
    return { success: true, skipped: true, reason: `Column ${changed.join(", ")} does not belong to board ${boardId}.` };
  }

  if (isEcho(item, board.columns)) {
    console.log(`Item ${item.id} [${mode}]: ignoring — no address input changed since this app's last write.`);
    return { success: true, skipped: true, reason: "Change was written by this app." };
  }

  const result = mode === "address"
    ? await processFromAddress(item, boardId, board, token)
    : await processFromFields(item, boardId, board, token);

  return { success: true, boardId, ...result };
}

// ---------- HTTP server ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Each automation block calls its own URL:
//   .../action/address  → Full Address mode
//   .../action/fields   → Address Line 1 / Postcode mode
//   anything else       → auto (the existing ".../action" block)
function modeFromPath(url) {
  const pathname = String(url || "").split("?")[0].replace(/\/+$/, "");
  if (pathname.endsWith("/address")) return "address";
  if (pathname.endsWith("/fields")) return "fields";
  return undefined;
}

const server = http.createServer(async (req, res) => {
  // Health check on any GET — monday Code probes the root path.
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Accept the automation/webhook POST on any path.
  if (req.method === "POST") {
    try {
      const payload = await readBody(req);
      if (payload.challenge) {
        sendJson(res, 200, { challenge: payload.challenge });
        return;
      }
      const context = { token: req.headers.authorization || undefined, mode: modeFromPath(req.url) };
      console.log(`Incoming POST ${req.url} (mode: ${context.mode || "auto"})`);
      sendJson(res, 200, await action(context, payload));
    } catch (err) {
      console.error("Error:", err.message);
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { success: false, error: "Not found" });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`HERE Address Enrichment running on port ${PORT}`));
}

module.exports = {
  action,
  processFromAddress,
  processFromFields,
  resolveMode,
  modeFromPath,
  composeFullAddress,
  server,
  _recentWrites: recentWrites
};
