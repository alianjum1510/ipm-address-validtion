# HERE Geocoding — a port of the here() provider in here.py.
import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from decimal import ROUND_HALF_UP, Decimal

HERE_GEOCODE_URL = "https://geocode.search.hereapi.com/v1/geocode"

COUNTRY_CODES = {
    "deutschland": "DEU", "germany": "DEU", "niederlande": "NLD", "netherlands": "NLD",
    "nederland": "NLD", "luxemburg": "LUX", "luxembourg": "LUX", "österreich": "AUT",
    "austria": "AUT", "schweiz": "CHE", "belgien": "BEL", "frankreich": "FRA",
}

# HERE returns German state names with lang=de; the client sheet uses these English ones.
STATE_EN = {
    "Bayern": "Bavaria", "Sachsen": "Saxony", "Nordrhein-Westfalen": "North Rhine-Westphalia",
    "Niedersachsen": "Lower Saxony", "Hessen": "Hesse", "Rheinland-Pfalz": "Rhineland-Palatinate",
    "Sachsen-Anhalt": "Saxony-Anhalt", "Thüringen": "Thuringia",
    "Baden-Württemberg": "Baden-Württemberg", "Berlin": "Berlin", "Brandenburg": "Brandenburg",
    "Bremen": "Bremen", "Hamburg": "Hamburg", "Mecklenburg-Vorpommern": "Mecklenburg-Vorpommern",
    "Saarland": "Saarland", "Schleswig-Holstein": "Schleswig-Holstein",
}

# DE/AT/CH/BE/LU (4–5 digits) or NL ("6442" / "6442 PB").
POSTCODE_RE = re.compile(r"[0-9]{4,5}|[0-9]{4}\s?[A-Za-z]{2}")


def country_code_for(country_name):
    return COUNTRY_CODES.get(str(country_name or "").strip().lower(), "")


def coord(v):
    if v is None or v == "" or isinstance(v, bool):
        return ""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return ""
    if not math.isfinite(n):
        return ""
    # Half away from zero on the exact value, like JavaScript's toFixed(4).
    return str(Decimal(n).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def parse_full_address(text):
    """Turn a Full Address into a HERE query.

    The client sheet format 'street, [house], postcode, city, district, state, country'
    is parsed like here.py does, so HERE gets a clean 'street, postcode city' query.
    Anything else is sent to HERE as free text.
    """
    raw = str(text or "").strip()
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    cc = country_code_for(parts[-1] if parts else "")

    if len(parts) >= 6 and POSTCODE_RE.fullmatch(parts[-5]):
        postcode = parts[-5]
        city = parts[-4]
        street = " ".join(parts[:-5])  # 'Urmonderbaan, 22' -> 'Urmonderbaan 22'

        # Dutch postcode split: '6442' + 'Pb Brunssum' -> '6442 PB' + 'Brunssum'
        m = re.fullmatch(r"([A-Za-z]{2})\s+(.+)", city)
        if cc == "NLD" and re.fullmatch(r"[0-9]{4}", postcode) and m:
            postcode = f"{postcode} {m.group(1).upper()}"
            city = m.group(2)
        return {"query": f"{street}, {postcode} {city}", "postcode": postcode, "cc": cc}

    return {"query": raw, "postcode": "", "cc": cc}


def postcodes_match(user_postcode, here_postcode):
    """Postcodes match when equal ignoring spaces/case. A Dutch 4-digit postcode also
    matches HERE's full form ('6442' vs '6442 PB')."""
    def norm(s):
        return re.sub(r"\s+", "", str(s or "")).upper()

    u = norm(user_postcode)
    h = norm(here_postcode)
    if not u or not h:
        return False
    return u == h or bool(re.fullmatch(r"[0-9]{4}", u) and re.fullmatch(u + r"[A-Z]{2}", h))


def _score(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def map_here_item(item):
    """Map a HERE result item to the board's fields (same mapping as here.py)."""
    ad = item.get("address") or {}
    pos = item.get("position") or {}
    scoring = item.get("scoring") or {}
    return {
        "address_line_1": " ".join(p for p in (ad.get("street"), ad.get("houseNumber")) if p),
        "postcode":  ad.get("postalCode") or "",
        "city":      ad.get("city") or "",
        "district":  ad.get("county") or "",
        "state":     STATE_EN.get(ad.get("state")) or ad.get("state") or "",
        "country":   ad.get("countryName") or "",
        "latitude":  coord(pos.get("lat")),
        "longitude": coord(pos.get("lng")),
        "label":     ad.get("label") or "",
        "note": f"{item.get('resultType') or ''} {item.get('houseNumberType') or ''}, "
                f"score {_score(scoring.get('queryScore'))}".strip(),
    }


def geocode(query, country_code=None):
    """Returns the mapped top result, or None when HERE finds nothing.

    Raises on HTTP errors (bad key, quota, outage) so they surface as real errors
    instead of being mistaken for a bad address.
    """
    api_key = os.environ.get("HERE_API_KEY")
    if not api_key:
        raise RuntimeError("Missing HERE API key. Set HERE_API_KEY env var.")

    params = {"q": query, "limit": "1", "lang": "de", "apiKey": api_key}
    if country_code:
        params["in"] = f"countryCode:{country_code}"

    url = f"{HERE_GEOCODE_URL}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=10) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HERE API error: HTTP {err.code} {body[:200]}") from None

    items = data.get("items") or []
    return map_here_item(items[0]) if items else None
