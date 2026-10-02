"""Local stand-in for TCGCSV so the job can be tested without network access.

Serves made-up sets, products and prices in TCGCSV's JSON shapes and writes matching
history snapshots. The numbers are synthetic and only for testing the code path.

    python tests/fixture_server.py _testdata 8765
"""

import datetime as dt
import gzip
import http.server
import json
import os
import random
import sys

TODAY = "2026-10-01"
random.seed(7)

SETS = [
    (604, "Base Set", "BS", "1999-01-09T00:00:00", False),
    (1375, "EX Deoxys", "DX", "2005-02-14T00:00:00", False),
    (1401, "DP: Majestic Dawn", "MD", "2008-05-21T00:00:00", False),
    (1481, "XY: Evolutions", "EVO", "2016-11-02T00:00:00", False),
    (2377, "SM: Cosmic Eclipse", "CEC", "2019-11-01T00:00:00", False),
    (3170, "SWSH12: Silver Tempest", "SIT", "2022-11-11T00:00:00", False),
    (23237, "SV: Prismatic Evolutions", "PRE", "2025-01-17T00:00:00", False),
    (24380, "ME01: Mega Evolution", "MEG", "2025-09-26T00:00:00", False),
    (24831, "ME06: Delta Reign", "DLR", "2026-11-06T00:00:00", False),
    (2332, "Professor Program Promos", "PPP", "2026-09-30T20:00:05.8951688Z", True),
]
NAMES = ["Charizard", "Pikachu", "Umbreon", "Rayquaza", "Lugia", "Mewtwo", "Gengar", "Eevee",
         "Gardevoir", "Greninja", "Sylveon", "Mew", "Blastoise", "Venusaur", "Dragonite", "Lucario",
         "Giratina", "Espeon", "Snorlax", "Tyranitar"]
SUFFIX = ["", " ex", " V", " VMAX", " GX", " (Full Art)", " (Secret)", " (Special Illustration Rare)"]
SEALED = ["Booster Box", "Elite Trainer Box", "Booster Bundle", "Booster Pack", "Premium Collection", "Tin", "Booster Box Case"]


def build():
    groups, products, prices, paths = [], {}, {}, {}
    pid = 100000
    for gid, name, abbr, published, supp in SETS:
        groups.append({"groupId": gid, "name": name, "abbreviation": abbr, "isSupplemental": supp,
                       "publishedOn": published, "modifiedOn": "2026-09-01T00:00:00", "categoryId": 3})
        products[gid], prices[gid] = [], []
        for i in range(60):
            pid += 1
            card = random.choice(NAMES) + random.choice(SUFFIX)
            products[gid].append({
                "productId": pid, "name": card, "cleanName": card,
                "imageUrl": f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_200w.jpg",
                "categoryId": 3, "groupId": gid,
                "url": f"https://www.tcgplayer.com/product/{pid}/x",
                "presaleInfo": {"isPresale": gid == 24831, "releasedOn": None, "note": None},
                "extendedData": [
                    {"name": "Number", "displayName": "Card Number", "value": f"{i + 1:03d}/160"},
                    {"name": "Rarity", "displayName": "Rarity", "value": random.choice(["Ultra Rare", "Holo Rare", "Secret Rare"])},
                ],
            })
            for sub in random.choice([["Normal"], ["Holofoil"], ["Holofoil", "Reverse Holofoil"]]):
                paths[(pid, sub)] = walk(random.choice([3, 8, 15, 40, 120, 400]))
        for label in SEALED:
            pid += 1
            products[gid].append({
                "productId": pid, "name": f"{name.split(': ')[-1]} {label}", "cleanName": label,
                "imageUrl": f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_200w.jpg",
                "categoryId": 3, "groupId": gid, "url": f"https://www.tcgplayer.com/product/{pid}/x",
                "presaleInfo": {"isPresale": False, "releasedOn": None, "note": None},
                "extendedData": [{"name": "UPC", "displayName": "UPC", "value": "000"}],
            })
            paths[(pid, "Normal")] = walk(random.choice([30, 60, 150, 300]))
    for (pid_, sub), series in paths.items():
        gid = next(g for g, plist in products.items() if any(p["productId"] == pid_ for p in plist))
        market = series[-1]
        prices[gid].append({"productId": pid_, "lowPrice": round(market * random.uniform(0.8, 1.05), 2),
                            "midPrice": round(market * 1.1, 2), "highPrice": round(market * 4, 2),
                            "marketPrice": market, "directLowPrice": None, "subTypeName": sub})
    return groups, products, prices, paths


def walk(base):
    """91 days of prices ending today, with one of a few shapes."""
    shape = random.choice(["flat", "flat", "climb", "spike", "dip", "drift", "noise"])
    out, p = [], base * random.uniform(0.8, 1.2)
    for day in range(91):
        step = random.gauss(0, 0.004)
        if shape == "climb":
            step += 0.004
        elif shape == "spike" and day > 83:
            step += 0.04
        elif shape == "dip" and day > 75:
            step -= 0.015
        elif shape == "drift":
            step -= 0.002
        elif shape == "noise":
            step = random.gauss(0, 0.03)
        p = max(0.25, p * (1 + step))
        out.append(round(p, 2))
    return out


def write_history(data_dir, paths):
    os.makedirs(os.path.join(data_dir, "history"), exist_ok=True)
    today = dt.date.fromisoformat(TODAY)
    for offset in [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28, 30, 35, 42, 49, 56, 63, 70, 77, 84, 90]:
        date = (today - dt.timedelta(days=offset)).isoformat()
        snap = {f"{pid}|{sub}": series[90 - offset] for (pid, sub), series in paths.items()}
        with gzip.open(os.path.join(data_dir, "history", f"{date}.json.gz"), "wt") as fh:
            json.dump(snap, fh)


def serve(port, groups, products, prices):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            parts = self.path.strip("/").split("/")
            body = None
            if self.path == "/last-updated.txt":
                body = (TODAY + "T20:00:05+0000").encode()
            elif parts[:2] == ["tcgplayer", "3"] and len(parts) == 3 and parts[2] == "groups":
                body = json.dumps({"totalItems": len(groups), "success": True, "errors": [], "results": groups}).encode()
            elif parts[:2] == ["tcgplayer", "3"] and len(parts) == 4:
                table = products if parts[3] == "products" else prices
                body = json.dumps({"success": True, "errors": [], "results": table.get(int(parts[2]), [])}).encode()
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    data_dir, port = sys.argv[1], int(sys.argv[2])
    g, p, pr, paths = build()
    write_history(data_dir, paths)
    print(f"fixture ready: {sum(len(v) for v in p.values())} products, serving on {port}", flush=True)
    serve(port, g, p, pr)
