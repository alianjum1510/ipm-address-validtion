# End-to-end tests with monday and HERE stubbed via urllib.request.urlopen.
# Run: python3 -m unittest discover -s test
import copy
import http.client
import json
import os
import sys
import threading
import unittest
import urllib.parse
import urllib.request
from unittest import mock

os.environ["MONDAY_API_TOKEN"] = "test-token"
os.environ["HERE_API_KEY"] = "test-key"
os.environ["COLUMN_LOCATION_ID"] = "location_original_board"  # set on monday for the original board

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import main as app  # noqa: E402
import here_api as here  # noqa: E402
from config import BOARDS  # noqa: E402

BOARD_ID = "5090777446"
C = BOARDS[BOARD_ID]["columns"]

HERE_BORSIG = {
    "title": "Borsigstraße 15, 51381 Leverkusen, Deutschland",
    "resultType": "houseNumber",
    "houseNumberType": "PA",
    "address": {
        "label": "Borsigstraße 15, 51381 Leverkusen, Deutschland",
        "countryCode": "DEU", "countryName": "Deutschland",
        "state": "Nordrhein-Westfalen", "county": "Leverkusen", "city": "Leverkusen",
        "street": "Borsigstraße", "postalCode": "51381", "houseNumber": "15",
    },
    "position": {"lat": 51.0456789, "lng": 7.0123456},
    "scoring": {"queryScore": 1},
}

FULL = "Borsigstraße 15, 51381 Leverkusen, Deutschland"

# ---------- fake monday board + HERE ----------
item = None
mutations = []
here_queries = []


def new_item(values, board_id=BOARD_ID):
    global item, mutations, here_queries
    item = {
        "id": "111",
        "name": "Test",
        "board": {"id": board_id},
        "column_values": [{"id": cid, "text": values.get(cid, ""), "value": None, "type": "text"}
                          for cid in BOARDS[board_id]["columns"].values() if cid],
    }
    mutations = []
    here_queries = []
    app.recent_writes.clear()


class FakeResponse:
    def __init__(self, data):
        self.status = 200
        self._body = json.dumps(data).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_urlopen(req, timeout=None):
    url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
    if url.startswith("https://geocode.search.hereapi.com"):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        q = params.get("q", [None])[0]
        here_queries.append({"q": q, "in": params.get("in", [None])[0]})
        return FakeResponse({"items": [HERE_BORSIG] if "borsig" in q.lower() else []})
    if url == "https://api.monday.com/v2":
        body = json.loads(req.data.decode("utf-8"))
        if "change_multiple_column_values" in body["query"]:
            values = json.loads(body["variables"]["values"])
            mutations.append(values)
            for cid, v in values.items():
                col = next(c for c in item["column_values"] if c["id"] == cid)
                col["text"] = v if isinstance(v, str) else (v.get("label") or v.get("address") or "")
            return FakeResponse({"data": {"change_multiple_column_values": {"id": item["id"]}}})
        return FakeResponse({"data": {"items": [copy.deepcopy(item)]}})
    raise AssertionError(f"unexpected request {url}")


def event(column_id):
    return {"event": {"pulseId": int(item["id"]), "boardId": int(BOARD_ID), "columnId": column_id}}


def text(cid):
    return next(c for c in item["column_values"] if c["id"] == cid)["text"]


def set_text(cid, value):
    next(c for c in item["column_values"] if c["id"] == cid)["text"] = value


def block_payload(board_id=BOARD_ID):
    """monday action block (what the live app receives): only boardId + itemId, no
    column ID, so the mode comes from the URL the block calls."""
    return {
        "payload": {
            "blockKind": "action",
            "inboundFieldValues": {"boardId": int(board_id), "itemId": int(item["id"])},
            "inputFields": {"boardId": int(board_id), "itemId": int(item["id"])},
            "recipeId": 1, "integrationId": 2,
        },
        "runtimeMetadata": {"actionUuid": "x"},
    }


class StubbedTestCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("urllib.request.urlopen", fake_urlopen)
        patcher.start()
        self.addCleanup(patcher.stop)
        log_patcher = mock.patch.object(app, "log")  # keep test output quiet
        log_patcher.start()
        self.addCleanup(log_patcher.stop)


# ---------- parsing (same cases as here.py) ----------

class ParsingTests(unittest.TestCase):
    def test_parse_full_address_client_sheet_format(self):
        self.assertEqual(
            here.parse_full_address("Boschstraat 10, 6442, Pb Brunssum, Brunssum, Limburg, Niederlande"),
            {"query": "Boschstraat 10, 6442 PB Brunssum", "postcode": "6442 PB", "cc": "NLD"})
        self.assertEqual(
            here.parse_full_address("Urmonderbaan, 22, 6167, Rd Sittard-Geleen, Sittard-Geleen, Limburg, Niederlande"),
            {"query": "Urmonderbaan 22, 6167 RD Sittard-Geleen", "postcode": "6167 RD", "cc": "NLD"})
        self.assertEqual(
            here.parse_full_address("Borsigstraße 15, 51381, Leverkusen, Leverkusen, North Rhine-Westphalia, Deutschland"),
            {"query": "Borsigstraße 15, 51381 Leverkusen", "postcode": "51381", "cc": "DEU"})

    def test_parse_full_address_free_text_fallback(self):
        self.assertEqual(
            here.parse_full_address(FULL),
            {"query": FULL, "postcode": "", "cc": "DEU"})

    def test_postcodes_match(self):
        self.assertTrue(here.postcodes_match("51381", "51381"))
        self.assertTrue(here.postcodes_match("6442 pb", "6442PB"))
        self.assertTrue(here.postcodes_match("6442", "6442 PB"))
        self.assertFalse(here.postcodes_match("5138", "51381"))
        self.assertFalse(here.postcodes_match("51380", "51381"))

    def test_map_here_item(self):
        m = here.map_here_item(HERE_BORSIG)
        self.assertEqual(m["address_line_1"], "Borsigstraße 15")
        self.assertEqual(m["district"], "Leverkusen")
        self.assertEqual(m["state"], "North Rhine-Westphalia")
        self.assertEqual(m["country"], "Deutschland")
        self.assertEqual(m["latitude"], "51.0457")
        self.assertEqual(m["longitude"], "7.0123")
        self.assertEqual(m["note"], "houseNumber PA, score 1")

    def test_coord_rounds_like_js_to_fixed(self):
        self.assertEqual(here.coord(1.03125), "1.0313")    # exact tie: half away from zero
        self.assertEqual(here.coord(-1.03125), "-1.0313")
        self.assertEqual(here.coord("52.5"), "52.5000")
        self.assertEqual(here.coord(""), "")
        self.assertEqual(here.coord(None), "")
        self.assertEqual(here.coord("abc"), "")


# ---------- trigger flow ----------

class TriggerFlowTests(StubbedTestCase):
    def test_full_address_fills_every_field(self):
        new_item({C["full_address"]: FULL})
        r = app.action(event(C["full_address"]), {})

        self.assertEqual(r["mode"], "address")
        self.assertIs(r["isComplete"], True)
        self.assertEqual(text(C["address_line_1"]), "Borsigstraße 15")
        self.assertEqual(text(C["postcode"]), "51381")
        self.assertEqual(text(C["city"]), "Leverkusen")
        self.assertEqual(text(C["state"]), "North Rhine-Westphalia")
        self.assertEqual(text(C["latitude"]), "51.0457")
        self.assertEqual(text(C["status"]), "Complete")
        self.assertEqual(text(C["full_address"]), FULL)
        self.assertNotIn(C["full_address"], mutations[0])
        self.assertIn(C["location"], mutations[0])

    def test_own_writes_do_not_retrigger(self):
        new_item({C["full_address"]: FULL})
        app.action(event(C["full_address"]), {})
        before = len(here_queries)

        r1 = app.action(event(C["address_line_1"]), {})
        r2 = app.action(event(C["postcode"]), {})
        self.assertIs(r1["skipped"], True)
        self.assertIs(r2["skipped"], True)
        self.assertEqual(len(here_queries), before)  # no extra HERE calls

    def test_loop_stops_after_restart(self):
        new_item({C["full_address"]: FULL})
        app.action(event(C["full_address"]), {})

        app.recent_writes.clear()  # simulate restart: echo arrives at a fresh instance
        r1 = app.action(event(C["address_line_1"]), {})
        self.assertEqual(r1["mode"], "fields")
        self.assertEqual(r1["written"], [C["full_address"], C["location"]])  # only Full Address (+ pin) gets normalised

        app.recent_writes.clear()
        r2 = app.action(event(C["full_address"]), {})
        self.assertEqual(r2["mode"], "address")
        self.assertEqual(r2["written"], [])  # nothing changed → no write → no further trigger

    def test_fields_edit_refreshes_others_not_inputs(self):
        new_item({C["address_line_1"]: "Borsigstr. 15", C["postcode"]: "51381", C["country"]: "Deutschland"})
        r = app.action(event(C["postcode"]), {})

        self.assertEqual(r["mode"], "fields")
        self.assertIs(r["isComplete"], True)
        self.assertEqual(here_queries[-1], {"q": "Borsigstr. 15, 51381", "in": "countryCode:DEU"})
        self.assertEqual(text(C["address_line_1"]), "Borsigstr. 15")  # user's input kept
        self.assertEqual(text(C["city"]), "Leverkusen")
        self.assertEqual(text(C["full_address"]),
                         "Borsigstraße 15, 51381, Leverkusen, Leverkusen, North Rhine-Westphalia, Deutschland")
        self.assertEqual(text(C["status"]), "Complete")

    def test_postcode_mismatch_is_stuck_and_writes_only_status(self):
        new_item({C["address_line_1"]: "Borsigstraße 15", C["postcode"]: "99999", C["city"]: "Old City"})
        r = app.action(event(C["postcode"]), {})

        self.assertIs(r["isComplete"], False)
        self.assertIn("Postcode mismatch", r["reason"])
        self.assertEqual(text(C["city"]), "Old City")
        self.assertEqual(text(C["status"]), "Stuck")
        self.assertEqual(list(mutations[0]), [C["status"]])

    def test_one_input_missing_is_stuck_without_here(self):
        new_item({C["address_line_1"]: "Borsigstraße 15"})
        r = app.action(event(C["address_line_1"]), {})
        self.assertIs(r["isComplete"], False)
        self.assertEqual(text(C["status"]), "Stuck")
        self.assertEqual(len(here_queries), 0)

    def test_here_no_match_is_stuck(self):
        new_item({C["full_address"]: "asdfgh qwerty"})
        r = app.action(event(C["full_address"]), {})
        self.assertIn("no match", r["reason"])
        self.assertEqual(text(C["status"]), "Stuck")

    def test_non_trigger_column_skipped(self):
        new_item({})
        r = app.action(event(C["city"]), {})
        self.assertIs(r["skipped"], True)
        self.assertEqual(len(mutations), 0)

    def test_no_column_id_uses_full_address(self):
        new_item({C["full_address"]: FULL})
        r = app.action({"event": {"pulseId": 111, "boardId": int(BOARD_ID)}}, {})
        self.assertEqual(r["mode"], "address")
        self.assertEqual(text(C["postcode"]), "51381")


# ---------- monday action block ----------

class ActionBlockTests(StubbedTestCase):
    def test_mode_from_path(self):
        self.assertEqual(app.mode_from_path("/action/address"), "address")
        self.assertEqual(app.mode_from_path("/action/fields/"), "fields")
        self.assertIsNone(app.mode_from_path("/action"))
        self.assertIsNone(app.mode_from_path("/"))

    def test_address_block_then_fields_echo_skipped(self):
        new_item({C["full_address"]: FULL})
        r1 = app.action({"mode": "address"}, block_payload())
        self.assertEqual(r1["mode"], "address")
        self.assertEqual(text(C["postcode"]), "51381")

        # monday fires the Adresszeile 1 and Postcode automations for the app's own writes
        r2 = app.action({"mode": "fields"}, block_payload())
        r3 = app.action({"mode": "fields"}, block_payload())
        self.assertIs(r2["skipped"], True)
        self.assertIs(r3["skipped"], True)
        self.assertEqual(len(here_queries), 1)

    def test_user_edits_postcode_after_population(self):
        new_item({C["full_address"]: FULL})
        app.action({"mode": "address"}, block_payload())

        set_text(C["postcode"], "99999")  # user edit
        r = app.action({"mode": "fields"}, block_payload())
        self.assertEqual(r["mode"], "fields")
        self.assertIn("Postcode mismatch", r["reason"])
        self.assertEqual(text(C["status"]), "Stuck")

    def test_user_reenters_full_address(self):
        new_item({C["full_address"]: "asdfgh qwerty"})
        app.action({"mode": "address"}, block_payload())  # Stuck, no match

        set_text(C["full_address"], FULL)
        r = app.action({"mode": "address"}, block_payload())
        self.assertEqual(r["mode"], "address")
        self.assertIs(r["isComplete"], True)
        self.assertEqual(text(C["address_line_1"]), "Borsigstraße 15")

    def test_auto_mode(self):
        new_item({C["address_line_1"]: "Borsigstraße 15", C["postcode"]: "51381", C["full_address"]: "x"})
        self.assertEqual(app.action({}, block_payload())["mode"], "fields")

        new_item({C["full_address"]: FULL})
        self.assertEqual(app.action({}, block_payload())["mode"], "address")

    def test_original_board_uses_location_env(self):
        o = BOARDS["5063711037"]["columns"]
        self.assertEqual(o["location"], "location_original_board")

        new_item({o["full_address"]: FULL}, "5063711037")
        r = app.action({"mode": "address"}, block_payload("5063711037"))
        self.assertIs(r["isComplete"], True)
        self.assertIn(o["location"], mutations[0])
        self.assertEqual(mutations[0][o["status"]], {"label": "Done"})


class HttpTests(StubbedTestCase):
    def test_post_routes_to_mode(self):
        server = app.create_server(0)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        # urlopen is patched for monday/HERE, so talk to the server with http.client
        def post(path, body):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("POST", path, json.dumps(body), {"Content-Type": "application/json"})
            data = json.loads(conn.getresponse().read())
            conn.close()
            return data

        def get(path):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", path)
            res = conn.getresponse()
            data = (res.status, res.read().decode())
            conn.close()
            return data

        self.assertEqual(get("/"), (200, "OK"))

        new_item({C["full_address"]: FULL})
        self.assertEqual(post("/action/address", block_payload())["mode"], "address")

        set_text(C["address_line_1"], "Borsigstr. 15")  # user edit
        self.assertEqual(post("/action/fields", block_payload())["mode"], "fields")

        self.assertEqual(post("/action", {"challenge": "abc"}), {"challenge": "abc"})


if __name__ == "__main__":
    unittest.main()
