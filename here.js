// HERE Geocoding — a port of the here() provider in here.py.

const HERE_GEOCODE_URL = "https://geocode.search.hereapi.com/v1/geocode";

const COUNTRY_CODES = {
  "deutschland": "DEU", "germany": "DEU", "niederlande": "NLD", "netherlands": "NLD",
  "nederland": "NLD", "luxemburg": "LUX", "luxembourg": "LUX", "österreich": "AUT",
  "austria": "AUT", "schweiz": "CHE", "belgien": "BEL", "frankreich": "FRA"
};

// HERE returns German state names with lang=de; the client sheet uses these English ones.
const STATE_EN = {
  "Bayern": "Bavaria", "Sachsen": "Saxony", "Nordrhein-Westfalen": "North Rhine-Westphalia",
  "Niedersachsen": "Lower Saxony", "Hessen": "Hesse", "Rheinland-Pfalz": "Rhineland-Palatinate",
  "Sachsen-Anhalt": "Saxony-Anhalt", "Thüringen": "Thuringia",
  "Baden-Württemberg": "Baden-Württemberg", "Berlin": "Berlin", "Brandenburg": "Brandenburg",
  "Bremen": "Bremen", "Hamburg": "Hamburg", "Mecklenburg-Vorpommern": "Mecklenburg-Vorpommern",
  "Saarland": "Saarland", "Schleswig-Holstein": "Schleswig-Holstein"
};

// DE/AT/CH/BE/LU (4–5 digits) or NL ("6442" / "6442 PB").
const POSTCODE_RE = /^(\d{4,5}|\d{4}\s?[A-Za-z]{2})$/;

function countryCodeFor(countryName) {
  return COUNTRY_CODES[String(countryName || "").trim().toLowerCase()] || "";
}

function coord(v) {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? "" : n.toFixed(4);
}

// Turn a Full Address into a HERE query.
// The client sheet format 'street, [house], postcode, city, district, state, country'
// is parsed like here.py does, so HERE gets a clean 'street, postcode city' query.
// Anything else is sent to HERE as free text.
function parseFullAddress(text) {
  const raw = String(text || "").trim();
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  const cc = countryCodeFor(parts[parts.length - 1]);

  if (parts.length >= 6 && POSTCODE_RE.test(parts[parts.length - 5])) {
    let postcode = parts[parts.length - 5];
    let city = parts[parts.length - 4];
    const street = parts.slice(0, -5).join(" "); // 'Urmonderbaan, 22' -> 'Urmonderbaan 22'

    // Dutch postcode split: '6442' + 'Pb Brunssum' -> '6442 PB' + 'Brunssum'
    const m = city.match(/^([A-Za-z]{2})\s+(.+)$/);
    if (cc === "NLD" && /^\d{4}$/.test(postcode) && m) {
      postcode = `${postcode} ${m[1].toUpperCase()}`;
      city = m[2];
    }
    return { query: `${street}, ${postcode} ${city}`, postcode, cc };
  }

  return { query: raw, postcode: "", cc };
}

// Postcodes match when equal ignoring spaces/case. A Dutch 4-digit postcode also
// matches HERE's full form ('6442' vs '6442 PB').
function postcodesMatch(userPostcode, herePostcode) {
  const norm = s => String(s || "").replace(/\s+/g, "").toUpperCase();
  const u = norm(userPostcode);
  const h = norm(herePostcode);
  if (!u || !h) return false;
  return u === h || (/^\d{4}$/.test(u) && new RegExp(`^${u}[A-Z]{2}$`).test(h));
}

// Map a HERE result item to the board's fields (same mapping as here.py).
function mapHereItem(item) {
  const ad = item.address || {};
  const pos = item.position || {};
  return {
    address_line_1: [ad.street, ad.houseNumber].filter(Boolean).join(" "),
    postcode:  ad.postalCode || "",
    city:      ad.city || "",
    district:  ad.county || "",
    state:     STATE_EN[ad.state] || ad.state || "",
    country:   ad.countryName || "",
    latitude:  coord(pos.lat),
    longitude: coord(pos.lng),
    label:     ad.label || "",
    note:      `${item.resultType || ""} ${item.houseNumberType || ""}, score ${item.scoring?.queryScore ?? ""}`.trim()
  };
}

// Returns the mapped top result, or null when HERE finds nothing.
// Throws on HTTP errors (bad key, quota, outage) so they surface as real errors
// instead of being mistaken for a bad address.
async function geocode(query, countryCode) {
  if (!process.env.HERE_API_KEY) {
    throw new Error("Missing HERE API key. Set HERE_API_KEY env var.");
  }

  const params = new URLSearchParams({
    q: query,
    limit: "1",
    lang: "de",
    apiKey: process.env.HERE_API_KEY
  });
  if (countryCode) params.set("in", `countryCode:${countryCode}`);

  const res = await fetch(`${HERE_GEOCODE_URL}?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HERE API error: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const item = data.items?.[0];
  return item ? mapHereItem(item) : null;
}

module.exports = {
  geocode,
  parseFullAddress,
  postcodesMatch,
  mapHereItem,
  countryCodeFor
};
