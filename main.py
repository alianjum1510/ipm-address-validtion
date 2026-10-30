import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def load_local_env():
    env_path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(env_path):
        return

    with open(env_path, encoding="utf-8") as f:
        for line in f.read().splitlines():
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#"):
                continue
            if "=" not in trimmed:
                continue
            key, value = trimmed.split("=", 1)
            key, value = key.strip(), value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            if key and not os.environ.get(key):
                os.environ[key] = value


# Before importing config: it reads COLUMN_* env vars at import time.
load_local_env()

import here_api as here  # noqa: E402
from config import ADDRESS_TRIGGER_IDS, FIELD_TRIGGER_IDS, REQUIRED_FIELDS, get_board_config  # noqa: E402
from monday import get_column_value, get_item_data, make_location_value, to_json, update_item  # noqa: E402
from payload import (  # noqa: E402
    extract_changed_column_ids,
    extract_ids_from_payload,
    get_token,
    normalize_action_payload,
    normalize_id,
    resolve_action_args,
)

PORT = int(os.environ.get("PORT") or 8080)

# Two run modes:
#   "address" — Full Address changed: geocode it and fill Address Line 1, Postcode
#               and every other field. Full Address itself is never overwritten.
#   "fields"  — Address Line 1 or Postcode changed: geocode those two, check HERE
#               agrees on the postcode, then refresh the other fields and Full
#               Address. Address Line 1 and Postcode themselves are never overwritten.
ALL_TRIGGER_IDS = [*ADDRESS_TRIGGER_IDS, *FIELD_TRIGGER_IDS]

# Output fields written in each mode (keys of the board's column map).
ADDRESS_MODE_FIELDS = ["address_line_1", "postcode", "city", "district", "state", "country", "latitude", "longitude"]
FIELDS_MODE_FIELDS = ["city", "district", "state", "country", "latitude", "longitude", "full_address"]


def log(message):
    print(message, flush=True)


# ---------- loop guard ----------
# The app writes to trigger columns (mode "address" writes Address Line 1 and
# Postcode; mode "fields" writes Full Address), and monday fires the automation
# again for those writes. monday's action block doesn't say which column changed,
# so after each write we remember the item's trigger-column values and ignore an
# event when none of them has changed since. Writes are also diff-only, so even if
# this memory is lost (restart, second instance) the echo run finds nothing to
# change and the chain stops.
SELF_WRITE_TTL_S = 2 * 60
recent_writes = {}  # item_id -> {"values": {column_id: value}, "at": monotonic seconds}
_recent_writes_lock = threading.Lock()


def trigger_columns(cols):
    return [c for c in (cols["full_address"], cols["address_line_1"], cols["postcode"]) if c]


def remember_writes(item, cols, updates):
    values = {}
    for column_id in trigger_columns(cols):
        written = updates.get(column_id)
        values[column_id] = written if isinstance(written, str) else get_column_value(item["column_values"], column_id)
    with _recent_writes_lock:
        recent_writes[str(item["id"])] = {"values": values, "at": time.monotonic()}


def is_echo(item, cols):
    item_id = str(item["id"])
    with _recent_writes_lock:
        entry = recent_writes.get(item_id)
        if not entry:
            return False
        if time.monotonic() - entry["at"] > SELF_WRITE_TTL_S:
            del recent_writes[item_id]
            return False
    return all(entry["values"].get(c) == get_column_value(item["column_values"], c) for c in trigger_columns(cols))


# ---------- helpers ----------

def get_missing_fields(addr):
    return [
        field["label"] for field in REQUIRED_FIELDS
        if not (addr or {}).get(field["key"]) or str(addr[field["key"]]).strip() == ""
    ]


def compose_full_address(addr):
    """Same order as the client sheet: street, postcode, city, district, state, country."""
    parts = [(addr.get(k) or "").strip() for k in ("address_line_1", "postcode", "city", "district", "state", "country")]
    return ", ".join(p for p in parts if p)


def resolve_mode(changed_ids, item, cols, forced_mode=None):
    """Decide which mode this event is. Returns None to skip.

    forced_mode comes from the URL the automation block calls (/action/address or
    /action/fields), since monday's action block payload has no column ID.
    """
    if forced_mode:
        return forced_mode
    if cols["full_address"] in changed_ids:
        return "address"
    if cols["address_line_1"] in changed_ids or cols["postcode"] in changed_ids:
        return "fields"
    if changed_ids:
        return None  # a trigger column, but not on this item's board

    # No column ID and no mode in the URL (the existing /action block): go by what's filled.
    values = item["column_values"]
    has_fields = get_column_value(values, cols["address_line_1"]) and get_column_value(values, cols["postcode"])
    if has_fields:
        return "fields"
    if get_column_value(values, cols["full_address"]):
        return "address"
    return "fields"  # nothing filled — ends as Stuck with a clear reason


def build_updates(item, board, addr, field_keys, is_complete):
    """Build a diff-only column update: unchanged values are left out."""
    cols = board["columns"]
    updates = {}

    for key in field_keys:
        column_id = cols.get(key)
        value = addr.get(key)
        if not column_id or not value:
            continue
        if get_column_value(item["column_values"], column_id) == value:
            continue
        updates[column_id] = value

    if cols.get("location") and updates:
        location = make_location_value(addr, addr.get("label") or compose_full_address(addr))
        if location:
            updates[cols["location"]] = location

    label = board["labels"]["done"] if is_complete else board["labels"]["stuck"]
    if get_column_value(item["column_values"], cols["status"]) != label:
        updates[cols["status"]] = {"label": label}

    return updates


def write_updates(item, board_id, board, updates, token):
    if not updates:
        return []
    remember_writes(item, board["columns"], updates)  # before the write: monday may fire the echo before we get the response
    update_item(board_id, item["id"], updates, token)
    return list(updates)


def mark_stuck(item, board_id, board, reason, mode, token):
    log(f"Item {item['id']} [{mode}]: Stuck — {reason}")
    written = write_updates(item, board_id, board, build_updates(item, board, {}, [], False), token)
    return {"itemId": str(item["id"]), "mode": mode, "isComplete": False, "reason": reason, "written": written}


def finish(item, board_id, board, addr, field_keys, mode, token):
    missing = get_missing_fields(addr)
    is_complete = not missing
    updates = build_updates(item, board, addr, field_keys, is_complete)
    written = write_updates(item, board_id, board, updates, token)

    status = "Complete" if is_complete else f"Stuck — missing: {', '.join(missing)}"
    log(f"Item {item['id']} [{mode}]: {status} ({addr.get('note')}; {len(written)} column(s) written)")
    return {"itemId": str(item["id"]), "mode": mode, "isComplete": is_complete, "missing": missing,
            "geo": addr, "written": written}


# ---------- the two modes ----------

def process_from_address(item, board_id, board, token):
    """Mode "address": Full Address → fill everything else."""
    cols = board["columns"]
    full_address = get_column_value(item["column_values"], cols["full_address"])
    if not full_address:
        return mark_stuck(item, board_id, board, "Full Address is empty", "address", token)

    parsed = here.parse_full_address(full_address)
    in_cc = f" in {parsed['cc']}" if parsed["cc"] else ""
    log(f"Item {item['id']} [address]: HERE query \"{parsed['query']}\"{in_cc}")

    addr = here.geocode(parsed["query"], parsed["cc"])
    if not addr:
        return mark_stuck(item, board_id, board, f'HERE found no match for "{full_address}"', "address", token)

    if parsed["postcode"] and not here.postcodes_match(parsed["postcode"], addr["postcode"]):
        return mark_stuck(
            item, board_id, board,
            f"Postcode mismatch — Full Address has {parsed['postcode']} but HERE says "
            f"{addr['postcode'] or 'none'} ({addr['label']})",
            "address", token)

    return finish(item, board_id, board, addr, ADDRESS_MODE_FIELDS, "address", token)


def process_from_fields(item, board_id, board, token):
    """Mode "fields": Address Line 1 + Postcode → refresh everything else."""
    cols = board["columns"]
    address_line_1 = get_column_value(item["column_values"], cols["address_line_1"])
    postcode = get_column_value(item["column_values"], cols["postcode"])

    if not address_line_1 or not postcode:
        return mark_stuck(item, board_id, board, "Address Line 1 or Postcode is empty", "fields", token)

    # The current Land column (filled by an earlier run) narrows the search to that country.
    cc = here.country_code_for(get_column_value(item["column_values"], cols["country"]))
    query = f"{address_line_1}, {postcode}"
    in_cc = f" in {cc}" if cc else ""
    log(f"Item {item['id']} [fields]: HERE query \"{query}\"{in_cc}")

    addr = here.geocode(query, cc)
    if not addr:
        return mark_stuck(item, board_id, board, f'HERE found no match for "{query}"', "fields", token)

    if not here.postcodes_match(postcode, addr["postcode"]):
        return mark_stuck(
            item, board_id, board,
            f"Postcode mismatch — you entered {postcode} but HERE says {addr['postcode'] or 'none'} ({addr['label']})",
            "fields", token)

    addr["full_address"] = compose_full_address(addr)
    return finish(item, board_id, board, addr, FIELDS_MODE_FIELDS, "fields", token)


# ---------- entry point ----------

def action(arg_a=None, arg_b=None):
    """monday Code invokes action(payload, context); the local HTTP server invokes
    action(context, payload). resolve_action_args works out which is which."""
    resolved = resolve_action_args(arg_a, arg_b)
    payload = normalize_action_payload(resolved["payload"])
    context = resolved["context"]
    token = get_token(payload, context)
    if not token:
        raise RuntimeError("Missing monday API token. Set MONDAY_API_TOKEN or send a shortLivedToken.")

    changed = extract_changed_column_ids(payload)
    if changed and not any(c in ALL_TRIGGER_IDS for c in changed):
        return {"success": True, "skipped": True, "reason": f"Column {', '.join(changed)} is not a trigger column."}

    ids = extract_ids_from_payload(payload)
    item_id = ids["itemId"]
    if not item_id:
        return {"success": False, "skipped": True, "reason": "No item ID in payload. Use an item-scoped trigger."}

    item = get_item_data(item_id, token)
    if not item:
        raise RuntimeError(f"Item {item_id} not found.")

    board_id = normalize_id((item.get("board") or {}).get("id") or ids["boardId"])
    board = get_board_config(board_id)

    forced_mode = context.get("mode") if isinstance(context, dict) else None
    mode = resolve_mode(changed, item, board["columns"], forced_mode)
    if not mode:
        return {"success": True, "skipped": True,
                "reason": f"Column {', '.join(changed)} does not belong to board {board_id}."}

    if is_echo(item, board["columns"]):
        log(f"Item {item['id']} [{mode}]: ignoring — no address input changed since this app's last write.")
        return {"success": True, "skipped": True, "reason": "Change was written by this app."}

    if mode == "address":
        result = process_from_address(item, board_id, board, token)
    else:
        result = process_from_fields(item, board_id, board, token)

    return {"success": True, "boardId": board_id, **result}


# ---------- HTTP server ----------

def mode_from_path(url):
    """Each automation block calls its own URL:
      .../action/address  → Full Address mode
      .../action/fields   → Address Line 1 / Postcode mode
      anything else       → auto (the existing ".../action" block)
    """
    pathname = str(url or "").split("?")[0].rstrip("/")
    if pathname.endswith("/address"):
        return "address"
    if pathname.endswith("/fields"):
        return "fields"
    return None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, code, data):
        self._send(code, to_json(data), "application/json")

    # Health check on any GET — monday Code probes the root path.
    def do_GET(self):
        self._send(200, "OK", "text/plain")

    # Accept the automation/webhook POST on any path.
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else ""
            try:
                payload = json.loads(body) if body else {}
            except ValueError:
                raise RuntimeError("Invalid JSON") from None

            if isinstance(payload, dict) and payload.get("challenge"):
                self._send_json(200, {"challenge": payload["challenge"]})
                return
            context = {"token": self.headers.get("Authorization") or None, "mode": mode_from_path(self.path)}
            log(f"Incoming POST {self.path} (mode: {context['mode'] or 'auto'})")
            self._send_json(200, action(context, payload))
        except Exception as err:
            print(f"Error: {err}", file=sys.stderr, flush=True)
            self._send_json(500, {"success": False, "error": str(err)})

    def _not_found(self):
        self._send_json(404, {"success": False, "error": "Not found"})

    do_PUT = do_PATCH = do_DELETE = _not_found

    def log_message(self, format, *args):
        pass  # requests are logged by do_POST


def create_server(port=PORT):
    return ThreadingHTTPServer(("", port), Handler)


if __name__ == "__main__":
    server = create_server()
    log(f"HERE Address Enrichment running on port {PORT}")
    server.serve_forever()
