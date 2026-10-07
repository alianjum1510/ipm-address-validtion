# HERE Address Enrichment

monday automation that fills a row's address columns from the **HERE Geocoding API**.
The HERE query and field mapping are ported from [`here.py`](here.py).

## Repository layout

| Path | |
|---|---|
| `index.js`, `here.js`, `monday.js`, `payload.js`, `config.js` | The HERE app (deployed) |
| `test/` | Tests with monday and HERE stubbed |
| `here.py` | Standalone script comparing HERE vs Postcode Service on sample addresses |
| `prev_version/` | Previous Google Maps + OpenAI validator, kept for reference (not deployed). Also tagged `v1-google-openai`. |

## Trigger points

| Column changed | Mode | What it does |
|---|---|---|
| **Vollständige Adresse** (Full Address) | `address` | Geocodes the full address and fills Adresszeile 1, Postcode, Ort, Landkreis, Bundesland, Land, Breitengrad, Längengrad, location pin and status. Never overwrites Full Address. |
| **Adresszeile 1** or **Postcode** | `fields` | Geocodes `Adresszeile 1, Postcode` and checks HERE agrees on the postcode. If so, refreshes Ort, Landkreis, Bundesland, Land, lat/lng, location pin and Full Address. Never overwrites Adresszeile 1 or Postcode. |
| Any other column | — | Ignored. |
| No column in the event (e.g. "item created" recipe) | auto | `fields` if Adresszeile 1 + Postcode are filled, else `address` if Full Address is filled. |

Column IDs per board are in [`config.js`](config.js) (boards `5063711037` and `5090777446`).

## How HERE is called (same as here.py)

`GET https://geocode.search.hereapi.com/v1/geocode?q=…&limit=1&lang=de&in=countryCode:XXX&apiKey=…`

- Full Address in the client sheet format `street, [house], postcode, city, district, state, country`
  is parsed into `street, postcode city` (Dutch `6442` + `Pb Brunssum` → `6442 PB` + `Brunssum`).
  Any other format is sent to HERE as free text.
- Country names (Deutschland, Niederlande, …) become a `countryCode` filter.
- Mapping: `postalCode`→Postcode, `city`→Ort, `county`→Landkreis, `state`→Bundesland (German names
  translated to the English ones the sheet uses), `countryName`→Land, position→lat/lng (4 decimals).
  Adresszeile 1 = `street` + `houseNumber`.

## Status

- **Done / Complete** — HERE matched and Adresszeile 1, Postcode, Ort and Land are all filled.
- **Stuck** — inputs empty, HERE found nothing, HERE's postcode disagrees with the user's, or a
  required field is still empty. On a postcode mismatch only the status changes.

## Loop protection

The app writes to trigger columns (mode `address` writes Adresszeile 1 + Postcode; mode `fields`
writes Full Address), which fires the trigger again. Two guards stop that:

1. The app remembers what it just wrote (2 minutes) and ignores the echo.
2. Writes are diff-only. If the echo reaches a fresh instance, it finds nothing to change, writes
   nothing, and the chain ends.

## Environment

| Variable | Required | |
|---|---|---|
| `HERE_API_KEY` | yes | HERE API key with Geocoding & Search enabled |
| `MONDAY_API_TOKEN` | recommended | Otherwise the short-lived token from the trigger is used |
| `PORT` | no | Defaults to `8080` |
| `DEFAULT_BOARD_ID` | no | Column map used for unknown boards, defaults to `5063711037` |

No npm dependencies — Node 18+ built-in `fetch` is used.

## Run & test locally

```bash
cp .env.example .env    # fill in the keys
npm start               # GET / → OK
npm test                # stubbed monday + HERE, no keys needed
```

```bash
curl -X POST http://localhost:8080/action -H "Content-Type: application/json" \
  -d '{"event": {"pulseId": 123456789, "columnId": "text_mkzzbqtq"}}'
```

## monday setup

1. Create a new app in the Developer Center and put its ID in `manifest.yml` (`app_id`).
2. Deploy with `mapps code:push`, set `HERE_API_KEY` (and `MONDAY_API_TOKEN`) as secrets.
3. On the board, add the recipe so it fires when **Vollständige Adresse**, **Adresszeile 1** or
   **Postcode** changes, and passes the item ID and column ID.
