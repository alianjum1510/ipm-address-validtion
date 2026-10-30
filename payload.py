# Payload/token parsing for monday automations and webhooks.
# Carried over from the previous version (prev_version_Google_API.zip), which already
# handles the different shapes monday Code, integration recipes and webhooks send.
import base64
import json
import os
import re

from monday import safe_json_parse


def _get(obj, key):
    return obj.get(key) if isinstance(obj, dict) else None


def normalize_id(value):
    if value is None or value == "":
        return None
    return str(value)


def first_id(v):
    if v is None or v == "":
        return None
    if isinstance(v, list):
        first = next((x for x in v if x is not None and x != ""), None)
        if first is None:
            return None
        return _get(first, "id") if isinstance(first, (dict, list)) else first
    if isinstance(v, dict):
        return v.get("id")
    return v


def payload_sources(payload):
    nested = _get(payload, "payload")
    parsed = safe_json_parse(nested) or (nested if isinstance(nested, dict) else {})
    return [
        payload or {},
        _get(payload, "event") or {},
        _get(payload, "inputFields") or {},
        _get(payload, "inboundFieldValues") or {},
        parsed or {},
        _get(payload, "body") or {},
    ]


def find_key(src, keys):
    if not isinstance(src, dict):
        return None
    for k in keys:
        if k not in src:
            continue
        found = first_id(src[k])
        if found is not None:
            return found
    return None


def extract_ids_from_payload(payload):
    board_keys = ["boardId", "board_id", "board", "boardID", "boardid", "boardIds", "board_ids"]
    item_keys = ["itemId", "item_id", "pulseId", "pulse_id", "pulse", "item", "itemID", "itemid",
                 "pulseIds", "pulse_ids", "itemIds", "item_ids"]

    board_id = None
    item_id = None
    for src in payload_sources(payload):
        if board_id is None:
            board_id = find_key(src, board_keys)
        if item_id is None:
            item_id = find_key(src, item_keys)
        if board_id is not None and item_id is not None:
            break

    return {"boardId": normalize_id(board_id), "itemId": normalize_id(item_id)}


def extract_changed_column_ids(payload):
    column_keys = ["columnId", "column_id", "column", "column_ids", "columnIdList"]
    found = {}  # dict keeps insertion order, like a JS Set

    for src in payload_sources(payload):
        if not isinstance(src, dict):
            continue
        for k in column_keys:
            if k not in src:
                continue
            val = first_id(src[k])
            if val is not None:
                found[str(val)] = True
    return [c for c in found if c]


def decode_jwt_payload(jwt):
    """Decode a JWT's payload without verifying it. monday wraps the usable API
    token (shortLivedToken) inside an outer JWT."""
    parts = jwt.split(".") if isinstance(jwt, str) else []
    if len(parts) != 3:
        return None
    try:
        segment = parts[1].replace("-", "+").replace("_", "/")
        segment += "=" * (-len(segment) % 4)
        return json.loads(base64.b64decode(segment).decode("utf-8", errors="replace"))
    except ValueError:
        return None


def resolve_api_token(token_string):
    if not isinstance(token_string, str) or not token_string.strip():
        return None
    raw = re.sub(r"^Bearer\s+", "", token_string, flags=re.IGNORECASE).strip()
    claims = decode_jwt_payload(raw)
    short_lived = _get(claims, "shortLivedToken")
    if isinstance(short_lived, str) and short_lived.strip():
        return short_lived.strip()
    return raw


def find_token_in_object(obj):
    if not isinstance(obj, dict):
        return None
    keys = ["shortLivedToken", "shortlivedtoken", "short_lived_token", "monday_api_token",
            "mondayApiToken", "sessionToken", "session_token", "token", "authorization", "Authorization"]
    for k in keys:
        if isinstance(obj.get(k), str) and obj[k].strip():
            return resolve_api_token(obj[k])
    return None


def get_token(payload, context):
    """Prefer MONDAY_API_TOKEN: a personal token has full account scopes, whereas the
    short-lived token monday sends only has the app's granted scopes."""
    env_token = os.environ.get("MONDAY_API_TOKEN")
    if env_token and env_token.strip():
        return resolve_api_token(env_token)
    return (
        find_token_in_object(context)
        or find_token_in_object(_get(context, "payload"))
        or find_token_in_object(payload)
        or find_token_in_object(_get(payload, "inputFields"))
        or find_token_in_object(_get(payload, "payload"))
    )


def normalize_action_payload(payload):
    if not isinstance(payload, dict):
        return payload

    parsed_payload = safe_json_parse(payload.get("payload"))
    parsed_body = safe_json_parse(payload.get("body"))
    nested_payload = parsed_payload if isinstance(parsed_payload, dict) else (
        payload.get("payload") if isinstance(payload.get("payload"), dict) else None)
    nested_body = parsed_body if isinstance(parsed_body, dict) else (
        payload.get("body") if isinstance(payload.get("body"), dict) else None)

    if not nested_payload and not nested_body:
        return payload
    return {
        **payload,
        **(nested_payload or {}),
        "payload": nested_payload or payload.get("payload"),
        "body": nested_body or payload.get("body"),
    }


def looks_like_payload(obj):
    if not isinstance(obj, dict):
        return False
    return any(k in obj for k in ["inboundFieldValues", "inputFields", "payload", "event", "itemId",
                                  "pulseId", "boardId", "columnId", "challenge"])


def resolve_action_args(arg_a=None, arg_b=None):
    """monday Code calls action(payload, context); the HTTP server calls
    action(context, payload). Work out which is which by content."""
    a = arg_a or {}
    b = arg_b or {}

    if looks_like_payload(a) and not looks_like_payload(b):
        return {"context": b, "payload": a}
    if looks_like_payload(b) and not looks_like_payload(a):
        return {"context": a, "payload": b}
    if isinstance(_get(a, "payload"), dict):
        return {"context": a, "payload": a["payload"]}
    if isinstance(_get(b, "payload"), dict):
        return {"context": b, "payload": b["payload"]}
    if b:
        return {"context": a, "payload": b}
    return {"context": b, "payload": a}
