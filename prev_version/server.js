// ===============================
// MONDAY ADDRESS VALIDATION APP
// ===============================

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===============================
// 🔧 CONFIG (EDIT THESE)
// ===============================
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const BOARD_ID = Number(process.env.BOARD_ID || 5094616802);

// Column IDs (NOT titles) from Monday
const COLUMN_IDS = {
  house: "text_mm2dtvgh",
  street: "text_mm2dheb2",
  district: "text_mm2dn7pz",
  city: "text_mm2dnddg",
  state: "text_mm2dpdbv",
  postal_code: "text_mm2dqnjq",
  country: "text_mm2dzznp",
  status: "color_mm2dv4wa",
  notes: "text_mm2dv41w"
};

// ===============================
// 📥 FETCH ITEM DATA
// ===============================
async function getItemData(itemId) {
  const query = `
    query {
      items(ids: ${itemId}) {
        column_values {
          id
          text
        }
      }
    }
  `;

  const res = await axios.post(
    "https://api.monday.com/v2",
    { query },
    {
      headers: {
        Authorization: MONDAY_API_TOKEN
      }
    }
  );

  return res.data.data.items[0].column_values;
}

// ===============================
// 🔄 MAP DATA
// ===============================
function mapAddress(columns) {
  const data = {};

  columns.forEach(col => {
    data[col.id] = col.text;
  });

  return {
    house: data[COLUMN_IDS.house],
    street: data[COLUMN_IDS.street],
    district: data[COLUMN_IDS.district],
    city: data[COLUMN_IDS.city],
    state: data[COLUMN_IDS.state],
    postal_code: data[COLUMN_IDS.postal_code],
    country: data[COLUMN_IDS.country]
  };
}

// ===============================
// ✅ VALIDATE
// ===============================
const REQUIRED_FIELDS = [
  "house",
  "street",
  "district",
  "city",
  "state",
  "postal_code",
  "country"
];

function validate(address) {
  const missing = REQUIRED_FIELDS.filter(
    field => !address[field] || address[field].trim() === ""
  );

  return {
    isValid: missing.length === 0,
    missing
  };
}

function extractChangedColumnIds(body) {
  const event = body.event || {};

  const changedValues = [
    body.columnId,
    body.column_id,
    event.columnId,
    event.column_id,
    event.column && event.column.id
  ].filter(Boolean);

  return [...new Set(changedValues.map(String))];
}

function shouldSkipAutomation(body) {
  const changedColumnIds = extractChangedColumnIds(body);

  if (changedColumnIds.length === 0) {
    return false;
  }

  return changedColumnIds.every(
    columnId => columnId === COLUMN_IDS.status || columnId === COLUMN_IDS.notes
  );
}

// ===============================
// 📝 UPDATE MONDAY ITEM
// ===============================
async function updateItem(itemId, result) {
  const statusLabel = result.isValid ? "Valid" : "Invalid";

  const notesText = result.isValid
    ? "All address fields are complete"
    : `Missing: ${result.missing.join(", ")}`;

  const columnValues = {
    [COLUMN_IDS.status]: { label: statusLabel },
    [COLUMN_IDS.notes]: notesText
  };

  const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${itemId},
        board_id: ${BOARD_ID},
        column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}"
      ) {
        id
      }
    }
  `;

  await axios.post(
    "https://api.monday.com/v2",
    { query: mutation },
    {
      headers: {
        Authorization: MONDAY_API_TOKEN
      }
    }
  );
}

// ===============================
// 🌐 WEBHOOK ENDPOINT
// ===============================
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.event;

    // Monday URL verification challenge
    if (req.body.challenge) {
      return res.json({ challenge: req.body.challenge });
    }

    if (shouldSkipAutomation(req.body)) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "Ignored status/notes update to avoid automation loops."
      });
    }

    console.log(JSON.stringify(req.body, null, 2));

    const itemId = event.pulseId;

    console.log("Triggered for item:", itemId);

    // 1. Fetch full item data
    const columns = await getItemData(itemId);

    // 2. Map address
    const address = mapAddress(columns);

    console.log("Address:", address);

    // 3. Validate
    const result = validate(address);

    console.log("Validation:", result);

    // 4. Update item
    await updateItem(itemId, result);

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err.message);
    res.sendStatus(500);
  }
});

// ===============================
// 🚀 START SERVER
// ===============================
const PORT = 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
