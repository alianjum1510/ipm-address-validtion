const http = require("http");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

loadLocalEnv();

const PORT = Number(process.env.PORT || 8080);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// monday regenerates column IDs when a board is duplicated, so each board
// needs its own mapping even though the columns look identical. Keyed by board
// ID; processItem resolves the right set from the item's board.
const BOARD_COLUMN_IDS = {
  // Address Master Board (original) — board 5063711037.
  // IDs can still be overridden per-deploy via the COLUMN_* env vars.
  "5063711037": {
    full_address:   process.env.COLUMN_FULL_ADDRESS_ID   || "text_mkw9pw3m", // Vollständige Adresse (legal)
    address_line_1: process.env.COLUMN_ADDRESS_LINE_1_ID || "text_mkw9v8an", // Adresszeile 1 (Legal)
    address_line_2: process.env.COLUMN_ADDRESS_LINE_2_ID || "text_mkw9et45", // Adresszeile 2 (Legal)
    postcode:       process.env.COLUMN_POSTCODE_ID       || "text_mkxqtbr0", // Postleitzahl (legal)
    city:           process.env.COLUMN_CITY_ID           || "text_mkyw1a7a", // Ort
    district:       process.env.COLUMN_DISTRICT_ID       || "text_mkx4mpvc", // Landkreis / Kreis (legal)
    state:          process.env.COLUMN_STATE_ID          || "text_mkx5m5c3", // Bundesland (legal)
    country:        process.env.COLUMN_COUNTRY_ID        || "text_mkywm44h", // Land
    latitude:       process.env.COLUMN_LATITUDE_ID       || "numeric_mkw9x7h5", // Breitengrad (legal)
    longitude:      process.env.COLUMN_LONGITUDE_ID      || "numeric_mkw94cck", // Längengrad (legal)
    location:       process.env.COLUMN_LOCATION_ID       || undefined, // Location column (optional)
    kundennummer:   process.env.COLUMN_KUNDENNUMMER_ID   || "text_mkx4ry3t", // Kundennummer
    address_type:   process.env.COLUMN_ADDRESS_TYPE_ID   || "color_mkx41hj2", // Address Type
    status:         process.env.COLUMN_STATUS_ID         || "color_mm0851fj" // Match Zipcode
  },
  // Address Master Board (replica) — board 5090777446. Same columns, but
  // monday assigned fresh IDs on duplication. Lat/long are text columns here.
  "5090777446": {
    full_address:   "text_mkzzbqtq", // Vollständige Adresse
    address_line_1: "text_mkzzhve4", // Adresszeile 1
    address_line_2: "text_mkzz838b", // Adresszeile 2
    postcode:       "text_mkzzxn2",  // Postcode
    city:           "text_mkzza1ky", // Ort
    district:       "text_mm00ck6x", // Landkreis / Kreis
    state:          "text_mm00gat6", // Bundesland
    country:        "text_mm002s0c", // Land
    latitude:       "text_mm00sfst", // Breitengrad
    longitude:      "text_mm00m1qf", // Längengrad
    location:       "location_mm4s5wm1",
    kundennummer:   "text_mkzz90rs", // Kundennummer
    address_type:   "status",        // Address Type
    status:         "color_mm00ymfp" // Address Check
  }
};

// Board used when a payload's board isn't in the map (back-compat with the
// original single-board behaviour).
const DEFAULT_BOARD_ID = process.env.DEFAULT_BOARD_ID || "5063711037";

function getColumnIds(boardId) {
  return BOARD_COLUMN_IDS[String(boardId)] || BOARD_COLUMN_IDS[DEFAULT_BOARD_ID];
}

// Status labels also differ per board: the original uses "Done", the replica's
// status column uses "Complete". monday rejects a write of a label the column
// doesn't define, so each board maps to its own labels.
const BOARD_STATUS_LABELS = {
  "5063711037": {
    done:  process.env.DONE_STATUS_LABEL  || "Done",
    stuck: process.env.STUCK_STATUS_LABEL || "Stuck"
  },
  "5090777446": {
    done:  "Complete",
    stuck: "Stuck"
  }
};

function getStatusLabels(boardId) {
  return BOARD_STATUS_LABELS[String(boardId)] || BOARD_STATUS_LABELS[DEFAULT_BOARD_ID];
}

// Fields required for an item to count as "complete". Board-independent:
// these are keys on the resolved address object, not column IDs.
const REQUIRED_FIELDS = [
  { key: "address_line_1", label: "Adresszeile 1" },
  { key: "postcode",       label: "Postcode" },
  { key: "city",           label: "Ort" },
  { key: "country",        label: "Land" }
];

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getResponseText(responseData) {
  if (typeof responseData.output_text === "string") {
    return responseData.output_text;
  }

  for (const item of responseData.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return "";
}

function cleanAddressDetails(details) {
  return {
    address_line_1: String(details.address_line_1 || "").trim(),
    postcode:       String(details.postcode || "").trim(),
    city:           String(details.city || "").trim(),
    district:       String(details.district || "").trim(),
    state:          String(details.state || "").trim(),
    country:        String(details.country || "").trim(),
    latitude:       String(details.latitude || "").trim(),
    longitude:      String(details.longitude || "").trim()
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// POST to OpenAI, retrying on 429 (rate limit) with exponential backoff.
async function openaiPostWithRetry(url, body, config, maxAttempts = 4) {
  let attempt = 0;
  while (true) {
    try {
      return await axios.post(url, body, config);
    } catch (err) {
      const status = err.response?.status;
      attempt += 1;
      if (status !== 429 || attempt >= maxAttempts) throw err;

      // Honour Retry-After header if present, else exponential backoff.
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** (attempt - 1);
      console.log(`OpenAI 429 — retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

// Extract and verify structured address details using OpenAI.
async function extractAddressDetails(rawAddress) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY env var.");
  }

  const response = await openaiPostWithRetry("https://api.openai.com/v1/responses", {
    model: OPENAI_MODEL,
    instructions: [
      "You are an address verification and extraction assistant.",
      "Set address_exists to false ONLY if the input is clearly not an address at all (e.g. random words, numbers only, gibberish).",
      "Set address_exists to true for any input that contains recognisable address components such as a street, city, postcode, or country — even if some fields are missing.",
      "Extract every field you can confidently determine from the input. Return empty strings for fields you cannot determine.",
      "Provide latitude and longitude as decimal degree strings only when you are confident in the location. Otherwise leave them empty.",
      "Do not invent address components that are not present or clearly inferable."
    ].join(" "),
    input: rawAddress,
    text: {
      format: {
        type: "json_schema",
        name: "address_details",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            address_exists: { type: "boolean" },
            address_line_1: { type: "string" },
            postcode:       { type: "string" },
            city:           { type: "string" },
            district:       { type: "string" },
            state:          { type: "string" },
            country:        { type: "string" },
            latitude:       { type: "string" },
            longitude:      { type: "string" }
          },
          required: [
            "address_exists",
            "address_line_1",
            "postcode",
            "city",
            "district",
            "state",
            "country",
            "latitude",
            "longitude"
          ]
        }
      }
    }
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });

  const outputText = getResponseText(response.data);
  if (!outputText) return null;

  const parsed = JSON.parse(outputText);

  // If OpenAI determines the address does not exist, return null so fields stay empty
  if (!parsed.address_exists) return null;

  return cleanAddressDetails(parsed);
}

// Google Maps Geocoding API.
// Geocode the address WITHOUT the user's postcode so Google can't fuzzy-match
// the wrong combo to a real location. We then compare Google's authoritative
// postcode against the user's separately.
async function geocodeAddressWithGoogleMaps(addressLine1) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error("Missing Google Maps API key. Set GOOGLE_MAPS_API_KEY env var.");
  }

  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: addressLine1,
        key: process.env.GOOGLE_MAPS_API_KEY
      },
      timeout: 10000
    });

    if (response.data.status !== "OK" || !response.data.results || response.data.results.length === 0) {
      return {
        success: false,
        message: "Address not found on Google Maps"
      };
    }

    return {
      success: true,
      data: response.data.results[0]
    };
  } catch (err) {
    throw new Error(`Google Maps API error: ${err.message}`);
  }
}

// Extract postal code from Google Maps geocoding result
function extractPostcodeFromGoogleMapsResult(googleResult) {
  if (!googleResult || !googleResult.address_components) return null;

  const postcodeComponent = googleResult.address_components.find(component =>
    component.types && component.types.includes("postal_code")
  );

  return postcodeComponent ? postcodeComponent.long_name : null;
}

// Pull a Google address_components entry by type, returning long_name (or "").
function findComponent(components, type) {
  if (!Array.isArray(components)) return "";
  const match = components.find(c => Array.isArray(c.types) && c.types.includes(type));
  return match ? match.long_name : "";
}

// Build a structured address straight from Google's geocoding result.
// Lat/lng and the canonical formatted address always come from Google here.
function extractAddressFromGoogleResult(googleResult) {
  if (!googleResult) return null;
  const components = googleResult.address_components || [];

  const streetNumber = findComponent(components, "street_number");
  const route = findComponent(components, "route");
  const addressLine1 = [route, streetNumber].filter(Boolean).join(" ").trim();

  const city =
    findComponent(components, "locality") ||
    findComponent(components, "postal_town") ||
    findComponent(components, "sublocality") ||
    findComponent(components, "administrative_area_level_3");

  const district =
    findComponent(components, "administrative_area_level_2") ||
    findComponent(components, "administrative_area_level_3");

  const state = findComponent(components, "administrative_area_level_1");
  const country = findComponent(components, "country");
  const postcode = findComponent(components, "postal_code");

  const loc = googleResult.geometry && googleResult.geometry.location;
  const latitude = loc && typeof loc.lat === "number" ? String(loc.lat) : "";
  const longitude = loc && typeof loc.lng === "number" ? String(loc.lng) : "";

  return {
    address_line_1: addressLine1,
    postcode,
    city,
    district,
    state,
    country,
    latitude,
    longitude,
    formatted_address: googleResult.formatted_address || ""
  };
}

// Merge: prefer Google's value; fall back to LLM only when Google's is empty.
function mergeAddresses(googleAddr, llmAddr) {
  const result = { ...googleAddr };
  if (!llmAddr) return result;
  for (const key of ["address_line_1", "postcode", "city", "district", "state", "country"]) {
    if (!result[key] && llmAddr[key]) result[key] = llmAddr[key];
  }
  return result;
}

// Geocode just a postcode (plus country hint) so we know the city/area it covers.
async function geocodePostcodeArea(postcode, countryHint) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error("Missing Google Maps API key. Set GOOGLE_MAPS_API_KEY env var.");
  }
  const query = countryHint ? `${postcode}, ${countryHint}` : String(postcode);
  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: query, key: process.env.GOOGLE_MAPS_API_KEY },
      timeout: 10000
    });
    if (response.data.status !== "OK" || !response.data.results || response.data.results.length === 0) {
      return null;
    }
    return response.data.results[0];
  } catch (err) {
    throw new Error(`Google Maps API error (postcode lookup): ${err.message}`);
  }
}

// Ask OpenAI whether two addresses refer to the same real place, allowing for
// typos, transliteration, abbreviations, and missing diacritics. Returns true
// only if they are the same place — different streets in the same area = false.
async function addressesAreSamePlace(userAddress, googleAddress) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY env var.");
  }
  const prompt =
    `User input: "${userAddress}"\n` +
    `Google Maps result: "${googleAddress}"\n\n` +
    `Do these refer to the SAME real-world place? Allow for typos, transliteration (e.g. Urdu/Arabic to Latin), ` +
    `abbreviations, missing diacritics, and minor word-order differences. ` +
    `However, two different streets in the same city are NOT the same place. ` +
    `Two different landmarks in the same area are NOT the same place. ` +
    `Answer true only if the user clearly meant the same street/landmark Google returned.`;

  const response = await openaiPostWithRetry("https://api.openai.com/v1/responses", {
    model: OPENAI_MODEL,
    instructions:
      "You judge whether two address strings refer to the same physical place. " +
      "Be strict: small spelling differences = same; different streets or landmarks = different. " +
      "Return JSON with a boolean is_same_place and a short reason.",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "address_similarity",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            is_same_place: { type: "boolean" },
            reason:        { type: "string" }
          },
          required: ["is_same_place", "reason"]
        }
      }
    }
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });

  const outputText = getResponseText(response.data);
  if (!outputText) return { isSamePlace: false, reason: "no AI response" };
  const parsed = JSON.parse(outputText);
  return { isSamePlace: !!parsed.is_same_place, reason: parsed.reason || "" };
}

// Given a user's typed address and the area Google says the postcode covers,
// ask OpenAI to suggest the closest real street name in that area.
async function suggestAddressInPostcodeArea(userAddress, postcode, areaCity, areaCountry) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY env var.");
  }
  const prompt =
    `A user entered this address: "${userAddress}" with postcode ${postcode}. ` +
    `Google Maps could not find that exact address. The postcode ${postcode} is located in ${areaCity}, ${areaCountry}. ` +
    `ONLY suggest a correction if the user's input clearly refers to a real street, place, or landmark that actually exists in postcode ${postcode} ` +
    `(allowing for typos, missing diacritics, transliteration, or abbreviations). The corrected name must share meaningful tokens with the user's input — ` +
    `e.g. "Quirinusplaz" → "Quirinusplatz" is fine, but "Quaid-e-Azam University" → "Quirinusplatz" is NOT, because the names are unrelated. ` +
    `If the user's input is for a different city, country, or region (i.e. it has no plausible match in postcode ${postcode}), return an empty string. ` +
    `Do NOT invent or substitute an unrelated street just because it exists in the postcode area. Keep the house number if the input had one.`;

  const response = await openaiPostWithRetry("https://api.openai.com/v1/responses", {
    model: OPENAI_MODEL,
    instructions:
      "You correct mistyped or misspelled street addresses to match real streets in a given postcode area. " +
      "The correction must be the SAME place the user was trying to type — only fix typos, transliteration, abbreviations, or missing diacritics. " +
      "NEVER substitute an unrelated street, landmark, or place just because it exists in the postcode area. " +
      "If the user's input has no plausible match in the given postcode (e.g. it refers to a different city or country), " +
      "return an empty string in corrected_address. When in doubt, return an empty string rather than guessing.",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "address_correction",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            corrected_address: { type: "string" },
            confidence:        { type: "string" }
          },
          required: ["corrected_address", "confidence"]
        }
      }
    }
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });

  const outputText = getResponseText(response.data);
  if (!outputText) return null;
  const parsed = JSON.parse(outputText);
  if (!parsed.corrected_address) return null;
  return { correctedAddress: parsed.corrected_address, confidence: parsed.confidence || "" };
}

// Monday API helper
async function mondayAPI(query, variables, token) {
  const response = await axios.post(
    "https://api.monday.com/v2",
    { query, variables },
    {
      headers: {
        Authorization: token,
        "Content-Type": "application/json"
      },
      timeout: 10000
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data.data;
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

async function getBoardItems(boardId, token) {
  const firstPageQuery = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        items_page(limit: 100) {
          cursor
          items {
            id
            name
            board { id }
            column_values { id text value type }
          }
        }
      }
    }
  `;

  const nextPageQuery = `
    query ($cursor: String!) {
      next_items_page(cursor: $cursor, limit: 100) {
        cursor
        items {
          id
          name
          board { id }
          column_values { id text value type }
        }
      }
    }
  `;

  const items = [];
  const firstPageData = await mondayAPI(firstPageQuery, { boardId: [String(boardId)] }, token);
  let page = firstPageData.boards?.[0]?.items_page;

  while (page) {
    items.push(...(page.items || []));
    if (!page.cursor) break;

    const nextPageData = await mondayAPI(nextPageQuery, { cursor: page.cursor }, token);
    page = nextPageData.next_items_page;
  }

  return items;
}

async function updateItem(boardId, itemId, columnValues, token) {
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(
        board_id: $boardId,
        item_id: $itemId,
        column_values: $values
      ) {
        id
      }
    }
  `;
  return mondayAPI(
    mutation,
    {
      boardId: String(boardId),
      itemId:  String(itemId),
      values:  JSON.stringify(columnValues)
    },
    token
  );
}

function getColumnValue(columnValues, columnId) {
  const col = columnValues.find(c => c.id === columnId);
  if (!col) return "";

  const text = (col.text || "").trim();
  if (text) return text;

  // Fallback: some column types (mirror, formula, certain text variants)
  // leave `text` empty but expose the data in `value` as JSON.
  const parsed = safeJsonParse(col.value);
  if (parsed && typeof parsed === "object") {
    const candidate = parsed.text || parsed.value || parsed.label || parsed.name;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();

  return "";
}

function getMissingFields(address) {
  return REQUIRED_FIELDS
    .filter(field => !address?.[field.key] || String(address[field.key]).trim() === "")
    .map(field => field.label);
}


// Compose the full address from the structured fields we're about to write,
// so Vollständige Adresse stays consistent with the other columns.
function composeFullAddress(geo) {
  if (!geo) return "";
  const cityLine = [geo.postcode, geo.city].filter(Boolean).join(" ").trim();
  const parts = [
    geo.address_line_1,
    cityLine,
    geo.district,
    geo.state,
    geo.country
  ].map(p => (p || "").trim()).filter(Boolean);
  return parts.join(", ");
}

function makeLocationValue(geo) {
  if (!geo || !geo.latitude || !geo.longitude) return undefined;

  // All of these come from the latest geocoding result (geo === mergedAddress,
  // whose fields/formatted_address are set straight from Google's geocode).
  const address = geo.formatted_address || composeFullAddress(geo);

  // Monday's location column accepts only lat/lng/address/placeId plus
  // object-typed country/city/street/streetNumber ({long_name, short_name}).
  // Sending `name`, or `country` as a plain string, is rejected with a schema
  // error — so each component is wrapped as an object and only added when set.
  const value = {
    lat: Number(geo.latitude),
    lng: Number(geo.longitude),
    address: address || ""
  };

  const component = name => (name ? { long_name: name, short_name: name } : undefined);
  const country = component(geo.country);
  const city = component(geo.city);
  const street = component(geo.address_line_1);
  if (country) value.country = country;
  if (city) value.city = city;
  if (street) value.street = street;

  return value;
}

function buildUpdatePayload(geo, missingFields, cols, labels) {
  const isComplete = missingFields.length === 0;
  const payload = {
    [cols.status]: { label: isComplete ? labels.done : labels.stuck }
  };

  if (geo) {
    if (geo.address_line_1) payload[cols.address_line_1] = geo.address_line_1;
    if (geo.postcode)       payload[cols.postcode]       = geo.postcode;
    if (geo.city)           payload[cols.city]           = geo.city;
    if (geo.district)       payload[cols.district]       = geo.district;
    if (geo.state)          payload[cols.state]          = geo.state;
    if (geo.country)        payload[cols.country]        = geo.country;
    if (geo.latitude)       payload[cols.latitude]       = String(geo.latitude);
    if (geo.longitude)      payload[cols.longitude]      = String(geo.longitude);

    const fullAddress = composeFullAddress(geo);
    if (fullAddress) payload[cols.full_address] = fullAddress;

    if (cols.location) {
      const location = makeLocationValue(geo);
      if (location) payload[cols.location] = location;
    }
  }

  return payload;
}

async function processItem(item, boardId, token) {
  const cols = getColumnIds(boardId);
  const labels = getStatusLabels(boardId);
  const addressLine1 = getColumnValue(item.column_values, cols.address_line_1);
  const pincode = getColumnValue(item.column_values, cols.postcode);

  // Both Address Line 1 and Pincode are mandatory
  if (!addressLine1 || !pincode) {
    console.log(`Item ${item.id}: Missing Address Line 1 or Pincode (addr="${addressLine1}", pincode="${pincode}")`);
    console.log(`Item ${item.id}: column dump:`, JSON.stringify(
      item.column_values.filter(c => c.id === cols.address_line_1 || c.id === cols.postcode)
    ));
    await updateItem(boardId, item.id, {
      [cols.status]: { label: labels.stuck }
    }, token);
    return {
      itemId: String(item.id),
      skipped: true,
      reason: "Address Line 1 or Pincode is empty",
      isComplete: false
    };
  }

  console.log(`Item ${item.id}: Geocoding address "${addressLine1}" (user pincode: ${pincode})`);

  // Step 1: Geocode the address ONLY (no postcode) so Google can't fuzzy-match
  // a wrong address+postcode combo. We validate the user's postcode against
  // Google's authoritative postcode separately below.
  let googleResult = await geocodeAddressWithGoogleMaps(addressLine1);
  let googlePostcode = googleResult.success ? extractPostcodeFromGoogleMapsResult(googleResult.data) : null;
  let usedAddressLine1 = addressLine1;

  const initialMismatch =
    !googleResult.success ||
    !googlePostcode ||
    googlePostcode.trim() !== pincode.trim();

  if (initialMismatch) {
    // Fallback: use the postcode to find the area, ask AI to suggest the closest
    // real street in that postcode, then re-geocode the AI-corrected address.
    console.log(`Item ${item.id}: Initial geocode mismatch — looking up postcode ${pincode} area for AI correction.`);
    const areaResult = await geocodePostcodeArea(pincode);
    if (areaResult) {
      const areaComponents = areaResult.address_components || [];
      const areaCity =
        findComponent(areaComponents, "locality") ||
        findComponent(areaComponents, "postal_town") ||
        findComponent(areaComponents, "administrative_area_level_2");
      const areaCountry = findComponent(areaComponents, "country");

      const suggestion = await suggestAddressInPostcodeArea(addressLine1, pincode, areaCity, areaCountry);
      if (suggestion && suggestion.correctedAddress) {
        console.log(`Item ${item.id}: AI suggested "${suggestion.correctedAddress}" (confidence: ${suggestion.confidence})`);

        // Verify the AI suggestion is a REAL address, not a fabrication:
        // geocode the bare suggestion (no postcode/country appended) so Google
        // can't fuzzy-match against the postcode we already know. The suggestion
        // is only accepted if Google independently returns the same postcode.
        const retry = await geocodeAddressWithGoogleMaps(suggestion.correctedAddress);
        const retryPostcode = retry.success ? extractPostcodeFromGoogleMapsResult(retry.data) : null;
        const postcodeMatches = retry.success && retryPostcode && retryPostcode.trim() === pincode.trim();

        if (postcodeMatches) {
          // Postcode matches isn't enough — the AI may have invented an unrelated
          // street that happens to live in the right postcode. Verify the
          // suggestion is the SAME place the user was trying to type.
          const retryFormatted = retry.data.formatted_address || suggestion.correctedAddress;
          const similarity = await addressesAreSamePlace(addressLine1, retryFormatted);
          if (similarity.isSamePlace) {
            googleResult = retry;
            googlePostcode = retryPostcode;
            usedAddressLine1 = suggestion.correctedAddress;
            console.log(`Item ${item.id}: AI correction validated against postcode ${pincode} and same-place check (${similarity.reason}).`);
          } else {
            console.log(`Item ${item.id}: AI suggestion postcode matched but it's an UNRELATED place ("${retryFormatted}" vs user "${addressLine1}" — ${similarity.reason}) — rejecting suggestion.`);
          }
        } else {
          console.log(`Item ${item.id}: AI correction did not validate against postcode ${pincode} (Google returned postcode "${retryPostcode || 'none'}" for the suggested address) — rejecting suggestion.`);
        }
      }
    }
  }

  if (!googleResult.success) {
    console.log(`Item ${item.id}: ${googleResult.message}`);
    await updateItem(boardId, item.id, {
      [cols.status]: { label: labels.stuck }
    }, token);
    return {
      itemId: String(item.id),
      extracted: false,
      reason: googleResult.message
    };
  }

  if (!googlePostcode) {
    // Fallback: Google didn't return a postcode (common in PK/IN). Re-query
    // with the user's pincode appended so Google resolves inside that region,
    // then ask AI whether the Google result is the SAME place as the user input.
    // Only accept if same place — never substitute an unrelated street.
    console.log(`Item ${item.id}: Google did not return a postcode for "${usedAddressLine1}" — trying pincode-anchored fallback.`);

    const areaResult = await geocodePostcodeArea(pincode);
    const areaCountry = areaResult ? findComponent(areaResult.address_components || [], "country") : "";
    const fallbackQuery = [usedAddressLine1, pincode, areaCountry].filter(Boolean).join(", ");
    const fallback = await geocodeAddressWithGoogleMaps(fallbackQuery);

    if (fallback.success) {
      const fallbackFormatted = fallback.data.formatted_address || "";
      const similarity = await addressesAreSamePlace(usedAddressLine1, fallbackFormatted);
      console.log(`Item ${item.id}: Pincode-anchored result "${fallbackFormatted}" — same place? ${similarity.isSamePlace} (${similarity.reason})`);

      if (similarity.isSamePlace) {
        googleResult = fallback;
        // Trust the user's pincode for this address (Google didn't return one
        // for the region, but we verified the place matches). Skips the strict
        // postcode-string check below.
        googlePostcode = pincode;
        console.log(`Item ${item.id}: Accepting pincode-anchored Google address; storing user pincode ${pincode}.`);
      } else {
        await updateItem(boardId, item.id, {
          [cols.status]: { label: labels.stuck }
        }, token);
        return {
          itemId: String(item.id),
          extracted: false,
          reason: `Address and pincode do not match — Google's result for pincode ${pincode} ("${fallbackFormatted}") is not the same place as "${usedAddressLine1}".`
        };
      }
    } else {
      await updateItem(boardId, item.id, {
        [cols.status]: { label: labels.stuck }
      }, token);
      return {
        itemId: String(item.id),
        extracted: false,
        reason: "Google Maps did not return a postcode for this address — cannot verify."
      };
    }
  }

  if (googlePostcode.trim() !== pincode.trim()) {
    console.log(`Item ${item.id}: Pincode mismatch — user entered "${pincode}" but Google Maps expects "${googlePostcode}" (even after AI correction).`);
    await updateItem(boardId, item.id, {
      [cols.status]: { label: labels.stuck }
    }, token);
    return {
      itemId: String(item.id),
      extracted: false,
      reason: `Pincode mismatch — you entered ${pincode} but Google Maps expects ${googlePostcode} for this address`
    };
  }

  // Step 3: Pull structured fields + lat/lng straight from Google.
  const googleAddress = extractAddressFromGoogleResult(googleResult.data);
  // Backfill postcode from the user's pincode if Google omitted it (fallback path).
  if (!googleAddress.postcode && pincode) {
    googleAddress.postcode = pincode;
  }
  const formattedAddress = googleAddress.formatted_address;

  console.log(`Item ${item.id}: Google address: "${formattedAddress}"`);

  // Step 4: Use OpenAI only to fill gaps Google didn't return (e.g. missing district).
  let mergedAddress = googleAddress;
  const googleMissing = getMissingFields(googleAddress);
  const needsLlmFill = googleMissing.length > 0 || !googleAddress.district || !googleAddress.state;

  if (needsLlmFill) {
    const inputForOpenAI = `${formattedAddress} (User entered: ${addressLine1}, ${pincode})`;
    console.log(`Item ${item.id}: Asking LLM to fill missing fields: ${googleMissing.join(", ") || "district/state"}`);
    const llmAddress = await extractAddressDetails(inputForOpenAI);
    mergedAddress = mergeAddresses(googleAddress, llmAddress);
  }

  const missingFields = getMissingFields(mergedAddress);
  const payload = buildUpdatePayload(mergedAddress, missingFields, cols, labels);

  await updateItem(boardId, item.id, payload, token);

  console.log(`Item ${item.id}: ${missingFields.length === 0 ? "Complete" : `Stuck — missing: ${missingFields.join(", ")}`}`);

  return {
    itemId:     String(item.id),
    extracted:  true,
    isComplete: missingFields.length === 0,
    missing:    missingFields,
    geo:        mergedAddress
  };
}

// Delay between items in a board scan, to stay under OpenAI rate limits.
const BOARD_ITEM_DELAY_MS = Number(process.env.BOARD_ITEM_DELAY_MS || 1200);

async function processBoard(boardId, token) {
  const items = await getBoardItems(boardId, token);
  console.log(`Board ${boardId}: Processing ${items.length} items`);

  const results = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(BOARD_ITEM_DELAY_MS);
    results.push(await processItem(items[i], boardId, token));
  }

  return {
    processed: results.length,
    complete: results.filter(result => result.isComplete).length,
    stuck: results.filter(result => !result.isComplete).length,
    results
  };
}

// Payload extraction (handles Monday automation + webhook formats)
function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function toFirstDefined(values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function normalizeId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function extractIdsFromPayload(payload) {
  const inbound = payload?.inboundFieldValues || {};
  const input = payload?.inputFields || {};
  const event = payload?.event || {};
  const metadata = payload?.runtimeMetadata || {};
  const parsed = safeJsonParse(payload?.payload) || (payload?.payload && typeof payload.payload === "object" ? payload.payload : {});

  const sources = [payload || {}, event || {}, input || {}, inbound || {}, parsed || {}, payload?.body || {}];

  function extractFromValue(v) {
    if (v === undefined || v === null || v === "") return undefined;
    if (Array.isArray(v)) {
      const first = v.find(x => x !== undefined && x !== null && x !== "");
      if (first === undefined) return undefined;
      if (typeof first === "object") return first.id ?? undefined;
      return first;
    }
    if (typeof v === "object") return v.id ?? undefined;
    return v;
  }

  function findKeyInSource(src, keys) {
    if (!src || typeof src !== "object") return undefined;
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const found = extractFromValue(src[k]);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const boardKeys = ["boardId", "board_id", "board", "boardID", "boardid", "boardIds", "board_ids"];
  const itemKeys = ["itemId", "item_id", "pulseId", "pulse_id", "pulse", "item", "itemID", "itemid", "pulseIds", "pulse_ids", "itemIds", "item_ids"];

  let boardIdRaw;
  let itemIdRaw;

  for (const src of sources) {
    if (boardIdRaw === undefined) {
      boardIdRaw = findKeyInSource(src, boardKeys);
      if (boardIdRaw === undefined && src?.board && typeof src.board === "object") {
        boardIdRaw = findKeyInSource(src.board, ["id", "boardId", "board_id"]);
      }
    }

    if (itemIdRaw === undefined) {
      itemIdRaw = findKeyInSource(src, itemKeys);
      if (itemIdRaw === undefined && src?.item && typeof src.item === "object") {
        itemIdRaw = findKeyInSource(src.item, ["id", "itemId", "item_id"]);
      }
      if (itemIdRaw === undefined && src?.pulse && typeof src.pulse === "object") {
        itemIdRaw = findKeyInSource(src.pulse, ["id", "pulseId", "pulse_id"]);
      }
    }

    if (boardIdRaw !== undefined && itemIdRaw !== undefined) break;
  }

  // fallbacks: legacy direct properties
  if (boardIdRaw === undefined) {
    boardIdRaw = toFirstDefined([
      payload?.boardId, event?.boardId, event?.board_id,
      input?.boardId, inbound?.boardId,
      metadata?.hostMetadata?.hostInstanceId,
      parsed?.boardId
    ]);
  }

  if (itemIdRaw === undefined) {
    itemIdRaw = toFirstDefined([
      payload?.itemId, payload?.pulseId,
      event?.pulseId, event?.itemId, event?.item_id,
      input?.itemId, inbound?.itemId,
      parsed?.itemId
    ]);
  }

  const boardId = normalizeId(boardIdRaw);
  const itemId = normalizeId(itemIdRaw);

  console.log(`Resolved IDs: boardId=${boardId}, itemId=${itemId}`);

  return { boardId, itemId };
}

function extractChangedColumnIds(payload) {
  const event = payload?.event || {};
  const inbound = payload?.inboundFieldValues || {};
  const input = payload?.inputFields || {};
  const parsed = safeJsonParse(payload?.payload) || (payload?.payload && typeof payload.payload === "object" ? payload.payload : {});

  const sources = [payload || {}, event || {}, input || {}, inbound || {}, parsed || {}, payload?.body || {}];

  function extractColumnIdFromValue(v) {
    if (v === undefined || v === null || v === "") return undefined;
    if (Array.isArray(v)) {
      const first = v.find(x => x !== undefined && x !== null && x !== "");
      if (first === undefined) return undefined;
      if (typeof first === "object") return first.id ?? undefined;
      return first;
    }
    if (typeof v === "object") return v.id ?? undefined;
    return v;
  }

  const columnKeys = ["columnId", "column_id", "column", "columnId[]", "column_ids", "columnIdList"];

  const found = new Set();
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const k of columnKeys) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const val = extractColumnIdFromValue(src[k]);
      if (val !== undefined) found.add(String(val));
    }

    // also check nested column object
    if (src.column && typeof src.column === "object") {
      const id = extractColumnIdFromValue(src.column.id ?? src.column.columnId ?? src.column.column_id);
      if (id !== undefined) found.add(String(id));
    }
  }

  // legacy direct lookups
  const legacy = [payload?.columnId, payload?.column_id, event?.columnId, event?.column_id, event?.column?.id, inbound?.columnId, input?.columnId, parsed?.columnId];
  for (const l of legacy) {
    const v = extractColumnIdFromValue(l);
    if (v !== undefined) found.add(String(v));
  }

  return [...found].filter(Boolean);
}


// Any board's address_line_1 / postcode column. Column IDs are globally unique
// in monday, so a changed-column match here only ever means a real trigger.
const TRIGGER_COLUMN_IDS = Object.values(BOARD_COLUMN_IDS)
  .flatMap(cols => [cols.address_line_1, cols.postcode]);

function shouldSkip(payload) {
  const changed = extractChangedColumnIds(payload);
  if (changed.length === 0) return false;
  return !changed.some(id => TRIGGER_COLUMN_IDS.includes(id));
}

// Decode a JWT's payload (middle segment) without verifying the signature.
// Monday wraps the real API token inside an outer JWT — the usable
// shortLivedToken lives in that JWT's payload claims.
function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Given any token string, return the Monday API token to actually use.
// If it's a wrapper JWT containing a shortLivedToken claim, return that
// inner token; otherwise return the string as-is.
function resolveApiToken(tokenString) {
  if (typeof tokenString !== "string" || !tokenString.trim()) return undefined;
  const raw = tokenString.replace(/^Bearer\s+/i, "").trim();

  const claims = decodeJwtPayload(raw);
  if (claims && typeof claims.shortLivedToken === "string" && claims.shortLivedToken.trim()) {
    return claims.shortLivedToken.trim();
  }
  return raw;
}

// Search any object for a Monday auth token under the various key names
// Monday Code / automations use, then unwrap it to the real API token.
function findTokenInObject(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = [
    "shortLivedToken", "shortlivedtoken", "short_lived_token",
    "monday_api_token", "mondayApiToken",
    "sessionToken", "session_token",
    "token", "authorization", "Authorization"
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") {
      return resolveApiToken(v);
    }
  }
  return undefined;
}

function getToken(payload, context) {
  // Prefer an explicitly configured MONDAY_API_TOKEN env var when present.
  // A personal API token carries full account scopes, whereas the short-
  // lived token Monday sends with a trigger only has the app's granted
  // scopes — which can fail board-level queries (UNAUTHORIZED_FIELD_OR_TYPE).
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

function hasOwnData(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function normalizeActionPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const parsedPayload = safeJsonParse(payload.payload);
  const parsedBody = safeJsonParse(payload.body);
  const nestedPayload = (parsedPayload && typeof parsedPayload === "object") ? parsedPayload : (payload.payload && typeof payload.payload === "object" ? payload.payload : null);
  const nestedBody = (parsedBody && typeof parsedBody === "object") ? parsedBody : (payload.body && typeof payload.body === "object" ? payload.body : null);

  if (!nestedPayload && !nestedBody) {
    return payload;
  }

  return {
    ...payload,
    ...(nestedPayload || {}),
    payload: nestedPayload || payload.payload,
    body: nestedBody || payload.body
  };
}

// Heuristic: does this object look like a Monday automation/webhook PAYLOAD
// (carries the data to act on) rather than a CONTEXT (carries auth/runtime)?
function looksLikePayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  const payloadKeys = [
    "inboundFieldValues", "inputFields", "payload", "event",
    "itemId", "pulseId", "boardId", "columnId", "challenge"
  ];
  return payloadKeys.some(k => Object.prototype.hasOwnProperty.call(obj, k));
}

// Monday Code calls action(payload, context); the HTTP server calls
// action(context, payload). Detect which arg is which by content, not position.
function resolveActionArgs(argA = {}, argB = {}) {
  const a = argA || {};
  const b = argB || {};

  // Whichever arg looks like a payload wins; the other becomes context.
  if (looksLikePayload(a) && !looksLikePayload(b)) {
    return { context: b, payload: a };
  }
  if (looksLikePayload(b) && !looksLikePayload(a)) {
    return { context: a, payload: b };
  }

  // Both or neither look like payloads — fall back to richer-object-wins,
  // and unwrap a nested .payload if present.
  if (a?.payload && typeof a.payload === "object") {
    return { context: a, payload: a.payload };
  }
  if (b?.payload && typeof b.payload === "object") {
    return { context: b, payload: b.payload };
  }
  if (hasOwnData(b)) {
    return { context: a, payload: b };
  }
  return { context: b, payload: a };
}

// Main action handler.
// Monday Code invokes this as action(payload, context); the local HTTP
// server invokes it as action(context, payload). resolveActionArgs sorts
// it out by inspecting the contents of each argument.
async function action(argA = {}, payloadArg = {}) {
  // TEMP DEBUG: log raw incoming arguments so we can see Monday's payload shape.
  console.log("RAW argA:", JSON.stringify(argA));
  console.log("RAW payloadArg:", JSON.stringify(payloadArg));

  const resolved = resolveActionArgs(argA, payloadArg);
  const context = resolved.context;
  const payload = normalizeActionPayload(resolved.payload);
  const token = getToken(payload, context);

  if (!token) {
    throw new Error(
      "Missing Monday API token. Provide a shortLivedToken in the request " +
      "context or set the MONDAY_API_TOKEN environment variable."
    );
  }

  if (shouldSkip(payload)) {
    return { success: true, skipped: true, reason: "Output column update ignored to prevent loops." };
  }

  const { boardId: rawBoardId, itemId } = extractIdsFromPayload(payload);

  if (!itemId) {
    console.log(
      `No item ID in payload — refusing to process whole board ${rawBoardId}. ` +
      `Fix the recipe so itemId is passed in inboundFieldValues.`
    );
    return {
      success: false,
      skipped: true,
      reason: "No item ID in payload. Recipe must pass itemId via an item-scoped trigger.",
      boardId: rawBoardId || null
    };
  }

  const item = await getItemData(itemId, token);
  if (!item) throw new Error(`Item ${itemId} not found.`);

  const boardId = normalizeId(item.board?.id || rawBoardId);
  if (!boardId) throw new Error(`Could not resolve board ID for item ${itemId}.`);

  const result = await processItem(item, boardId, token);

  return { success: true, boardId, ...result };
}

// HTTP server
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

const server = http.createServer(async (req, res) => {
  // Health check on any GET — Monday Code probes the root path.
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // Accept the automation/webhook POST on ANY path. Monday's feature config
  // may call "/", "/action", "/webhook", or a generated path; matching only
  // specific routes caused 404s ("resource not found"). Handle them all.
  if (req.method === "POST") {
    try {
      console.log(`Incoming POST ${req.url}`);
      const payload = await readBody(req);
      
      if (payload.challenge) {
        sendJson(res, 200, { challenge: payload.challenge });
        return;
      }

      // Carry any Authorization header through as context; action() will
      // also fall back to MONDAY_API_TOKEN if no token is present.
      const context = {
        token: req.headers.authorization || req.headers.Authorization || undefined
      };

      const result = await action(context, payload);
      sendJson(res, 200, result);
    } catch (err) {
      console.error("Error:", err.message);
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { success: false, error: "Not found" });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ZVG Address Enrichment running on port ${PORT}`);
  });
}

module.exports = {
  action,
  extractAddressDetails,
  geocodeAddress: extractAddressDetails,
  processBoard,
  processItem
};

// Export helpers for testing
module.exports.extractIdsFromPayload = extractIdsFromPayload;
module.exports.extractChangedColumnIds = extractChangedColumnIds;
