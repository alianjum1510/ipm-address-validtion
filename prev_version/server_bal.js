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
const BOARD_ID = Number(process.env.BOARD_ID || 5063711037);

// Column IDs (NOT titles) from Monday
const COLUMN_IDS = {
  address_line_1: "text_mkw9v8an",
  postcode: "text_mkxqtbr0",
  city: "text_mkyw1a7a",
  state: "text_mkx5m5c3",
  country: "text_mkywm44h",
  district: "text_mkx4mpvc",
  long: "numeric_mkw94cck",
  lang: "numeric_mkw9x7h5",
  status: "color_mkx41hj2"
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
    address_line_1: data[COLUMN_IDS.address_line_1],
    postcode: data[COLUMN_IDS.postcode],
    district: data[COLUMN_IDS.district],
    city: data[COLUMN_IDS.city],
    state: data[COLUMN_IDS.state],
    long: data[COLUMN_IDS.long],
    lang: data[COLUMN_IDS.lang],
    country: data[COLUMN_IDS.country]
  };
}

// ===============================
// ✅ VALIDATE
// ===============================
const REQUIRED_FIELDS = [
  "address_line_1",
  "postcode",
  "district",
  "city",
  "state",
  "long",
  "lang",
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

// ===============================
// 📝 UPDATE MONDAY ITEM
// ===============================
async function updateItem(itemId, result) {
  const statusLabel = result.isValid ? "Complete" : "Check Address";

  const columnValues = {
    [COLUMN_IDS.status]: { label: statusLabel },
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