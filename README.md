# HERE Address Enrichment

monday automation that fills a row's address columns from the **HERE Geocoding API**.
The HERE query and field mapping are ported from [`here.py`](here.py).

## Repository layout

| Path | |
|---|---|
| `index.js`, `here.js`, `monday.js`, `payload.js`, `config.js` | The HERE app (deployed) |
| `test/` | Tests with monday and HERE stubbed |
| `here.py` | Standalone script comparing HERE vs Postcode Service on sample addresses |
| `prev_version_Google_API.zip` | Previous Google Maps + OpenAI validator, zipped for reference (not deployed). Also tagged `v1-google-openai`. |

## Trigger points

monday's automation block only sends `boardId` + `itemId` — not which column changed — so
each block calls its own URL and the URL picks the mode:

| Board automation | Block URL | Mode | What it does |
|---|---|---|---|
| When **Vollständige Adresse** changes | `…/action/address` | `address` | Geocodes the full address and fills Adresszeile 1, Postcode, Ort, Landkreis, Bundesland, Land, Breitengrad, Längengrad, location pin and status. Never overwrites Full Address. |
| When **Adresszeile 1** changes / When **Postcode** changes | `…/action/fields` | `fields` | Geocodes `Adresszeile 1, Postcode` and checks HERE agrees on the postcode. If so, refreshes Ort, Landkreis, Bundesland, Land, lat/lng, location pin and Full Address. Never overwrites Adresszeile 1 or Postcode. |
| (any) | `…/action` | auto | `fields` if Adresszeile 1 + Postcode are filled, else `address` if Full Address is filled. Kept so the old URL still works. |

If a payload does include a column ID (webhooks), that decides the mode instead.

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
writes Full Address), which fires the automations again. Two guards stop that:

1. After each write the app remembers the item's Full Address, Adresszeile 1 and Postcode
   (2 minutes) and ignores an event where none of them has changed since.
2. Writes are diff-only. If the echo reaches a fresh instance, it finds nothing to change, writes
   nothing, and the chain ends.

## Environment

| Variable | Required | |
|---|---|---|
| `HERE_API_KEY` | yes | HERE API key with Geocoding & Search enabled |
| `MONDAY_API_TOKEN` | recommended | Otherwise the short-lived token from the trigger is used |
| `COLUMN_LOCATION_ID` | for board 5063711037 | Location column of the original board (already set on monday) |
| `COLUMN_*_ID`, `DONE_STATUS_LABEL`, `STUCK_STATUS_LABEL` | no | Same overrides as the previous version, original board only |
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
curl -X POST http://localhost:8080/action/address -H "Content-Type: application/json" \
  -d '{"payload": {"inboundFieldValues": {"boardId": 5090777446, "itemId": 123456789}}}'
```

## monday configuration (app "Address Validator", ID 11380387)

Current state: v1 deprecated, **v2 live**, v3 draft. Build the HERE version in a draft and
promote only after testing.

**Server-side code → Environment variables** — add `HERE_API_KEY`. Keep `MONDAY_API_TOKEN` and
`COLUMN_LOCATION_ID`. Do not delete `OPENAI_API_KEY` / `GOOGLE_MAPS_API_KEY` while v2 is live.

**Features → existing block "Address validator"** (unique key `zvg-group_address::Address_validator`)
— leave everything as is, only change the Execution URL to the draft's deployment + `/action/fields`:

| Setting | Value |
|---|---|
| Block type | Action, not async |
| Connect to monday code | unticked (URL entered manually) |
| Input fields | Board Id (`boardId`), Item Id (`itemId`, main field) |
| Output fields | none |
| Execution URL | `https://<draft deployment>.us.monday.app/action/fields` |
| Workflow builder / Automation builder | Off / On |
| Field sources | Board Id: Sentence, display "Board Id"; Item Id: Sentence, display "Item Id" |
| Sentence | `Validate address for {Item Id} on {Board Id}` |

**Features → new block "Fill address"** — create an Automation Block with exactly the same
settings, except:

| Setting | Value |
|---|---|
| Block name | Fill address |
| Execution URL | `https://<draft deployment>.us.monday.app/action/address` |
| Sentence | `Fill address from full address for {Item Id} on {Board Id}` |

**OAuth & permissions** — no change (the app only needs `boards:read` / `boards:write`).

**Board automations** (per board):

1. When **Vollständige Adresse** changes → Fill address from full address for item on board
2. When **Adresszeile 1** changes → Validate address for item on board
3. When **Postcode** changes → Validate address for item on board
