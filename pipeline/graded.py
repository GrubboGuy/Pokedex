"""Optional PSA prices for the issue's picks, from PokemonPriceTracker's free tier.

Runs only when PPT_API_KEY is set. The free tier allows 100 credits a day and a card
with graded data costs 2, so each run looks up a limited number of picks and caches them.

PokemonPriceTracker keeps one set of graded sales per card, not per version, so a 1st Edition
and an Unlimited copy (or a reverse holo and a plain one) share the same figures. To give each
version its own price, the individual eBay sales are kept and sorted by what their listing
titles say; a version only gets a PSA price when sales can be told apart that way.
"""

import datetime as dt
import json
import os
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config

API = os.environ.get("PPT_BASE", "https://www.pokemonpricetracker.com").rstrip("/")


def _lookup(product_id, api_key):
    query = urllib.parse.urlencode({"tcgPlayerId": product_id, "includeEbay": "true"})
    req = urllib.request.Request(
        f"{API}/api/v2/cards?{query}",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": "MarketDexWeekly/0.1"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


GRADES = ("psa10", "psa9", "psa8")
CACHE_VERSION = 2       # entries from before individual sales were kept are looked up again
SALES_KEPT = 40         # most recent sales kept per grade
MIN_SALES = 2           # a version needs this many matching sales before a price is shown

_FIRST = re.compile(r"\b1st\b|first\s+ed", re.I)
_REVERSE = re.compile(r"reverse|\brev\.?\s*(holo|foil)|\brh\b", re.I)
_NON_HOLO = re.compile(r"non[\s-]*holo", re.I)
_HOLO = re.compile(r"holo|foil", re.I)


def _grade(entry):
    if not isinstance(entry, dict):
        return None
    smart = entry.get("smartMarketPrice")
    price, confidence = None, None
    if isinstance(smart, dict):
        price, confidence = smart.get("price"), smart.get("confidence")
    price = price or entry.get("medianPrice") or entry.get("averagePrice") or entry.get("marketPrice7Day")
    if not price:
        return None
    return {"price": round(float(price), 2), "confidence": confidence,
            "sales": entry.get("count") or entry.get("salesCount")}


def _card(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        data = data[0] if data else None
    return data if isinstance(data, dict) else {}


def parse(payload):
    """Summary price per grade, as PokemonPriceTracker gives it (all versions of the card together)."""
    ebay = _card(payload).get("ebay") or {}
    by_grade = ebay.get("salesByGrade") or {}
    outliers = ebay.get("smartPriceOutlierByGrade") or {}
    out = {}
    for grade in GRADES:
        parsed = _grade(by_grade.get(grade))
        if parsed:
            if outliers.get(grade):
                parsed["outlier"] = True
            out[grade] = parsed
    return out


def parse_sales(payload):
    """Individual eBay sales per grade: [[listing title, price, sold date], ...], newest first."""
    listings = (_card(payload).get("ebay") or {}).get("soldListings") or {}
    out = {}
    for grade in GRADES:
        rows = []
        for sale in listings.get(grade) or []:
            if not isinstance(sale, dict) or not sale.get("title"):
                continue
            try:
                price = round(float(sale.get("price")), 2)
            except (TypeError, ValueError):
                continue
            if price > 0:
                rows.append([str(sale["title"])[:140], price, str(sale.get("soldDate") or "")[:10]])
        rows.sort(key=lambda r: r[2], reverse=True)
        if rows:
            out[grade] = rows[:SALES_KEPT]
    return out


def title_fits(title, printing, printings):
    """Whether an eBay listing title is for this version, given the versions the card comes in."""
    if len(printings) < 2:
        return True
    first, reverse = bool(_FIRST.search(title)), bool(_REVERSE.search(title))
    if any("1st Edition" in p for p in printings) and ("1st Edition" in printing) != first:
        return False
    if "Reverse Holofoil" in printings and (printing == "Reverse Holofoil") != reverse:
        return False
    if "Normal" in printings and "Holofoil" in printings and not reverse:
        holo = bool(_HOLO.search(_NON_HOLO.sub(" ", title)))
        if (printing == "Holofoil") != holo:
            return False
    return True


def for_version(cached, printing, printings):
    """PSA prices for one version of a card, or {} when its sales cannot be told apart.

    With individual sales on hand, the price is the middle (median) of the sales whose titles
    match this version. Without them, the card-wide summary is used only for a card that comes
    in a single version, and a figure the source itself marks as an outlier is left out.
    """
    out = {}
    sales, grades = cached.get("sold") or {}, cached.get("grades") or {}
    for grade in GRADES:
        rows = [r for r in sales.get(grade) or [] if title_fits(r[0], printing, printings)]
        if len(rows) >= MIN_SALES:
            out[grade] = {"price": round(statistics.median(r[1] for r in rows), 2), "sales": len(rows),
                          "last": max(r[2] for r in rows) or None, "basis": "sales"}
        elif len(printings) < 2 and grade in grades and not grades[grade].get("outlier"):
            out[grade] = {**grades[grade], "basis": "summary"}
    # A summary PSA 10 far above everything else, on few sales, is nearly always a mislabelled listing.
    top, nine = out.get("psa10"), out.get("psa9")
    if (top and nine and top.get("basis") == "summary" and str(top.get("confidence")).lower() == "low"
            and top["price"] > 8 * nine["price"]):
        del out["psa10"]
    return out


def _printings(pick):
    """Every version this pick's TCGplayer product comes in (its own plus the others on the same product)."""
    own = {pick["printing"]}
    for v in pick.get("variants") or []:
        if str(v.get("productId")) == str(pick["productId"]):
            own.add(v["printing"])
    return own


def top_up(issue, cache, today, log=print, fetch=True, sample=None):
    """Attach graded prices to picks and, unless fetch is off, look up missing ones. Returns lookups made.

    `sample`, if given, is a list that receives one raw API reply, so its layout can be inspected.
    """
    api_key = os.environ.get("PPT_API_KEY", "").strip() if fetch else ""
    today_d = dt.date.fromisoformat(today)
    made = 0
    singles = [p for c in issue["categories"] for p in c["picks"] if p["kind"] == "single"]
    # Cards that come in more than one version first: they are the ones that need individual sales.
    singles.sort(key=lambda p: (len(_printings(p)) < 2, -p["price"]))
    shown = split = 0
    for pick in singles:
        pid = str(pick["productId"])
        cached = cache.get(pid)
        fresh = (cached and cached.get("v") == CACHE_VERSION
                 and (today_d - dt.date.fromisoformat(cached["date"])).days <= config.GRADED_MAX_AGE_DAYS)
        if not fresh and api_key and made < config.GRADED_LOOKUPS_PER_RUN:
            try:
                payload = _lookup(pick["productId"], api_key)
                if sample is not None and not sample and parse_sales(payload):
                    sample.append(payload)
                cache[pid] = cached = {"date": today, "v": CACHE_VERSION,
                                       "grades": parse(payload), "sold": parse_sales(payload)}
                made += 1
                time.sleep(1.1)
            except urllib.error.HTTPError as err:
                log(f"  graded lookup stopped: HTTP {err.code}")
                if err.code in (401, 403, 429):
                    api_key = ""  # bad key or out of credits: stop for this run
            except Exception as err:
                log(f"  graded lookup failed for {pid}: {err}")
        pick.pop("graded", None)
        if not cached:
            continue
        printings = _printings(pick)
        figures = for_version(cached, pick["printing"], printings)
        if figures:
            pick["graded"] = {"date": cached["date"], **figures}
            shown += 1
            split += len(printings) > 1
    if fetch and not os.environ.get("PPT_API_KEY", "").strip():
        log("  no PPT_API_KEY set: skipping graded prices")
    log(f"  PSA prices shown on {shown} of {len(singles)} cards ({split} matched to a version by sale titles)")
    return made
