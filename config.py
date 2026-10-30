# Per-board column IDs and status labels. monday regenerates column IDs when a
# board is duplicated, so each board needs its own mapping.
import os


def _env(name, default=None):
    return os.environ.get(name) or default


BOARDS = {
    # Address Master Board (original). IDs can be overridden with the same COLUMN_*
    # env vars the previous version used; the live app sets COLUMN_LOCATION_ID.
    "5063711037": {
        "columns": {
            "full_address":   _env("COLUMN_FULL_ADDRESS_ID", "text_mkw9pw3m"),     # Vollständige Adresse (legal)
            "address_line_1": _env("COLUMN_ADDRESS_LINE_1_ID", "text_mkw9v8an"),   # Adresszeile 1 (Legal)
            "postcode":       _env("COLUMN_POSTCODE_ID", "text_mkxqtbr0"),         # Postleitzahl (legal)
            "city":           _env("COLUMN_CITY_ID", "text_mkyw1a7a"),             # Ort
            "district":       _env("COLUMN_DISTRICT_ID", "text_mkx4mpvc"),         # Landkreis / Kreis (legal)
            "state":          _env("COLUMN_STATE_ID", "text_mkx5m5c3"),            # Bundesland (legal)
            "country":        _env("COLUMN_COUNTRY_ID", "text_mkywm44h"),          # Land
            "latitude":       _env("COLUMN_LATITUDE_ID", "numeric_mkw9x7h5"),      # Breitengrad (legal)
            "longitude":      _env("COLUMN_LONGITUDE_ID", "numeric_mkw94cck"),     # Längengrad (legal)
            "location":       _env("COLUMN_LOCATION_ID"),                          # Location (set via env on monday)
            "status":         _env("COLUMN_STATUS_ID", "color_mm0851fj"),          # Match Zipcode
        },
        "labels": {
            "done":  _env("DONE_STATUS_LABEL", "Done"),
            "stuck": _env("STUCK_STATUS_LABEL", "Stuck"),
        },
    },
    # Address Master Board (replica)
    "5090777446": {
        "columns": {
            "full_address":   "text_mkzzbqtq",    # Vollständige Adresse          — TRIGGER (mode "address")
            "address_line_1": "text_mkzzhve4",    # Adresszeile 1                 — TRIGGER (mode "fields")
            "postcode":       "text_mkzzxn2",     # Postcode                      — TRIGGER (mode "fields")
            "city":           "text_mkzza1ky",    # Ort
            "district":       "text_mm00ck6x",    # Landkreis / Kreis
            "state":          "text_mm00gat6",    # Bundesland
            "country":        "text_mm002s0c",    # Land
            "latitude":       "text_mm00sfst",    # Breitengrad
            "longitude":      "text_mm00m1qf",    # Längengrad
            "location":       "location_mm4s5wm1",
            "status":         "color_mm00ymfp",   # Address Check
        },
        "labels": {"done": "Complete", "stuck": "Stuck"},
    },
}

# Board used when an item's board isn't in the map.
DEFAULT_BOARD_ID = _env("DEFAULT_BOARD_ID", "5063711037")


def get_board_config(board_id):
    return BOARDS.get(str(board_id)) or BOARDS[DEFAULT_BOARD_ID]


# Column IDs are globally unique in monday, so these lists can span boards.
ADDRESS_TRIGGER_IDS = [b["columns"]["full_address"] for b in BOARDS.values()]
FIELD_TRIGGER_IDS = [
    col for b in BOARDS.values()
    for col in (b["columns"]["address_line_1"], b["columns"]["postcode"])
]

# Fields that must be filled for the status to be Done/Complete.
REQUIRED_FIELDS = [
    {"key": "address_line_1", "label": "Adresszeile 1"},
    {"key": "postcode",       "label": "Postcode"},
    {"key": "city",           "label": "Ort"},
    {"key": "country",        "label": "Land"},
]
