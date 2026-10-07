// End-to-end tests with monday and HERE stubbed via global fetch.
// Run: node --test test/
const test = require("node:test");
const assert = require("node:assert");

process.env.MONDAY_API_TOKEN = "test-token";
process.env.HERE_API_KEY = "test-key";

const app = require("../index");
const here = require("../here");
const { BOARDS } = require("../config");

const BOARD_ID = "5090777446";
const C = BOARDS[BOARD_ID].columns;

const HERE_BORSIG = {
  title: "Borsigstraße 15, 51381 Leverkusen, Deutschland",
  resultType: "houseNumber",
  houseNumberType: "PA",
  address: {
    label: "Borsigstraße 15, 51381 Leverkusen, Deutschland",
    countryCode: "DEU", countryName: "Deutschland",
    state: "Nordrhein-Westfalen", county: "Leverkusen", city: "Leverkusen",
    street: "Borsigstraße", postalCode: "51381", houseNumber: "15"
  },
  position: { lat: 51.0456789, lng: 7.0123456 },
  scoring: { queryScore: 1 }
};

// ---------- fake monday board + HERE ----------
let item;
let mutations;
let hereQueries;

function newItem(values) {
  item = {
    id: "111",
    name: "Test",
    board: { id: BOARD_ID },
    column_values: Object.values(C).filter(Boolean).map(id => ({ id, text: values[id] || "", value: null, type: "text" }))
  };
  mutations = [];
  hereQueries = [];
  app._recentWrites.clear();
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://geocode.search.hereapi.com")) {
    const params = new URL(u).searchParams;
    hereQueries.push({ q: params.get("q"), in: params.get("in") });
    const items = /borsig/i.test(params.get("q")) ? [HERE_BORSIG] : [];
    return { ok: true, status: 200, json: async () => ({ items }) };
  }
  if (u === "https://api.monday.com/v2") {
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes("change_multiple_column_values")) {
      const values = JSON.parse(variables.values);
      mutations.push(values);
      for (const [id, v] of Object.entries(values)) {
        const col = item.column_values.find(c => c.id === id);
        col.text = typeof v === "string" ? v : v.label || v.address || "";
      }
      return { ok: true, status: 200, json: async () => ({ data: { change_multiple_column_values: { id: item.id } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { items: [structuredClone(item)] } }) };
  }
  throw new Error(`unexpected fetch ${u}`);
};

const event = columnId => ({ event: { pulseId: Number(item.id), boardId: Number(BOARD_ID), columnId } });
const text = id => item.column_values.find(c => c.id === id).text;

// ---------- parsing (same cases as here.py) ----------

test("parseFullAddress handles the client sheet format like here.py", () => {
  assert.deepStrictEqual(
    here.parseFullAddress("Boschstraat 10, 6442, Pb Brunssum, Brunssum, Limburg, Niederlande"),
    { query: "Boschstraat 10, 6442 PB Brunssum", postcode: "6442 PB", cc: "NLD" });
  assert.deepStrictEqual(
    here.parseFullAddress("Urmonderbaan, 22, 6167, Rd Sittard-Geleen, Sittard-Geleen, Limburg, Niederlande"),
    { query: "Urmonderbaan 22, 6167 RD Sittard-Geleen", postcode: "6167 RD", cc: "NLD" });
  assert.deepStrictEqual(
    here.parseFullAddress("Borsigstraße 15, 51381, Leverkusen, Leverkusen, North Rhine-Westphalia, Deutschland"),
    { query: "Borsigstraße 15, 51381 Leverkusen", postcode: "51381", cc: "DEU" });
});

test("parseFullAddress falls back to free text for other formats", () => {
  assert.deepStrictEqual(
    here.parseFullAddress("Borsigstraße 15, 51381 Leverkusen, Deutschland"),
    { query: "Borsigstraße 15, 51381 Leverkusen, Deutschland", postcode: "", cc: "DEU" });
});

test("postcodesMatch", () => {
  assert.ok(here.postcodesMatch("51381", "51381"));
  assert.ok(here.postcodesMatch("6442 pb", "6442PB"));
  assert.ok(here.postcodesMatch("6442", "6442 PB"));
  assert.ok(!here.postcodesMatch("5138", "51381"));
  assert.ok(!here.postcodesMatch("51380", "51381"));
});

test("mapHereItem maps like here.py (county→district, English state, 4-decimal coords)", () => {
  const m = here.mapHereItem(HERE_BORSIG);
  assert.strictEqual(m.address_line_1, "Borsigstraße 15");
  assert.strictEqual(m.district, "Leverkusen");
  assert.strictEqual(m.state, "North Rhine-Westphalia");
  assert.strictEqual(m.country, "Deutschland");
  assert.strictEqual(m.latitude, "51.0457");
  assert.strictEqual(m.longitude, "7.0123");
});

// ---------- trigger flow ----------

test("Full Address entered → fills every field, leaves Full Address alone", async () => {
  newItem({ [C.full_address]: "Borsigstraße 15, 51381 Leverkusen, Deutschland" });
  const r = await app.action(event(C.full_address), {});

  assert.strictEqual(r.mode, "address");
  assert.strictEqual(r.isComplete, true);
  assert.strictEqual(text(C.address_line_1), "Borsigstraße 15");
  assert.strictEqual(text(C.postcode), "51381");
  assert.strictEqual(text(C.city), "Leverkusen");
  assert.strictEqual(text(C.state), "North Rhine-Westphalia");
  assert.strictEqual(text(C.latitude), "51.0457");
  assert.strictEqual(text(C.status), "Complete");
  assert.strictEqual(text(C.full_address), "Borsigstraße 15, 51381 Leverkusen, Deutschland");
  assert.ok(!(C.full_address in mutations[0]));
  assert.ok(C.location in mutations[0]);
});

test("the app's own writes to Address Line 1 / Postcode don't re-trigger it", async () => {
  newItem({ [C.full_address]: "Borsigstraße 15, 51381 Leverkusen, Deutschland" });
  await app.action(event(C.full_address), {});
  const before = hereQueries.length;

  const r1 = await app.action(event(C.address_line_1), {});
  const r2 = await app.action(event(C.postcode), {});
  assert.strictEqual(r1.skipped, true);
  assert.strictEqual(r2.skipped, true);
  assert.strictEqual(hereQueries.length, before); // no extra HERE calls
});

test("loop still stops if the app restarted between runs (diff-only writes)", async () => {
  newItem({ [C.full_address]: "Borsigstraße 15, 51381 Leverkusen, Deutschland" });
  await app.action(event(C.full_address), {});

  app._recentWrites.clear(); // simulate restart: echo arrives at a fresh instance
  const r1 = await app.action(event(C.address_line_1), {});
  assert.strictEqual(r1.mode, "fields");
  assert.deepStrictEqual(r1.written, [C.full_address, C.location]); // only Full Address (+ pin) gets normalised

  app._recentWrites.clear();
  const r2 = await app.action(event(C.full_address), {});
  assert.strictEqual(r2.mode, "address");
  assert.deepStrictEqual(r2.written, []); // nothing changed → no write → no further trigger
});

test("Address Line 1 / Postcode edited → refreshes other fields + Full Address, not the inputs", async () => {
  newItem({ [C.address_line_1]: "Borsigstr. 15", [C.postcode]: "51381", [C.country]: "Deutschland" });
  const r = await app.action(event(C.postcode), {});

  assert.strictEqual(r.mode, "fields");
  assert.strictEqual(r.isComplete, true);
  assert.deepStrictEqual(hereQueries.at(-1), { q: "Borsigstr. 15, 51381", in: "countryCode:DEU" });
  assert.strictEqual(text(C.address_line_1), "Borsigstr. 15"); // user's input kept
  assert.strictEqual(text(C.city), "Leverkusen");
  assert.strictEqual(text(C.full_address), "Borsigstraße 15, 51381, Leverkusen, Leverkusen, North Rhine-Westphalia, Deutschland");
  assert.strictEqual(text(C.status), "Complete");
});

test("postcode that HERE disagrees with → Stuck, nothing else overwritten", async () => {
  newItem({ [C.address_line_1]: "Borsigstraße 15", [C.postcode]: "99999", [C.city]: "Old City" });
  const r = await app.action(event(C.postcode), {});

  assert.strictEqual(r.isComplete, false);
  assert.match(r.reason, /Postcode mismatch/);
  assert.strictEqual(text(C.city), "Old City");
  assert.strictEqual(text(C.status), "Stuck");
  assert.deepStrictEqual(Object.keys(mutations[0]), [C.status]);
});

test("only one of Address Line 1 / Postcode filled → Stuck without calling HERE", async () => {
  newItem({ [C.address_line_1]: "Borsigstraße 15" });
  const r = await app.action(event(C.address_line_1), {});
  assert.strictEqual(r.isComplete, false);
  assert.strictEqual(text(C.status), "Stuck");
  assert.strictEqual(hereQueries.length, 0);
});

test("HERE finds nothing → Stuck", async () => {
  newItem({ [C.full_address]: "asdfgh qwerty" });
  const r = await app.action(event(C.full_address), {});
  assert.match(r.reason, /no match/);
  assert.strictEqual(text(C.status), "Stuck");
});

test("non-trigger column → skipped before any API call", async () => {
  newItem({});
  const r = await app.action(event(C.city), {});
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(mutations.length, 0);
});

test("no column ID in the event (item created) → uses Full Address when the fields are empty", async () => {
  newItem({ [C.full_address]: "Borsigstraße 15, 51381 Leverkusen, Deutschland" });
  const r = await app.action({ event: { pulseId: 111, boardId: Number(BOARD_ID) } }, {});
  assert.strictEqual(r.mode, "address");
  assert.strictEqual(text(C.postcode), "51381");
});
