"""Daily job: refresh prices, re-pick the lists, and keep a numbered issue each week.

    python -m pipeline.run --data-dir _data [--cut auto|force|new|never]
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


def plan_cut(index, edition, today, mode):
    """Decides whether to re-pick the lists on this run and whether that starts a new numbered issue.

    The morning run re-picks the lists every day on the latest prices.
    A new numbered issue starts with Thursday's prices (the Friday-morning run), or if a week was missed;
    the days in between update the current issue's daily edition.
    """
    if not index:
        return True, True
    if mode == "never":
        return False, False
    today_d = dt.date.fromisoformat(today)
    days = (today_d - dt.date.fromisoformat(index[0]["date"])).days
    new_number = (today_d.weekday() == 3 and days >= 3) or days >= 8
    if mode == "new":
        # Start the next numbered issue now, but only on prices newer than the last one was cut on.
        if days <= 0:
            print(f"Prices have not changed since issue {index[0]['number']} was cut ({index[0]['date']}); "
                  f"a new issue now would be a copy, so none was started.")
            return False, False
        return True, True
    if mode == "force":
        return True, new_number
    # auto: the morning run always re-runs the rules, so the picks are that day's even if prices did not move
    return True, new_number


def _keys(issue):
    return sorted({p["key"] for c in issue["categories"] for p in c["picks"]})


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="_data")
    parser.add_argument("--cut", default="auto", choices=["auto", "force", "new", "never"])
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

    # The edition is what the site shows today. The numbered issue is the copy kept in back issues.
    edition = store.load_today() or (store.load_issue(index[0]["number"]) if index else None)
    cut, new_number = plan_cut(index, edition, today, args.cut)
    if cut:
        categories, counts = score.make_categories(rows, span or 7)
        print("Eligible per list: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
        if not categories:
            print("No list had enough picks (history too thin?). Not refreshing the picks.")
            store.prune_history(today)
            return 0 if index else 2
        number = (index[0]["number"] + 1 if index else 1) if new_number else index[0]["number"]
        issue_date = today if new_number else index[0]["date"]
        # Picks that were not in the previous day's edition are marked as new. A second refresh
        # on the same day keeps comparing against the day before.
        now = dt.datetime.now(dt.timezone.utc)
        if edition and (edition.get("generatedAt") or "")[:10] != now.date().isoformat():
            previous = _keys(edition)
        else:
            previous = (edition or {}).get("previousKeys")
        if previous is not None:
            seen = set(previous)
            for cat in categories:
                for pick in cat["picks"]:
                    if pick["key"] not in seen:
                        pick["isNew"] = True
        edition = {
            "number": number,
            "date": today,
            "issueDate": issue_date,
            "title": config.TITLE,
            "tagline": config.TAGLINE,
            "generatedAt": now.isoformat(timespec="seconds"),
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
        if previous is not None:
            edition["previousKeys"] = previous
        edition["cover"] = score.choose_cover(categories)
        kind = f"new issue {number}" if new_number else f"daily update of issue {number}"
        print(f"Picks refreshed ({kind}): " + ", ".join(f"{c['id']}={len(c['picks'])}" for c in categories))
    else:
        print(f"Picks not refreshed on this run; showing issue {edition['number']}, prices as of {edition['date']}")

    cache = store.graded_cache()
    made = graded.top_up(edition, cache, today)
    print(f"Graded lookups this run: {made}")

    _made, sample = poketrace.top_up(edition, today)
    if sample:
        store_sample = os.path.join(args.data_dir, "poketrace-sample.json")
        with open(store_sample, "w", encoding="utf-8") as fh:
            json.dump(sample, fh, indent=1)

    store.save_today(edition)
    if edition["date"] == edition.get("issueDate", edition["date"]):
        store.save_issue(edition)  # the numbered issue is this same set of picks
    else:
        kept = store.load_issue(edition["number"])
        if kept:  # fill in graded prices that arrived after the numbered issue was cut
            graded.top_up(kept, cache, today, fetch=False, log=lambda *_: None)
            store.save_issue(kept)
    store.save_graded_cache(cache)
    if args.site_dir:
        n_items, n_sets = site.export(args.site_dir, catalog, snapshots, today, rows)
        print(f"Site data: {n_items} products in the search index, {n_sets} set history files")
    store.prune_history(today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
