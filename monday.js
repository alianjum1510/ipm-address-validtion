// monday GraphQL helpers.

async function mondayAPI(query, variables, token) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) {
    throw new Error(`monday API error (HTTP ${res.status}): ${JSON.stringify(data.errors || data)}`);
  }
  return data.data;
}

async function getItemData(itemId, token) {
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        board { id }
        column_values { id text value type }
      }
    }
  `;
  const data = await mondayAPI(query, { itemId: [String(itemId)] }, token);
  return data.items?.[0] || null;
}

async function updateItem(boardId, itemId, columnValues, token) {
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) {
        id
      }
    }
  `;
  return mondayAPI(mutation, {
    boardId: String(boardId),
    itemId:  String(itemId),
    values:  JSON.stringify(columnValues)
  }, token);
}

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function getColumnValue(columnValues, columnId) {
  if (!columnId) return "";
  const col = (columnValues || []).find(c => c.id === columnId);
  if (!col) return "";

  const text = (col.text || "").trim();
  if (text) return text;

  // Some column types leave `text` empty but expose the data in `value` as JSON.
  const parsed = safeJsonParse(col.value);
  if (parsed && typeof parsed === "object") {
    const candidate = parsed.text || parsed.value || parsed.label || parsed.name;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  return "";
}

// monday's location column accepts lat/lng/address plus object-typed
// country/city/street ({long_name, short_name}); plain strings are rejected.
function makeLocationValue(addr, address) {
  if (!addr || !addr.latitude || !addr.longitude) return undefined;

  const value = {
    lat: Number(addr.latitude),
    lng: Number(addr.longitude),
    address: address || ""
  };
  const component = name => (name ? { long_name: name, short_name: name } : undefined);
  if (addr.country) value.country = component(addr.country);
  if (addr.city) value.city = component(addr.city);
  if (addr.address_line_1) value.street = component(addr.address_line_1);
  return value;
}

module.exports = {
  getItemData,
  updateItem,
  getColumnValue,
  makeLocationValue,
  safeJsonParse
};
