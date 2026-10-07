#!/usr/bin/env python3
"""
Address fill test: HERE vs Postcode Service.

Runs every address through both APIs and writes:
    results_here.csv               Address + the 7 target columns, filled from HERE
    results_postcode_service.csv   Address + the 7 target columns, filled from Postcode Service
    fill_summary.csv               how many cells each provider filled, per column
    raw_responses/                 full JSON of every call

Target columns (from the client sheet, translated):
    Postcode (PLZ), City (Stadt), District (Bezirk / Landkreis), State (Bundesland),
    Country (Land), Latitude (Breitengrad), Longitude (Längengrad)

Usage
    export HERE_API_KEY=...
    python3 address_fill_test.py                 # uses the addresses below
    python3 address_fill_test.py addresses.txt   # or one address per line from a file
"""
import csv
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

ADDRESSES = """
Boschstraat 10, 6442, Pb Brunssum, Brunssum, Limburg, Niederlande
Franz-Josef-Strauß-Str. 1, 92237, Sulzbach-Rosenberg,  Amberg-Sulzbach, Bavaria, Deutschland
Boschstraat 10, 6442, Pb Brunssum, Brunssum, Limburg, Niederlande
Oosterveldsingel 5 K, 7558, Pj Hengelo, Hengelo, Overijssel, Niederlande
Urmonderbaan, 22, 6167, Rd Sittard-Geleen, Sittard-Geleen, Limburg, Niederlande
Horst-Kneer-Str. 1, 72589, Westerheim, Alb-Donau, Baden-Württemberg, Deutschland
Schweriner Str. 3, 19061, Schwerin-Wüstmark, Schwerin, Mecklenburg-Vorpommern, Deutschland
Borsigstraße 15, 51381, Leverkusen, Leverkusen, North Rhine-Westphalia, Deutschland
Rüdesheimer Str. 1, 15366, Neuenhagen, Markisch-Oderland, Brandenburg, Deutschland
Am Rauhen Berg 3 A, 96332, Pressig,  Kronach, Bavaria, Deutschland
Dietenbacher Straße 17, 79199, Kirchzarten,  Breisgau-Hochschwarzwald, Baden-Württemberg, Deutschland
Weilgartenstr. 19, 73765, Neuhausen A.D.F.,  Esslingen, Baden-Württemberg, Deutschland
Friedrich-Rückert-Strasse 88, 96450, Coburg-Neuses, Coburg, Bavaria, Deutschland
"""

HERE_KEY = os.environ["HERE_API_KEY"]
PCS_ID = os.environ.get("PCS_CLIENT_ID", "1177")             # public test credentials
PCS_CODE = os.environ.get("PCS_SECURE_CODE", "9SRLYBCALURPE2B")
PCS_BASE = "https://api.postcodeservice.com/de/v2"
RAW = Path("raw_responses")
RAW.mkdir(exist_ok=True)

COLUMNS = ["Postcode", "City", "District", "State", "Country", "Latitude", "Longitude"]
HEADER = ["#", "Address"] + COLUMNS + ["Note"]

COUNTRY_CODES = {
    "deutschland": "DEU", "germany": "DEU", "niederlande": "NLD", "netherlands": "NLD",
    "nederland": "NLD", "luxemburg": "LUX", "luxembourg": "LUX", "österreich": "AUT",
    "austria": "AUT", "schweiz": "CHE", "belgien": "BEL", "frankreich": "FRA",
}

# HERE returns German state names with lang=de; the client sheet uses these English ones
STATE_EN = {
    "Bayern": "Bavaria", "Sachsen": "Saxony", "Nordrhein-Westfalen": "North Rhine-Westphalia",
    "Niedersachsen": "Lower Saxony", "Hessen": "Hesse", "Rheinland-Pfalz": "Rhineland-Palatinate",
    "Sachsen-Anhalt": "Saxony-Anhalt", "Thüringen": "Thuringia",
    "Baden-Württemberg": "Baden-Württemberg", "Berlin": "Berlin", "Brandenburg": "Brandenburg",
    "Bremen": "Bremen", "Hamburg": "Hamburg", "Mecklenburg-Vorpommern": "Mecklenburg-Vorpommern",
    "Saarland": "Saarland", "Schleswig-Holstein": "Schleswig-Holstein",
}

HOUSE_RE = re.compile(r"^(.*?)[\s,]+(\d+)\s*([a-zA-Z]?)(?:\s*[-/]\s*\d+\s*[a-zA-Z]?)?$")


# ---------- parsing ----------

def parse(line):
    """'street, [house], postcode, city, district, state, country' -> dict."""
    parts = [p.strip() for p in line.split(",") if p.strip()]
    country, state, district, city, postcode = parts[-1], parts[-2], parts[-3], parts[-4], parts[-5]
    street = " ".join(parts[:-5])                    # 'Urmonderbaan, 22' -> 'Urmonderbaan 22'
    cc = COUNTRY_CODES.get(country.casefold(), "")
    # Dutch postcode split: '6442' + 'Pb Brunssum' -> '6442 PB' + 'Brunssum'
    m = re.match(r"^([A-Za-z]{2})\s+(.+)$", city)
    if cc == "NLD" and re.fullmatch(r"\d{4}", postcode) and m:
        postcode, city = f"{postcode} {m.group(1).upper()}", m.group(2)
    return {"street": street, "postcode": postcode, "city": city, "cc": cc}


# ---------- http ----------

def get(url, name, **kw):
    t = time.perf_counter()
    try:
        r = requests.get(url, timeout=60, **kw)
        status = r.status_code
        try:
            body = r.json()
        except ValueError:
            body = {"_text": r.text}
    except requests.RequestException as ex:
        status, body = 0, {"_error": str(ex)}
    params = {k: v for k, v in kw.get("params", {}).items() if k != "apiKey"}
    (RAW / f"{name}.json").write_text(json.dumps(
        {"url": url, "params": params, "status": status,
         "ms": round((time.perf_counter() - t) * 1000), "response": body},
        indent=2, ensure_ascii=False), "utf-8")
    return status, body


def find_dict(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj
        obj = list(obj.values())
    if isinstance(obj, list):
        for v in obj:
            hit = find_dict(v, key)
            if hit:
                return hit
    return None


def coord(v):
    try:
        return f"{float(v):.4f}"
    except (TypeError, ValueError):
        return ""


# ---------- providers ----------

def here(i, a):
    q = f"{a['street']}, {a['postcode']} {a['city']}"
    params = {"q": q, "limit": 1, "lang": "de", "apiKey": HERE_KEY}
    if a["cc"]:
        params["in"] = f"countryCode:{a['cc']}"
    status, body = get("https://geocode.search.hereapi.com/v1/geocode", f"{i:02d}_here", params=params)
    items = body.get("items", []) if isinstance(body, dict) else []
    if not items:
        return {"Note": f"no match (http {status})"}
    it = items[0]
    ad, pos = it.get("address", {}), it.get("position", {})
    return {
        "Postcode": ad.get("postalCode", ""),
        "City": ad.get("city", ""),
        "District": ad.get("county", ""),
        "State": STATE_EN.get(ad.get("state", ""), ad.get("state", "")),
        "Country": ad.get("countryName", ""),
        "Latitude": coord(pos.get("lat")),
        "Longitude": coord(pos.get("lng")),
        "Note": f"{it.get('resultType', '')} {it.get('houseNumberType', '')}, "
                f"score {it.get('scoring', {}).get('queryScore', '')}".strip(),
    }


def pcs_row(hit, note):
    return {
        "Postcode": str(hit.get("zipcode", "")),
        "City": hit.get("city", ""),
        "District": hit.get("district", hit.get("county", hit.get("municipality", ""))),
        "State": hit.get("state", hit.get("province", "")),
        "Country": hit.get("country", ""),
        "Latitude": coord(hit.get("latitude", hit.get("lat"))),
        "Longitude": coord(hit.get("longitude", hit.get("lng"))),
        "Note": note,
    }


def pcs(i, a):
    if a["cc"] != "DEU":
        return {"Note": "not applicable, Germany only API"}
    m = HOUSE_RE.match(a["street"])
    if not m:
        return {"Note": "no house number found"}
    street, house, letter = m.group(1).strip(" ,"), m.group(2), m.group(3)
    headers = {"X-ClientId": PCS_ID, "X-SecureCode": PCS_CODE}

    # Path A: direct validation with the given postcode
    p = {"zipcode": a["postcode"], "house_number": house, "street": street, "city": a["city"]}
    if letter:
        p["house_letter"] = letter
    status, body = get(f"{PCS_BASE}/address-validation", f"{i:02d}_pcs_1_validation", headers=headers, params=p)
    hit = find_dict(body, "zipcode") if status == 200 else None
    if hit:
        return pcs_row(hit, "validated as given")

    # Path B: street + city suggestions, then the address by street_id
    status2, body2 = get(f"{PCS_BASE}/address-suggestions", f"{i:02d}_pcs_2_suggestions",
                         headers=headers, params={"street": street, "city": a["city"]})
    sug = find_dict(body2, "street_id") if status2 == 200 else None
    if not sug:
        return {"Note": f"validation {status}, suggestions {status2}: not found"}
    p = {"street_id": sug["street_id"], "house_number": house}
    if letter:
        p["house_letter"] = letter
    status3, body3 = get(f"{PCS_BASE}/address-streetid", f"{i:02d}_pcs_3_streetid", headers=headers, params=p)
    hit = find_dict(body3, "zipcode") if status3 == 200 else None
    if not hit:
        return {"Note": f"validation {status}, street found, house number {status3}: not found"}
    return pcs_row(hit, f"validation {status}, repaired via street lookup")


# ---------- output ----------

def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=HEADER, extrasaction="ignore")
        w.writeheader()
        w.writerows({c: r.get(c, "") for c in HEADER} for r in rows)


def main():
    text = Path(sys.argv[1]).read_text("utf-8") if len(sys.argv) > 1 else ADDRESSES
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    here_rows, pcs_rows = [], []
    for i, line in enumerate(lines, 1):
        a = parse(line)
        h, p = here(i, a), pcs(i, a)
        here_rows.append({"#": i, "Address": line, **h})
        pcs_rows.append({"#": i, "Address": line, **p})
        print(f"{i:>2}. HERE: {h.get('Postcode', ''):<8} {h.get('City', ''):<22} | "
              f"PCS: {p.get('Postcode', ''):<6} {p.get('City', ''):<22} {p.get('Note', '')}")

    write_csv("results_here.csv", here_rows)
    write_csv("results_postcode_service.csv", pcs_rows)

    # fill statistics
    n = len(lines)
    summary = []
    for col in COLUMNS:
        hf = sum(1 for r in here_rows if r.get(col))
        pf = sum(1 for r in pcs_rows if r.get(col))
        summary.append({"Column": col, "HERE filled": hf, "HERE %": f"{hf / n:.0%}",
                        "Postcode Service filled": pf, "Postcode Service %": f"{pf / n:.0%}"})
    h_tot = sum(s["HERE filled"] for s in summary)
    p_tot = sum(s["Postcode Service filled"] for s in summary)
    cells = n * len(COLUMNS)
    summary.append({"Column": "TOTAL CELLS", "HERE filled": h_tot, "HERE %": f"{h_tot / cells:.0%}",
                    "Postcode Service filled": p_tot, "Postcode Service %": f"{p_tot / cells:.0%}"})
    full_h = sum(1 for r in here_rows if all(r.get(c) for c in COLUMNS))
    full_p = sum(1 for r in pcs_rows if all(r.get(c) for c in COLUMNS))
    summary.append({"Column": "ROWS FULLY FILLED", "HERE filled": full_h, "HERE %": f"{full_h / n:.0%}",
                    "Postcode Service filled": full_p, "Postcode Service %": f"{full_p / n:.0%}"})
    both = [(h, p) for h, p in zip(here_rows, pcs_rows) if h.get("Postcode") and p.get("Postcode")]
    agree = sum(1 for h, p in both if h["Postcode"] == p["Postcode"])
    summary.append({"Column": "POSTCODE AGREES (both filled)", "HERE filled": f"{agree}/{len(both)}",
                    "HERE %": f"{agree / len(both):.0%}" if both else "",
                    "Postcode Service filled": "", "Postcode Service %": ""})

    with open("fill_summary.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(summary[0].keys()))
        w.writeheader()
        w.writerows(summary)

    print(f"\n{'Column':<30}{'HERE':>12}{'Postcode Service':>20}")
    for s in summary:
        print(f"{s['Column']:<30}{str(s['HERE filled']) + ' ' + s['HERE %']:>12}"
              f"{str(s['Postcode Service filled']) + ' ' + s['Postcode Service %']:>20}")
    print(f"\n{n} addresses. Files: results_here.csv, results_postcode_service.csv, fill_summary.csv")


if __name__ == "__main__":
    main()