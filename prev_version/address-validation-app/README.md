# Address Validation Automation

This app extracts address details from a full address with OpenAI and writes the result back to the board.

## What It Does

- Accepts Monday automation/action payloads on `/action`
- Accepts local or webhook-style payloads on `/webhook`
- Processes one item when an item ID is provided
- Processes all board rows when only a board ID is provided
- Reads the configured full address column
- Uses OpenAI to return structured address fields
- Updates address fields, latitude/longitude, and status

## Required Environment Variables

- `MONDAY_API_TOKEN`: Monday API token used for read/write operations
- `OPENAI_API_KEY`: OpenAI API key used to extract structured address details

## Optional Environment Variables

- `PORT`: Server port, defaults to `8080`
- `OPENAI_MODEL`: Defaults to `gpt-4o-mini`
- `DONE_STATUS_LABEL`: Defaults to `Complete`
- `STUCK_STATUS_LABEL`: Defaults to `Stuck`
- `COLUMN_FULL_ADDRESS_ID`
- `COLUMN_ADDRESS_LINE_1_ID`
- `COLUMN_ADDRESS_LINE_2_ID`
- `COLUMN_POSTCODE_ID`
- `COLUMN_DISTRICT_ID`
- `COLUMN_CITY_ID`
- `COLUMN_STATE_ID`
- `COLUMN_COUNTRY_ID`
- `COLUMN_LATITUDE_ID`
- `COLUMN_LONGITUDE_ID`
- `COLUMN_STATUS_ID`

If the optional column variables are not supplied, the app uses the IDs currently checked into `index.js`.

## Local Run

```bash
cd address-validation-app
MONDAY_API_TOKEN=your-token OPENAI_API_KEY=your-openai-key node index.js
```

Health check:

```bash
curl http://localhost:8080/health
```

Example single-item test:

```bash
curl -X POST http://localhost:8080/action \
  -H "Content-Type: application/json" \
  -d '{
    "monday_api_token": "your-token",
    "event": {
      "pulseId": 123456789
    }
  }'
```

## Monday Setup Notes

- Point the server-side action or webhook URL to this service
- Prefer passing the API token through Monday runtime secrets or environment variables
- Do not keep production tokens hard-coded in source files
- Use a board automation that runs when an item is created or when any address column changes
- The app will mark the row `Complete` only when these fields are filled: address line 1, postcode, city, state, country, latitude, and longitude
- The app will mark the row `Stuck` when any of those required fields is still missing
- Updates that only change output columns are ignored to prevent automation loops
