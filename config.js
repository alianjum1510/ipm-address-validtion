// Per-board column IDs and status labels. monday regenerates column IDs when a
// board is duplicated, so each board needs its own mapping.
const BOARDS = {
  // Address Master Board (original)
  "5063711037": {
    columns: {
      full_address:   "text_mkw9pw3m",    // Vollständige Adresse (legal)  — TRIGGER (mode "address")
      address_line_1: "text_mkw9v8an",    // Adresszeile 1 (Legal)         — TRIGGER (mode "fields")
      postcode:       "text_mkxqtbr0",    // Postleitzahl (legal)          — TRIGGER (mode "fields")
      city:           "text_mkyw1a7a",    // Ort
      district:       "text_mkx4mpvc",    // Landkreis / Kreis (legal)
      state:          "text_mkx5m5c3",    // Bundesland (legal)
      country:        "text_mkywm44h",    // Land
      latitude:       "numeric_mkw9x7h5", // Breitengrad (legal)
      longitude:      "numeric_mkw94cck", // Längengrad (legal)
      location:       undefined,          // no location column on this board
      status:         "color_mm0851fj"    // Match Zipcode
    },
    labels: { done: "Done", stuck: "Stuck" }
  },
  // Address Master Board (replica)
  "5090777446": {
    columns: {
      full_address:   "text_mkzzbqtq",    // Vollständige Adresse          — TRIGGER (mode "address")
      address_line_1: "text_mkzzhve4",    // Adresszeile 1                 — TRIGGER (mode "fields")
      postcode:       "text_mkzzxn2",     // Postcode                      — TRIGGER (mode "fields")
      city:           "text_mkzza1ky",    // Ort
      district:       "text_mm00ck6x",    // Landkreis / Kreis
      state:          "text_mm00gat6",    // Bundesland
      country:        "text_mm002s0c",    // Land
      latitude:       "text_mm00sfst",    // Breitengrad
      longitude:      "text_mm00m1qf",    // Längengrad
      location:       "location_mm4s5wm1",
      status:         "color_mm00ymfp"    // Address Check
    },
    labels: { done: "Complete", stuck: "Stuck" }
  }
};

// Board used when an item's board isn't in the map.
const DEFAULT_BOARD_ID = process.env.DEFAULT_BOARD_ID || "5063711037";

function getBoardConfig(boardId) {
  return BOARDS[String(boardId)] || BOARDS[DEFAULT_BOARD_ID];
}

// Column IDs are globally unique in monday, so these lists can span boards.
const ADDRESS_TRIGGER_IDS = Object.values(BOARDS).map(b => b.columns.full_address);
const FIELD_TRIGGER_IDS = Object.values(BOARDS)
  .flatMap(b => [b.columns.address_line_1, b.columns.postcode]);

// Fields that must be filled for the status to be Done/Complete.
const REQUIRED_FIELDS = [
  { key: "address_line_1", label: "Adresszeile 1" },
  { key: "postcode",       label: "Postcode" },
  { key: "city",           label: "Ort" },
  { key: "country",        label: "Land" }
];

module.exports = {
  BOARDS,
  getBoardConfig,
  ADDRESS_TRIGGER_IDS,
  FIELD_TRIGGER_IDS,
  REQUIRED_FIELDS
};
