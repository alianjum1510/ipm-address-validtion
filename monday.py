# monday GraphQL helpers.
import json
import urllib.error
import urllib.request

MONDAY_API_URL = "https://api.monday.com/v2"


def to_json(value):
    """Compact JSON, like JSON.stringify."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def monday_api(query, variables, token):
    req = urllib.request.Request(
        MONDAY_API_URL,
        data=to_json({"query": query, "variables": variables}).encode("utf-8"),
        headers={"Authorization": token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            status, raw, ok = res.status, res.read(), True
    except urllib.error.HTTPError as err:
        status, raw, ok = err.code, err.read(), False

    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    if not ok or data.get("errors"):
        raise RuntimeError(f"monday API error (HTTP {status}): {to_json(data.get('errors') or data)}")
    return data.get("data") or {}


def get_item_data(item_id, token):
    query = """
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        board { id }
        column_values { id text value type }
      }
    }
  """
    data = monday_api(query, {"itemId": [str(item_id)]}, token)
    items = data.get("items") or []
    return items[0] if items else None


def update_item(board_id, item_id, column_values, token):
    mutation = """
    mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) {
        id
      }
    }
  """
    return monday_api(mutation, {
        "boardId": str(board_id),
        "itemId":  str(item_id),
        "values":  to_json(column_values),
    }, token)


def safe_json_parse(value):
    if not value or not isinstance(value, str):
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


def get_column_value(column_values, column_id):
    if not column_id:
        return ""
    col = next((c for c in column_values or [] if c.get("id") == column_id), None)
    if not col:
        return ""

    text = (col.get("text") or "").strip()
    if text:
        return text

    # Some column types leave `text` empty but expose the data in `value` as JSON.
    parsed = safe_json_parse(col.get("value"))
    if isinstance(parsed, dict):
        candidate = parsed.get("text") or parsed.get("value") or parsed.get("label") or parsed.get("name")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    if isinstance(parsed, str) and parsed.strip():
        return parsed.strip()
    return ""


def make_location_value(addr, address):
    """monday's location column accepts lat/lng/address plus object-typed
    country/city/street ({long_name, short_name}); plain strings are rejected."""
    if not addr or not addr.get("latitude") or not addr.get("longitude"):
        return None

    value = {
        "lat": float(addr["latitude"]),
        "lng": float(addr["longitude"]),
        "address": address or "",
    }

    def component(name):
        return {"long_name": name, "short_name": name}

    if addr.get("country"):
        value["country"] = component(addr["country"])
    if addr.get("city"):
        value["city"] = component(addr["city"])
    if addr.get("address_line_1"):
        value["street"] = component(addr["address_line_1"])
    return value
