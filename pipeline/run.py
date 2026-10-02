"""Daily job: refresh prices, backfill history, and cut the weekly issue.

    python -m pipeline.run --data-dir _data [--cut auto|force|never]
"""

import argparse
import datetime as dt
import json
import os
import sys

from . import config, graded, poketrace, score, site, tcgcsv
from .store import Store


def refresh_catalog(store, today):
    cached = store.load_catalog(today)
    if cached:
        print(f"Using cached catalog for {today} ({len(cached['items'])} products)")
        return cached
    groups = tcgcsv.groups()
    print(f"Fetching {len(groups)} Pokemon sets from TCGCSV")
    catalog = score.build_catalog(today, groups, tcgcsv.products, tcgcsv.prices)
    if len(catalog["items"]) < int(os.environ.get("MIN_PRODUCTS", "1000")):
        raise SystemExit(f"Only {len(catalog['items'])} products came back; refusing to continue")
    store.save_catalog(catalog)
    return catalog


def backfill(store, today):
    """Download archive days we want but do not have yet."""
    today_d = dt.date.fromisoformat(today)
    have = [dt.date.fromisoformat(d) for d in store.snapshot_dates()]
    downloads = 0
    for offset in config.HISTORY_OFFSETS:
        target = today_d - dt.timedelta(days=offset)
        tolerance = 0 if offset <= 7 else (1 if offset <= 14 else 3)
        if any(abs((d - target).days) <= tolerance for d in have):
            continue
        if downloads >= config.MAX_ARCHIVE_DOWNLOADS_PER_RUN:
            break
        for candidate in (target, target - dt.timedelta(days=1)):
            snap = tcgcsv.archive_prices(candidate.isoformat())
            downloads += 1
            if snap and len(snap) > 1000:
                store.save_snapshot(candidate.isoformat(), snap)
                have.append(candidate)
                print(f"  backfilled {candidate} ({len(snap)} prices)")
                break
            print(f"  no archive for {candidate}")
    return downloads


def should_cut(index, today, mode):
    if mode == "force":
        return True
    if mode == "never":
        return False
    if not index:
        return True
    latest = dt.date.fromisoformat(index[0]["date"])
    today_d = dt.date.fromisoformat(today)
    # New issue on the Thursday-night run (ready Friday morning US time), or if a week was missed.
    return (today_d.weekday() == 3 and (today_d - latest).days >= 3) or (today_d - latest).days >= 8


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="_data")
    parser.add_argument("--cut", default="auto", choices=["auto", "force", "never"])
    parser.add_argument("--site-dir", default=None, help="where to write search.json and sets/ for the website")
    args = parser.parse_args(argv)

    store = Store(args.data_dir)
    today = tcgcsv.last_updated()
    print(f"TCGCSV data date: {today}")

    catalog = refresh_catalog(store, today)
    store.save_snapshot(today, score.snapshot_from_catalog(catalog))
    if os.environ.get("TCGCSV_ARCHIVE") == "1":
        backfill(store, today)  # TCGCSV withdrew its archive in Sept 2026; off unless it returns

    dates = store.snapshot_dates()
    print(f"History: {len(dates)} snapshots from {dates[0]} to {dates[-1]}")
    index = store.issue_index()

    snapshots = {d: store.load_snapshot(d) for d in dates if d <= today}
    rows, span = score.compute_rows(catalog, snapshots, today)
    trended = sum(1 for r in rows if r["ch7"] is not None)
    print(f"Scored {trended} product printings with a price today and {span} days ago")

    if should_cut(index, today, args.cut):
        categories, counts = score.make_categories(rows, span or 7)
        print("Eligible per list: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
        if not categories:
            print("No list had enough picks (history too thin?). Not cutting an issue.")
            store.prune_history(today)
            return 0 if index else 2
        same_day = index and index[0]["date"] == today
        number = index[0]["number"] if same_day else (index[0]["number"] + 1 if index else 1)
        issue = {
            "number": number,
            "date": today,
            "title": config.TITLE,
            "tagline": config.TAGLINE,
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "shortSpanDays": span,
            "sources": config.SOURCES,
            "stats": {
                "productsScanned": len(catalog["items"]),
                "printingsScored": trended,
                "snapshots": len(snapshots),
                "historyFrom": dates[0],
                "eligible": counts,
            },
            "categories": categories,
        }
        issue["cover"] = score.choose_cover(categories)
        print(f"Cut issue {number}: " + ", ".join(f"{c['id']}={len(c['picks'])}" for c in categories))
    else:
        issue = store.load_issue(index[0]["number"])
        print(f"No new issue today; latest is issue {issue['number']} ({issue['date']})")

    cache = store.graded_cache()
    made = graded.top_up(issue, cache, today)
    store.save_graded_cache(cache)
    print(f"Graded lookups this run: {made}")

    _made, sample = poketrace.top_up(issue, today)
    if sample:
        store_sample = os.path.join(args.data_dir, "poketrace-sample.json")
        with open(store_sample, "w", encoding="utf-8") as fh:
            json.dump(sample, fh, indent=1)

    store.save_issue(issue)
    if args.site_dir:
        n_items, n_sets = site.export(args.site_dir, catalog, snapshots, today, rows)
        print(f"Site data: {n_items} products in the search index, {n_sets} set history files")
    store.prune_history(today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
