"""eBay sold prices and per-condition prices for the issue's picks, from PokeTrace.

Runs only when POKETRACE_API_KEY is set. The free plan allows 250 requests a day
(one every two seconds) and returns, for US cards, eBay sold prices for raw conditions
and TCGplayer prices by condition, each with a sale count and rolling averages.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("POKETRACE_BASE", "https://api.poketrace.com/v1").rstrip("/")
BATCH = 10          # product ids per request (the API allows 20 ids and 20 results per page)
MAX_REQUESTS = 40   # per run, well under the daily allowance
PAUSE = float(os.environ.get("POKETRACE_PAUSE", "2.2"))
KEEP = ("avg", "low", "high", "saleCount", "approxSaleCount", "avg1d", "avg7d", "avg30d",
        "median3d", "median7d", "median30d", "trend", "confidence")


class Stop(Exception):
    pass


def _get(path, params, api_key):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"X-API-Key": api_key, "User-Agent": "MarketDexWeekly/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        if err.code in (401, 403, 429):
            raise Stop(f"HTTP {err.code}") from err
        raise


def _norm(text):
    return (text or "").replace("_", " ").strip().lower()


def _tiers(block):
    out = {}
    for tier, values in (block or {}).items():
        if isinstance(values, dict):
            kept = {k: values[k] for k in KEEP if values.get(k) is not None}
            if values.get("lastUpdated"):
                kept["last"] = str(values["lastUpdated"])[:10]  # day of the most recent sale on record
            if kept.get("avg") is not None:
                out[tier] = kept
    return out


def _slim(card):
    prices = card.get("prices") or {}
    return {
        "variant": card.get("variant"),
        "updated": (card.get("lastUpdated") or "")[:10] or None,
        "ebay": _tiers(prices.get("ebay")),
        "tcgplayer": _tiers(prices.get("tcgplayer")),
    }


def fetch(product_ids, api_key, log=print):
    """Returns {productId: [slim card per variant]} and one raw card for inspection."""
    found, sample, requests_made = {}, None, 0
    ids = [str(i) for i in product_ids]
    try:
        for start in range(0, len(ids), BATCH):
            cursor = None
            for _page in range(4):
                if requests_made >= MAX_REQUESTS:
                    raise Stop("request budget for this run used")
                params = {"tcgplayer_ids": ",".join(ids[start:start + BATCH]), "market": "US", "limit": 20}
                if cursor:
                    params["cursor"] = cursor
                payload = _get("/cards", params, api_key)
                requests_made += 1
                time.sleep(PAUSE)
                for card in payload.get("data") or []:
                    pid = str((card.get("refs") or {}).get("tcgplayerId") or "")
                    if not pid:
                        continue
                    sample = sample or card
                    found.setdefault(pid, []).append(_slim(card))
                page = payload.get("pagination") or {}
                cursor = page.get("nextCursor") if page.get("hasMore") else None
                if not cursor:
                    break
    except Stop as stop:
        log(f"  PokeTrace lookups stopped: {stop}")
    except Exception as err:
        log(f"  PokeTrace lookup failed: {err}")
    return found, sample, requests_made


def top_up(issue, today, log=print):
    """Attach eBay sold and per-condition prices to each pick. Returns (requests made, raw sample)."""
    api_key = os.environ.get("POKETRACE_API_KEY", "").strip()
    if not api_key:
        log("  no POKETRACE_API_KEY set: skipping eBay sold prices")
        return 0, None
    picks = [p for c in issue["categories"] for p in c["picks"]]
    found, sample, made = fetch(sorted({p["productId"] for p in picks}), api_key, log)
    matched = 0
    for pick in picks:
        cards = found.get(str(pick["productId"])) or []
        chosen = next((c for c in cards if _norm(c["variant"]) == _norm(pick["printing"])), None)
        if not chosen and len(cards) == 1:
            chosen = cards[0]
        if chosen and (chosen["ebay"] or chosen["tcgplayer"]):
            pick["sold"] = {"date": today, "updated": chosen["updated"],
                            "ebay": chosen["ebay"], "tcgplayer": chosen["tcgplayer"]}
            matched += 1
    log(f"  PokeTrace: {made} requests, {matched} of {len(picks)} picks matched")
    return made, sample
