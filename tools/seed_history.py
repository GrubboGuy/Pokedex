"""One-time history seed from the public Rarebox price-history repository.

TCGCSV withdrew its daily price archive in September 2026, so the job cannot backfill
history itself. Rarebox (github.com/novaoc/rarebox-price-history) kept a per-card copy of
that archive up to 2026-09-15. This script converts it into the job's snapshot format.

    git clone --depth 1 https://github.com/novaoc/rarebox-price-history rarebox
    python tools/seed_history.py rarebox _data

Needs _data/catalog.json.gz from a previous run (to know which products exist today).
Prices (c) TCGplayer, via TCGCSV, via Rarebox. Singles only; sealed products are not in it.
"""

import bisect
import datetime as dt
import gzip
import json
import os
import sys

EPOCH = dt.date(1970, 1, 1)


def value_at(points, day):
    """Price on a given day from change-only points (flat runs keep first and last point)."""
    if not points or day < points[0][0] or day > points[-1][0] + 8:
        return None
    i = bisect.bisect_right(points, [day, float("inf")]) - 1
    return points[i][1] if i >= 0 else None


def main(rarebox, data_dir, first="2026-06-21", last="2026-09-15"):
    with gzip.open(os.path.join(data_dir, "catalog.json.gz"), "rt", encoding="utf-8") as fh:
        catalog = json.load(fh)
    printings = {}
    for item in catalog["items"]:
        printings[str(item["id"])] = list(item["prices"].keys())

    # productId -> (points per printing), using Rarebox's own product maps
    series = {}
    maps_dir = os.path.join(rarebox, "maps", "products", "pokemon")
    for fname in sorted(os.listdir(maps_dir)):
        with open(os.path.join(maps_dir, fname)) as fh:
            pmap = json.load(fh)
        data_path = os.path.join(rarebox, "data", "pokemon", fname)
        if not os.path.isfile(data_path):
            continue
        with open(data_path) as fh:
            cards = json.load(fh)["cards"]
        for pid, (card_key, is_variant) in pmap.items():
            if is_variant or pid not in printings or card_key not in cards:
                continue
            for sub in printings[pid]:
                points = cards[card_key].get(sub.lower())
                if points:
                    series[f"{pid}|{sub}"] = points

    first_d, last_d = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    dates, d = [], last_d
    while d >= first_d:
        dates.append(d)
        d -= dt.timedelta(days=1 if (last_d - d).days < 14 else 3)

    os.makedirs(os.path.join(data_dir, "history"), exist_ok=True)
    for d in sorted(dates):
        day = (d - EPOCH).days
        snap = {}
        for key, points in series.items():
            v = value_at(points, day)
            if v:
                snap[key] = v
        path = os.path.join(data_dir, "history", f"{d.isoformat()}.json.gz")
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            json.dump(snap, fh, separators=(",", ":"))
        print(f"{d}  {len(snap)} prices")
    print(f"matched {len(series)} product printings across {len(dates)} days")


if __name__ == "__main__":
    main(*sys.argv[1:])
