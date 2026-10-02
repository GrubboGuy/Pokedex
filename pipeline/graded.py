"""Optional PSA prices for the issue's picks, from PokemonPriceTracker's free tier.

Runs only when PPT_API_KEY is set. The free tier allows 100 credits a day and a card
with graded data costs 2, so each run looks up a limited number of picks and caches them.
"""

import datetime as dt
import json
import os
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


def parse(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict):
        return {}
    by_grade = ((data.get("ebay") or {}).get("salesByGrade")) or {}
    out = {}
    for grade in ("psa10", "psa9", "psa8"):
        parsed = _grade(by_grade.get(grade))
        if parsed:
            out[grade] = parsed
    return out


def top_up(issue, cache, today, log=print):
    """Attach cached graded prices to picks and fetch a few missing ones. Returns lookups made."""
    api_key = os.environ.get("PPT_API_KEY", "").strip()
    today_d = dt.date.fromisoformat(today)
    made = 0
    singles = [p for c in issue["categories"] for p in c["picks"] if p["kind"] == "single"]
    singles.sort(key=lambda p: -p["price"])
    for pick in singles:
        pid = str(pick["productId"])
        cached = cache.get(pid)
        fresh = cached and (today_d - dt.date.fromisoformat(cached["date"])).days <= config.GRADED_MAX_AGE_DAYS
        if not fresh and api_key and made < config.GRADED_LOOKUPS_PER_RUN:
            try:
                grades = parse(_lookup(pick["productId"], api_key))
                cache[pid] = cached = {"date": today, "grades": grades}
                made += 1
                time.sleep(1.1)
            except urllib.error.HTTPError as err:
                log(f"  graded lookup stopped: HTTP {err.code}")
                if err.code in (401, 403, 429):
                    api_key = ""  # bad key or out of credits: stop for this run
            except Exception as err:
                log(f"  graded lookup failed for {pid}: {err}")
        if cached and cached.get("grades"):
            pick["graded"] = {"date": cached["date"], **cached["grades"]}
    if not os.environ.get("PPT_API_KEY", "").strip():
        log("  no PPT_API_KEY set: skipping graded prices")
    return made
