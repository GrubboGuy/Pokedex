"""Files the website reads besides the issues: a search index and per-set price history."""

import os

from .store import write_json
from .tcgcsv import price_key


def export(site_dir, catalog, snapshots, today, rows):
    """Writes search.json (every product) and sets/<id>.json (price series for each set)."""
    os.makedirs(os.path.join(site_dir, "sets"), exist_ok=True)
    dates = sorted(d for d in snapshots if d <= today)
    moves = {r["key"]: (r["ch7"], r["ch30"]) for r in rows}

    set_ids = sorted(catalog["groups"], key=lambda g: catalog["groups"][g].get("release") or "", reverse=True)
    set_index = {gid: i for i, gid in enumerate(set_ids)}
    sets = [[int(gid), catalog["groups"][gid]["name"], catalog["groups"][gid].get("abbr"),
             catalog["groups"][gid].get("release")] for gid in set_ids]

    items, by_set = [], {}
    for item in catalog["items"]:
        printings = []
        for sub, (market, low, _mid) in item["prices"].items():
            if not market:
                continue
            key = price_key(item["id"], sub)
            short, month = moves.get(key, (None, None))
            printings.append([sub, round(market, 2), round(low, 2) if low else None,
                              None if short is None else round(short, 3),
                              None if month is None else round(month, 3)])
            series = [snapshots[d].get(key) for d in dates]
            if any(series):
                by_set.setdefault(str(item["gid"]), {})[key] = series
        if printings:
            printings.sort(key=lambda p: -p[1])
            items.append([item["id"], item["name"], set_index[str(item["gid"])], item["number"],
                          1 if item["kind"] == "sealed" else 0, item["rarity"], printings, item.get("art")])

    write_json(os.path.join(site_dir, "search.json"), {"date": today, "sets": sets, "items": items})
    for gid, series in by_set.items():
        write_json(os.path.join(site_dir, "sets", f"{gid}.json"), {"dates": dates, "series": series})
    return len(items), len(by_set)
