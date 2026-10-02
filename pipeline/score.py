"""Turns the catalog and price history into the weekly lists."""

import datetime as dt
import math
import re
import statistics

from . import config
from .tcgcsv import price_key


# ---------- catalog ----------

def _valid_release(published):
    """TCGCSV gives promo groups a 'now' timestamp. Real release dates sit at midnight."""
    if not published or "T00:00:00" not in published:
        return None
    return published[:10]


def era_for(name, release):
    if release:
        era = None
        for era_id, _label, start in config.ERAS:
            if release >= start:
                era = era_id
        return era
    for prefix, era_id in config.ERA_PREFIXES:
        if re.match(rf"^{re.escape(prefix)}(\d|:|\s)", name or ""):
            return era_id
    return None


def _kind(name, ext):
    lname = (name or "").lower()
    if ext.get("Number"):
        if lname.startswith("code card") or ext.get("Rarity") == "Code Card":
            return None
        return "single"
    if any(w in lname for w in config.SEALED_SKIP_WORDS):
        return None
    if any(w in lname for w in config.SEALED_WORDS):
        return "sealed"
    return None


def build_catalog(date, groups, fetch_products, fetch_prices, log=print):
    cat_groups, items = {}, []
    for i, g in enumerate(groups):
        gid = g["groupId"]
        release = _valid_release(g.get("publishedOn"))
        cat_groups[str(gid)] = {
            "name": g.get("name"),
            "abbr": g.get("abbreviation"),
            "release": release,
            "era": era_for(g.get("name"), release),
        }
        price_rows = {}
        for row in fetch_prices(gid):
            price_rows.setdefault(row["productId"], {})[row.get("subTypeName") or "Normal"] = [
                row.get("marketPrice"), row.get("lowPrice"), row.get("midPrice"),
            ]
        for p in fetch_products(gid):
            ext = {e.get("name"): e.get("value") for e in p.get("extendedData") or []}
            kind = _kind(p.get("name"), ext)
            if not kind or p["productId"] not in price_rows:
                continue
            items.append({
                "id": p["productId"],
                "name": p.get("name"),
                "gid": gid,
                "kind": kind,
                "number": ext.get("Number"),
                "rarity": ext.get("Rarity"),
                "image": p.get("imageUrl"),
                "url": p.get("url"),
                "presale": bool((p.get("presaleInfo") or {}).get("isPresale")),
                "prices": price_rows[p["productId"]],
            })
        if (i + 1) % 40 == 0:
            log(f"  fetched {i + 1}/{len(groups)} sets, {len(items)} products so far")
    return {"date": date, "groups": cat_groups, "items": items}


def snapshot_from_catalog(catalog):
    snap = {}
    for item in catalog["items"]:
        for sub, (market, _low, _mid) in item["prices"].items():
            if market:
                snap[price_key(item["id"], sub)] = market
    return snap


# ---------- metrics ----------

def _days(a, b):
    return (dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days


def _nearest(key, today, offset, tolerance, dates, snapshots):
    target = (dt.date.fromisoformat(today) - dt.timedelta(days=offset)).isoformat()
    options = sorted((abs(_days(d, target)), d) for d in dates if abs(_days(d, target)) <= tolerance and d < today)
    for _gap, d in options:
        price = snapshots[d].get(key)
        if price:
            return price
    return None


def pick_baseline(today, dates):
    """The snapshot the short-term move is measured from.

    Normally the one closest to 7 days ago. If history has a gap there, the newest
    snapshot between 10 and 21 days old is used and the issue says how many days it spans.
    """
    ages = {d: _days(today, d) for d in dates}
    near = [d for d in dates if 5 <= ages[d] <= 9]
    if near:
        return min(near, key=lambda d: abs(ages[d] - 7))
    older = [d for d in dates if 9 < ages[d] <= 21]
    return max(older) if older else None


def compute_rows(catalog, snapshots, today):
    """One row per product printing with a price today and at the baseline. Returns (rows, span)."""
    dates = sorted(d for d in snapshots if d < today and _days(today, d) <= 92)
    baseline = pick_baseline(today, dates)
    if not baseline:
        return [], None
    span = _days(today, baseline)
    rows = []
    for item in catalog["items"]:
        group = catalog["groups"].get(str(item["gid"]), {})
        release = group.get("release")
        if item["presale"] or (release and release > today):
            continue
        for sub, (market, low, _mid) in item["prices"].items():
            if not market or not low:
                continue  # no sales-based price, or nothing listed to buy
            key = price_key(item["id"], sub)
            p7 = snapshots[baseline].get(key)
            if not p7:
                continue
            p30 = _nearest(key, today, 30, 5, dates, snapshots)
            p90 = _nearest(key, today, 90, 10, dates, snapshots)
            series = [[d, snapshots[d][key]] for d in dates if snapshots[d].get(key)]
            series.append([today, market])
            values = [v for _d, v in series]
            past = values[:-1]
            moves = sum(1 for a, b in zip(past, past[1:]) if a != b)
            rows.append({
                "key": key, "productId": item["id"], "printing": sub,
                "name": item["name"], "kind": item["kind"],
                "number": item["number"], "rarity": item["rarity"],
                "image": item["image"], "url": item["url"],
                "set": group.get("name"), "setAbbr": group.get("abbr"), "gid": item["gid"],
                "era": group.get("era"),
                "setAgeDays": _days(today, release) if release else None,
                "price": market, "low": low,
                "p7": p7, "p30": p30, "p90": p90,
                "ch7": market / p7 - 1,
                "ch30": market / p30 - 1 if p30 else None,
                "ch90": market / p90 - 1 if p90 else None,
                "median90": statistics.median(values),
                "lo90": min(values), "hi90": max(values),
                # share of past readings where the market price changed: a stand-in for
                # how often the card actually sells, since the free feed has no sales counts
                "activity": moves / max(1, len(past) - 1),
                "points": len(series), "series": series,
            })
    return rows, span


# ---------- lists ----------

SPAN = 7  # days the short-term move covers; set per issue by make_categories


def _in_span():
    return f"in {SPAN} days"


def _this_week():
    return "this week" if SPAN <= 8 else f"in the last {SPAN} days"


def _pct(x):
    return f"{x * 100:+.0f}%"


def _money(x):
    return f"${x:,.2f}"


def _listed_near(row, floor=0.7, ceiling=None):
    ratio = row["low"] / row["price"]
    return ratio >= floor and (ceiling is None or ratio <= ceiling)


def _confidence(row):
    ratio = row["low"] / row["price"]
    if row["points"] >= 12 and row["activity"] >= 0.5 and 0.85 <= ratio <= 1.1:
        return "High"
    if row["points"] >= 6 and 0.7 <= ratio <= 1.3:
        return "Medium"
    return "Low"


def _trades(row, floor=0.28):
    """True when the price has moved often enough to suggest regular sales."""
    return row["points"] >= 6 and row["activity"] >= floor


def _clamp_score(x):
    return int(max(1, min(99, round(x))))


def _heat(row):
    return _clamp_score(50 + 35 * math.tanh(3 * row["ch7"]) + 15 * math.tanh(2 * (row["ch30"] or 0)))


def _hot(eras, min_price, activity=0.28):
    def test(r):
        return (
            r["kind"] == "single" and r["era"] in eras and r["price"] >= min_price
            and 0.05 <= r["ch7"] <= config.MAX_SANE_WEEKLY_MOVE
            and (r["ch30"] is None or r["ch30"] > 0)
            and _trades(r, activity) and _listed_near(r, 0.7, 1.25)
        )

    def reason(r):
        month = f" and {_pct(r['ch30'])} over 30 days" if r["ch30"] is not None else ""
        gap = abs(r["low"] / r["price"] - 1) * 100
        return (f"Up {_pct(r['ch7'])} {_in_span()}{month}. The lowest listing is {_money(r['low'])}, "
                f"within {gap:.0f}% of the market price, so sellers are holding the new level.")

    return test, _heat, _heat, reason


def _sealed():
    def test(r):
        move = r["ch30"] if r["ch30"] is not None else r["ch7"]
        return (
            r["kind"] == "sealed" and r["era"] in ("sv", "mega") and r["price"] >= 20
            and (r["setAgeDays"] is None or r["setAgeDays"] >= 30)
            and 0.03 <= move <= config.MAX_SANE_WEEKLY_MOVE and r["ch7"] >= -0.02
            and _listed_near(r, 0.7, 1.25)
        )

    def rank(r):
        return (r["ch30"] if r["ch30"] is not None else r["ch7"]) + 0.5 * r["ch7"]

    def reason(r):
        if r["ch30"] is not None:
            return (f"Up {_pct(r['ch30'])} over 30 days and {_pct(r['ch7'])} {_this_week()}. "
                    f"Lowest sealed copy listed is {_money(r['low'])}.")
        return f"Up {_pct(r['ch7'])} {_this_week()}. Lowest sealed copy listed is {_money(r['low'])}."

    return test, rank, _heat, reason


def _gems():
    def test(r):
        return (
            r["kind"] == "single" and 2 <= r["price"] <= 20
            and r["ch30"] is not None and 0.08 <= r["ch30"] <= 0.8
            and 0 <= r["ch7"] <= (0.6 if SPAN <= 9 else 0.85) * r["ch30"] + 0.05
            and (r["ch90"] is None or r["ch90"] <= 1.5)
            and _trades(r) and _listed_near(r, 0.75, 1.25)
        )

    def reason(r):
        return (f"A steady climb, not a spike: {_pct(r['ch30'])} over 30 days, {_pct(r['ch7'])} "
                f"{_this_week()}, and still only {_money(r['price'])}.")

    return test, lambda r: r["ch30"], _heat, reason


def _on_sale():
    def discount(r):
        return 1 - r["price"] / r["median90"]

    def test(r):
        return (
            r["price"] >= 20 and _trades(r) and discount(r) >= 0.13
            and (r["setAgeDays"] is None or r["setAgeDays"] >= 365)
            and r["ch7"] <= 0.02 and r["ch7"] >= -0.6
            and _listed_near(r, 0.6, 1.15)
        )

    def score(r):
        return _clamp_score(50 + 49 * math.tanh(2.5 * discount(r)))

    def reason(r):
        was = f" It was {_money(r['p30'])} a month ago." if r["p30"] else ""
        return (f"{discount(r) * 100:.0f}% under its 90-day median of {_money(r['median90'])}.{was} "
                f"A dip, not a guarantee: check for a reprint before buying.")

    return test, discount, score, reason


def _holding():
    def band(r):
        return (r["hi90"] - r["lo90"]) / r["median90"]

    def test(r):
        long_move = r["ch90"] if r["ch90"] is not None else (r["ch30"] or 0)
        return (
            r["price"] >= 100 and r["points"] >= 8 and _trades(r, 0.34) and band(r) <= 0.12
            and long_move >= -0.03 and _listed_near(r, 0.85, 1.15)
        )

    def rank(r):
        return -band(r) + min(r["price"], 2000) / 20000

    def score(r):
        return _clamp_score(60 + 39 * (1 - band(r) / 0.12))

    def reason(r):
        return (f"Stayed inside a {band(r) * 100:.0f}% band for the whole tracked period, "
                f"around {_money(r['median90'])}. Listings sit right at the market price.")

    return test, rank, score, reason


LISTS = [
    ("hot-vintage", "Vintage era singles this week", "Vintage era", "1999 to 2007: Wizards of the Coast and EX sets", "red", "Heat", _hot(("wotc", "ex"), 15),
     "Singles from sets released before May 2007, $15 and up, that rose at least 5% in {span} days while the 30-day trend is also up."),
    ("hot-middle", "DP to XY era singles this week", "DP to XY era", "2007 to 2016: Diamond & Pearl through XY sets", "blue", "Heat", _hot(("dp", "bwxy"), 10),
     "Singles from 2007 to 2016 sets, $10 and up, that rose at least 5% in {span} days while the 30-day trend is also up."),
    ("hot-sm-swsh", "SM and SWSH era singles this week", "SM and SWSH era", "2017 to 2022: Sun & Moon and Sword & Shield sets", "yellow", "Heat", _hot(("sm", "swsh"), 8, 0.34),
     "Singles from 2017 to 2022 sets, $8 and up, that rose at least 5% in {span} days while the 30-day trend is also up."),
    ("hot-modern", "Modern era singles this week", "Modern era", "2023 on: Scarlet & Violet and Mega Evolution sets", "red", "Heat", _hot(("sv", "mega"), 5, 0.45),
     "Singles from 2023 and later sets, $5 and up, that rose at least 5% in {span} days while the 30-day trend is also up."),
    ("modern-sealed", "Top modern sealed this week", "Modern sealed", "Boxes, bundles and tins from 2023 on", "blue", "Heat", _sealed(),
     "Sealed products from Scarlet & Violet and Mega Evolution sets at least 30 days old, $20 and up, ranked by 30-day rise."),
    ("hidden-gems", "Hidden gems for cheap", "Hidden gems", "Under $20 and climbing steadily", "green", "Heat", _gems(),
     "Singles from $2 to $20 that rose 8% to 80% over 30 days, with the rise spread out and not one late jump."),
    ("on-sale", "On sale this week", "On sale", "Trading well under their own 90-day median", "yellow", "Deal", _on_sale(),
     "Cards and sealed products $20 and up, at least 13% under their own 90-day median price, from sets at least a year old so the normal slide after release is not counted."),
    ("holding", "Holding strong", "Holding strong", "Big cards that barely moved", "green", "Steady", _holding(),
     "Cards and sealed products $100 and up whose price stayed within a 12% band across the tracked period without falling."),
]


def _public(row, score, label, reason, rank):
    keep = ("key", "productId", "printing", "name", "kind", "number", "rarity", "image", "url",
            "set", "setAbbr", "era", "price", "low", "ch7", "ch30", "ch90", "median90", "series")
    out = {k: row[k] for k in keep}
    for k in ("price", "low", "median90"):
        out[k] = round(out[k], 2)
    for k in ("ch7", "ch30", "ch90"):
        out[k] = None if out[k] is None else round(out[k], 4)
    out["activity"] = round(row["activity"], 2)
    out.update({"rank": rank, "score": score, "scoreLabel": label,
                "confidence": _confidence(row), "reason": reason})
    return out


def make_categories(rows, span=7):
    global SPAN
    SPAN = span
    categories, counts, used = [], {}, set()
    for list_id, title, short, blurb, color, label, (test, rank, score, reason), rule in LISTS:
        eligible = sorted((r for r in rows if test(r)), key=rank, reverse=True)
        counts[list_id] = len(eligible)
        picks, seen_products, per_set = [], set(), {}
        for r in eligible:
            if r["productId"] in seen_products or r["productId"] in used or per_set.get(r["gid"], 0) >= config.MAX_PER_SET:
                continue
            seen_products.add(r["productId"])
            per_set[r["gid"]] = per_set.get(r["gid"], 0) + 1
            picks.append(_public(r, score(r), label, reason(r), len(picks) + 1))
            if len(picks) == config.PICKS_PER_LIST:
                break
        if len(picks) >= 3:
            used.update(p["productId"] for p in picks)
            categories.append({"id": list_id, "title": title, "short": short, "blurb": blurb, "color": color,
                               "rule": rule.replace("{span}", str(span)), "eligible": len(eligible), "picks": picks})
    return categories, counts


def choose_cover(categories):
    best = None
    for cat in categories:
        if not cat["id"].startswith("hot-"):
            continue
        for pick in cat["picks"][:3]:
            if pick["image"] and pick["price"] >= 20 and (best is None or pick["score"] > best[1]["score"]):
                best = (cat, pick)
    if not best and categories:
        best = (categories[0], categories[0]["picks"][0])
    if not best:
        return None
    cat, pick = best
    return {"category": cat["id"], "key": pick["key"], "name": pick["name"], "image": pick["image"]}
