"""Turns the catalog and price history into the lists of picks."""

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
    """Era from the set name's prefix when it has one (promo sets are dated oddly), else from its release date."""
    for prefix, era_id in config.ERA_PREFIXES:
        if re.match(rf"^{re.escape(prefix)}(\d|:|\s|-)", name or ""):
            return era_id
    era = None
    if release:
        for era_id, _label, start in config.ERAS:
            if release >= start:
                era = era_id
    return era


def frame_for(name, release):
    """Which card frame design a set uses, or None when it mixes several or the date is unknown."""
    lname = (name or "").lower()
    for set_name, frame in config.FRAME_BY_NAME:
        if lname == set_name.lower():
            return frame
    if any(w in lname for w in config.FRAME_SKIP_WORDS):
        return None
    if not release:
        return config.ERA_FRAMES.get(era_for(name, None))
    frame = None
    for frame_id, start in config.FRAMES:
        if release >= start:
            frame = frame_id
    return frame


_TRAINER = re.compile(r"trainer|item|supporter|stadium|tool|technical machine|^tm$", re.I)


def _layout(name, ext):
    """p = Pokemon, t = Trainer, e = Energy. TCGplayer's card details are patchy, so be forgiving."""
    card_type = (ext.get("Card Type") or "").strip()
    if _TRAINER.search(card_type):
        return "t"
    if "energy" in card_type.lower():
        return "e"
    if card_type or ext.get("HP"):
        return "p"
    if re.search(r"\bEnergy\b", name or ""):
        return "e"
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
        frame = frame_for(g.get("name"), release)
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
                "art": (f"{frame}.{_layout(p.get('name'), ext)}"
                        if kind == "single" and frame and _layout(p.get("name"), ext) else None),
                "image": p.get("imageUrl"),
                "url": p.get("url"),
                "presale": bool((p.get("presaleInfo") or {}).get("isPresale")),
                "prices": price_rows[p["productId"]],
            })
        if (i + 1) % 40 == 0:
            log(f"  fetched {i + 1}/{len(groups)} sets, {len(items)} products so far")
    return {"date": date, "v": config.CATALOG_VERSION, "groups": cat_groups, "items": items}


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
        for sub, (market, low, mid) in item["prices"].items():
            if not market or not low:
                continue  # no sales-based price, or nothing listed to buy
            key = price_key(item["id"], sub)
            p7 = snapshots[baseline].get(key)
            if not p7 and item["kind"] != "sealed":
                continue  # sealed rows are kept without a trend for the listing-based sealed list
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
                "number": item["number"], "rarity": item["rarity"], "art": item.get("art"),
                "image": item["image"], "url": item["url"],
                "set": group.get("name"), "setAbbr": group.get("abbr"), "gid": item["gid"],
                "era": era_for(group.get("name"), release),
                "setAgeDays": _days(today, release) if release else None,
                "price": market, "low": low, "mid": mid,
                "p7": p7, "p30": p30, "p90": p90,
                "ch7": market / p7 - 1 if p7 else None,
                "ch30": market / p30 - 1 if p30 else None,
                "ch90": market / p90 - 1 if p90 else None,
                "median90": statistics.median(values),
                "lo90": min(values), "hi90": max(values),
                # share of past readings where the market price changed: a stand-in for
                # how often the card actually sells, since the free feed has no sales counts
                "activity": moves / max(1, len(past) - 1),
                "points": len(series), "series": series,
                # change since the first price on file, for products too new to our records for a full trend
                "since": series[0][0], "chSince": market / series[0][1] - 1 if len(series) >= 2 else None,
            })
    return rows, span


# ---------- lists ----------

SPAN = 7  # days the short-term move covers; set per issue by make_categories


def _in_span():
    return f"in {SPAN} days"


def _recently():
    return f"in the last {SPAN} days"


def _pct(x):
    return f"{x * 100:+.0f}%"


def _money(x):
    return f"${x:,.2f}"


def _p(x):
    """A percentage without a sign, for sentences that already say up or down."""
    return f"{abs(x) * 100:.0f}%"


def _dir(x):
    return "up" if x >= 0 else "down"


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
        month = f" and {_p(r['ch30'])} over 30 days" if r["ch30"] is not None else ""
        return f"Up {_p(r['ch7'])} {_in_span()}{month}."

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
            return (f"Up {_p(r['ch30'])} over 30 days and {_dir(r['ch7'])} {_p(r['ch7'])} {_recently()}. "
                    f"Sellers are asking from {_money(r['low'])} before shipping.")
        return f"Up {_p(r['ch7'])} {_recently()}. Sellers are asking from {_money(r['low'])} before shipping."

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
        return (f"A steady climb, not a sudden jump: up {_p(r['ch30'])} over 30 days, up {_p(r['ch7'])} "
                f"{_recently()}, and still only {_money(r['price'])}.")

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
        return (f"{discount(r) * 100:.0f}% below its usual price over the last 90 days ({_money(r['median90'])}).{was} "
                f"Prices can drop for a reason, so check for a reprint before buying.")

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
        return (f"Its price has stayed around {_money(r['median90'])} the whole time we have tracked it, moving less than "
                f"{max(1, math.ceil(band(r) * 100))}% between its lowest and highest. Sellers are asking about the same.")

    return test, rank, score, reason


def _big_movers():
    """Large short-term moves, up or down, on cards worth $100 or more."""
    def test(r):
        return (
            r["kind"] == "single" and max(r["price"], r["p7"]) >= 100
            and 0.08 <= abs(r["ch7"]) and -0.6 <= r["ch7"] <= config.MAX_SANE_WEEKLY_MOVE
            and _trades(r) and (_listed_near(r, 0.7, 1.25) if r["ch7"] > 0 else _listed_near(r, 0.6, 1.2))
        )

    def score(r):
        return _clamp_score(50 + 49 * math.tanh(3.2 * abs(r["ch7"])))

    def reason(r):
        month = f" Over 30 days it is {_dir(r['ch30'])} {_p(r['ch30'])}." if r["ch30"] is not None else ""
        if r["ch7"] > 0:
            return f"Up {_p(r['ch7'])} {_in_span()}, from {_money(r['p7'])} to {_money(r['price'])}.{month}"
        return (f"Down {_p(r['ch7'])} {_in_span()}, from {_money(r['p7'])} to {_money(r['price'])}.{month} "
                f"A drop this size can come from one low sale, "
                f"a reprint or a real change, so check recent sales.")

    return test, lambda r: abs(r["ch7"]), score, reason


def _rebound():
    """Established cards on a dip that runs against their own trend.

    Nothing here is a forecast. The list looks for the conditions that usually come before a
    recovery: the card held or gained value for months, trades often, and only just fell.
    """
    def before(r):  # change over the tracked period up to the start of the dip
        return r["p7"] / r["p90"] - 1 if r["p90"] else None

    def test(r):
        prior = before(r)
        return (
            r["kind"] == "single" and r["p7"] >= 30 and r["points"] >= 12 and _trades(r, 0.34)
            and (r["setAgeDays"] is None or r["setAgeDays"] >= 365)
            and -0.35 <= r["ch7"] <= -0.05
            and prior is not None and prior >= -0.03
            and r["price"] <= r["median90"]
            and _listed_near(r, 0.7, 1.35)
        )

    def score(r):
        return _clamp_score(46 + 30 * math.tanh(5 * abs(r["ch7"])) + 14 * math.tanh(3 * max(0, before(r)))
                            + 8 * r["activity"])

    def reason(r):
        prior = before(r)
        trend = (f"gaining {_p(prior)} over the months before" if prior >= 0.03
                 else f"holding around {_money(r['median90'])} for months")
        return (f"Down {_p(r['ch7'])} {_in_span()} to {_money(r['price'])}, after {trend}. It sells often and "
                f"the drop goes against its own trend, which is when prices tend to come back. "
                f"A sign, not a promise: check for a reprint first.")

    return test, score, score, reason


LISTS = [
    ("big-movers", "Big movers", "Big movers", "The biggest price moves on $100+ cards", "red", "Swing", _big_movers(),
     "Singles worth $100 or more, before or after the move, whose price moved at least 8% up or down in {span} days. Up to four that rose and four that fell, biggest move first."),
    ("hot-vintage", "Vintage", "Vintage", "Rising singles from 1999 to 2007 sets", "red", "Heat", _hot(("wotc", "ex"), 15),
     "Singles from sets released before May 2007, $15 and up, that rose at least 5% in {span} days and are also up over 30 days."),
    ("hot-middle", "DP to XY", "DP to XY", "Rising singles from 2007 to 2016 sets", "blue", "Heat", _hot(("dp", "bwxy"), 10),
     "Singles from 2007 to 2016 sets, $10 and up, that rose at least 5% in {span} days and are also up over 30 days."),
    ("hot-sm-swsh", "SM & SWSH", "SM & SWSH", "Rising singles from 2017 to 2022 sets", "yellow", "Heat", _hot(("sm", "swsh"), 8, 0.34),
     "Singles from 2017 to 2022 sets, $8 and up, that rose at least 5% in {span} days and are also up over 30 days."),
    ("hot-modern", "Modern", "Modern", "Rising singles from 2023 and later sets", "red", "Heat", _hot(("sv", "mega"), 5, 0.45),
     "Singles from 2023 and later sets, $5 and up, that rose at least 5% in {span} days and are also up over 30 days."),
    ("modern-sealed", "Hot sealed", "Sealed", "Modern boxes, bundles and tins on the rise", "blue", "Heat", _sealed(),
     "Sealed products from Scarlet & Violet and Mega Evolution sets at least 30 days old, $20 and up, ranked by how much they rose in 30 days."),
    ("hidden-gems", "Hidden gems", "Hidden gems", "Under $20 and climbing steadily", "green", "Heat", _gems(),
     "Singles from $2 to $20 that rose 8% to 80% over 30 days, with the rise spread across the month and not one sudden jump at the end."),
    ("get-em-now", "Get 'em now", "Get 'em now", "Proven cards on a dip that looks temporary", "green", "Rebound", _rebound(),
     "Singles that were $30 and up, sell often and held or gained value over the months before, now down 5% to 35% in {span} days and below their usual price over the last 90 days. From sets at least a year old, because new sets normally get cheaper after release. These are signs that often come before a price recovers, not a prediction."),
    ("on-sale", "On sale", "On sale", "Selling well below their usual price", "yellow", "Deal", _on_sale(),
     "Cards and sealed products $20 and up, at least 13% below their usual price over the last 90 days. From sets at least a year old, because new sets normally get cheaper after release."),
    ("holding", "Holding strong", "Holding strong", "$100+ cards that barely moved", "green", "Steady", _holding(),
     "Cards and sealed products $100 and up whose price moved less than 12% between its lowest and highest in the time we have tracked it, without falling."),
]


def _public(row, score, label, reason, rank):
    keep = ("key", "productId", "printing", "name", "kind", "number", "rarity", "image", "url",
            "set", "setAbbr", "era", "price", "low", "ch7", "ch30", "ch90", "median90", "series")
    out = {k: row[k] for k in keep}
    for k in ("price", "low", "median90"):
        out[k] = round(out[k], 2)
    for k in ("ch7", "ch30", "ch90"):
        out[k] = None if out[k] is None else round(out[k], 4)
    out["gid"] = row["gid"]
    if row.get("art"):
        out["art"] = row["art"]
    if row["ch7"] is None and row.get("chSince") is not None:
        out["since"] = row["since"]
        out["chSince"] = round(row["chSince"], 4)
    out["activity"] = round(row["activity"], 2)
    out.update({"rank": rank, "score": score, "scoreLabel": label,
                "confidence": _confidence(row), "reason": reason})
    return out


def _nice_day(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.strftime('%b')} {d.day}"


def _sealed_since():
    """Sealed list used until sealed products have a week of price history.

    Ranks by how much the market price has risen since sealed tracking began. An earlier version
    ranked by how far the lowest asking price sat under the market price; checked against the live
    listings, those low prices were stale or the wrong product, so it was dropped.
    """
    core = ("booster box", "elite trainer box", "booster bundle", "collection", "tin", "build & battle")

    def test(r):
        name = (r["name"] or "").lower()
        return (
            r["kind"] == "sealed" and r["era"] in ("sv", "mega") and r["price"] >= 20
            and (r["setAgeDays"] is None or r["setAgeDays"] >= 30)
            and any(w in name for w in core)
            and r["chSince"] is not None and 0.02 <= r["chSince"] <= 0.6
            and _listed_near(r, 0.85, 1.2)
        )

    def score(r):
        return _clamp_score(50 + 45 * math.tanh(6 * r["chSince"]))

    def reason(r):
        return (f"Up {_p(r['chSince'])} since {_nice_day(r['since'])}, from {_money(r['series'][0][1])} to "
                f"{_money(r['price'])}. We only started tracking sealed prices then, so this is a short window.")

    return test, lambda r: r["chSince"], score, reason


SEALED_FALLBACK = (
    "modern-sealed", "Sealed risers", "Sealed",
    "Modern boxes, bundles and tins that have gone up since we started tracking them", "blue", "Heat", _sealed_since(),
    "Sealed products from Scarlet & Violet and Mega Evolution sets at least 30 days old, $20 and up, whose market price "
    "has risen at least 2% since sealed tracking began on October 1, 2026. Once a full week of sealed prices is saved, "
    "this list ranks by the weekly rise like the others.",
)


# ---------- variants ----------

def _base_name(name):
    """'Zebstrika (Master Ball Pattern)' and 'Zebstrika - 032/086' both come back as 'zebstrika'."""
    return re.split(r"\s+-\s+|\s*[\(\[]", name or "")[0].strip().lower()


def variant_index(catalog):
    """Single cards grouped two ways, so every other version of a card can be found:
    by card number and name (the same card), and by set and name (the same name on another number)."""
    index = {}
    for item in catalog["items"]:
        if item["kind"] == "single" and item.get("number"):
            name = _base_name(item["name"])
            index.setdefault((item["number"], name), []).append(item)
            index.setdefault(("set", item["gid"], name), []).append(item)
    return index


SAME_SET_MAX = 8   # a name on more numbers than this in one set (Unown, basic Energy) is not a set of versions


def variants_for(row, index, groups, limit=12):
    """Other versions of a card, each with its own market price.

    "same": the same card number and name. Its other printings (reverse holo, 1st Edition), and
    stamped, patterned or prize copies sold as separate products, in this set or another.
    "set": the same name on a different number in this set. A holo and a non-holo printed as two
    cards in older sets, and the full-art, illustration and secret versions in newer ones.
    """
    name, out, seen = _base_name(row["name"]), [], set()

    def add(item, rel):
        for sub, (market, low, _mid) in item["prices"].items():
            if not market or (item["id"] == row["productId"] and sub == row["printing"]) or (item["id"], sub) in seen:
                continue
            seen.add((item["id"], sub))
            out.append({"productId": item["id"], "name": item["name"], "printing": sub, "rel": rel,
                        "set": (groups.get(str(item["gid"])) or {}).get("name"), "number": item.get("number"),
                        "rarity": item.get("rarity"), "art": item.get("art"),
                        "price": round(market, 2), "low": round(low, 2) if low else None})

    for item in index.get((row["number"], name), []):
        add(item, "same")
    others = [i for i in index.get(("set", row["gid"], name), []) if i.get("number") != row["number"]]
    set_name = ((groups.get(str(row["gid"])) or {}).get("name") or "").lower()
    # Promo and mixed-year sets hold many unrelated cards with one name (every Pikachu promo), so skip them.
    one_release = "promo" not in set_name and not any(w in set_name for w in config.FRAME_SKIP_WORDS)
    if one_release and len({i["number"] for i in others}) < SAME_SET_MAX:
        for item in others:
            add(item, "set")
    out.sort(key=lambda v: (v["rel"] != "same", v["productId"] != row["productId"], -v["price"]))
    return out[:limit]


def _balanced(rows, each):
    """Risers and fallers in equal numbers where both exist, biggest move first.

    Goes a little deeper than needed on each side so the per-set limit can skip a row.
    """
    ups = [r for r in rows if r["ch7"] > 0]
    downs = [r for r in rows if r["ch7"] < 0]
    take_up = max(each, 2 * each - len(downs))
    take_down = max(each, 2 * each - len(ups))
    head = sorted(ups[:take_up] + downs[:take_down], key=lambda r: abs(r["ch7"]), reverse=True)
    rest = ups[take_up:] + downs[take_down:]
    return head + sorted(rest, key=lambda r: abs(r["ch7"]), reverse=True)


def make_categories(rows, span=7, catalog=None):
    global SPAN
    SPAN = span
    index = variant_index(catalog) if catalog else None
    all_rows = rows
    rows = [r for r in all_rows if r["ch7"] is not None]
    categories, counts, used = [], {}, set()
    for spec in LISTS:
        list_id, title, short, blurb, color, label, (test, rank, score, reason), rule = spec
        eligible = sorted((r for r in rows if test(r)), key=rank, reverse=True)
        if list_id == "modern-sealed" and len(eligible) < 3:
            list_id, title, short, blurb, color, label, (test, rank, score, reason), rule = SEALED_FALLBACK
            eligible = sorted((r for r in all_rows if test(r)), key=rank, reverse=True)
        if list_id == "big-movers":
            eligible = _balanced(eligible, config.PICKS_PER_LIST // 2)
        counts[list_id] = len(eligible)
        picks, seen_products, per_set = [], set(), {}
        for r in eligible:
            if r["productId"] in seen_products or r["productId"] in used or per_set.get(r["gid"], 0) >= config.MAX_PER_SET:
                continue
            seen_products.add(r["productId"])
            per_set[r["gid"]] = per_set.get(r["gid"], 0) + 1
            pick = _public(r, score(r), label, reason(r), len(picks) + 1)
            if index and r["kind"] == "single" and r["number"]:
                others = variants_for(r, index, catalog["groups"])
                if others:
                    pick["variants"] = others
            picks.append(pick)
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
