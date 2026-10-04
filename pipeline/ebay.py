"""The cheapest matching Buy It Now listing on eBay for each pick, with shipping, from eBay's Browse API.

Runs only when EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are set (a production keyset from
developer.ebay.com). The default allowance is 5,000 calls a day; a run makes one search per pick.

A search returns whatever eBay thinks is relevant, so every listing is checked before it counts:
the title has to name this card and its number, it has to be this version (not the reverse holo
or 1st Edition of the same card), and it must not be a graded slab, a lot, a proxy, a
choose-your-card listing or another language. A price far under the market price is nearly
always the wrong item, so those are left out too.

Only the listing itself is kept (title, price, shipping, link). Nothing about the seller is stored.
"""

import base64
import datetime as dt
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .graded import title_fits

TOKEN_URL = os.environ.get("EBAY_TOKEN_URL", "https://api.ebay.com/identity/v1/oauth2/token")
SEARCH_URL = os.environ.get("EBAY_SEARCH_URL", "https://api.ebay.com/buy/browse/v1/item_summary/search")
SCOPE = "https://api.ebay.com/oauth/api_scope"
SINGLES_CATEGORY = "183454"   # Collectible Card Games > Individual Cards
SHIP_TO = "country=US,zip=60601"  # only used so eBay can work out shipping; any US address does
MAX_SEARCHES = 150
PAGE = 50
PAUSE = float(os.environ.get("EBAY_PAUSE", "0.25"))
MIN_SHARE = {"single": 0.4, "sealed": 0.65}  # a listing under this share of the market price is not counted

_JUNK = re.compile(
    r"\b(proxy|custom|reprint|replica|fan\s*art|orica|digital|online code|code card|ptcg[ol]|tcg live"
    r"|lot|bundle|playset|choose|pick your|you pick|u pick|complete your|select your|singles"
    r"|psa|cgc|bgs|sgc|tag \d|ace \d|graded|slab"
    r"|damaged|creased|crease|heavily played|poor"
    r"|japanese|japan|korean|chinese|german|french|italian|spanish|portuguese|thai|indonesian"
    r"|empty|no cards|box only|opened|case of|sleeve|sleeves|binder|playmat|coin|pin|sticker|keychain)\b", re.I)
_JUMBO = re.compile(r"\b(jumbo|oversized?)\b", re.I)
_NOTES = re.compile(r"[(\[]\s*(\d+|full art|secret|alternate full art|alternate art secret|alpha|omega|delta)\s*[)\]]", re.I)
_STOP = {"the", "and", "pokemon", "card", "with"}


class Stop(Exception):
    pass


def _token(client_id, client_secret):
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "scope": SCOPE}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        "Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())["access_token"]
    except urllib.error.HTTPError as err:
        raise Stop(f"eBay would not issue an access token (HTTP {err.code}): check the two secrets, and that the "
                   f"production keyset is enabled") from err


def _search(token, query, single, min_price=0):
    # Starting the price range just under the lowest price we would accept keeps the first page
    # from filling up with cheap unrelated items.
    params = {"q": query, "limit": PAGE, "sort": "price",
              "filter": "buyingOptions:{FIXED_PRICE},itemLocationCountry:US"
                        + (f",price:[{min_price:.2f}..],priceCurrency:USD" if min_price >= 0.5 else "")
                        + (",conditionIds:{4000}" if single else ",conditions:{NEW}")}
    if single:
        params["category_ids"] = SINGLES_CATEGORY
    req = urllib.request.Request(f"{SEARCH_URL}?{urllib.parse.urlencode(params)}", headers={
        "Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "X-EBAY-C-ENDUSERCTX": "contextualLocation=" + urllib.parse.quote(SHIP_TO)})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        detail = err.read()[:300].decode("utf-8", "replace")
        if err.code in (401, 403, 429):
            raise Stop(f"HTTP {err.code} {detail}") from err
        raise RuntimeError(f"HTTP {err.code} for {query!r}: {detail}") from err


def clean_name(pick):
    """The card's name the way a seller would write it: without TCGplayer's catalogue notes."""
    name = pick.get("name") or ""
    if pick.get("number"):
        name = name.replace(f" - {pick['number']}", " ")
    name = re.sub(r"\s+-\s+[A-Za-z0-9]+/[A-Za-z0-9]+$", "", name)
    name = _NOTES.sub(" ", name)
    name = re.sub(r"[()\[\]]", " ", name)
    name = re.sub(r"\bpattern\b", " ", name, flags=re.I)
    return re.sub(r"\s+", " ", name).strip()


def _number(pick):
    """The card number as printed, and as TCGplayer pads it ('6' and '006')."""
    raw = str(pick.get("number") or "").split("/")[0].strip()
    if not raw:
        return None, None
    return (raw.lstrip("0") or "0") if raw.isdigit() else raw, raw


def _set_words(pick):
    name = pick.get("set") or ""
    if not name or "promo" in name.lower():
        return ""
    return re.sub(r"^[A-Z0-9]+\s*[:\-]\s*", "", name)


def query_for(pick):
    if pick["kind"] != "single":
        return f"{clean_name(pick)} pokemon"
    words = [clean_name(pick)]
    printed, padded = _number(pick)
    if printed:
        words.append(printed if printed == padded else f"({printed},{padded})")
    if _set_words(pick):
        words.append(_set_words(pick))
    return " ".join(words)


def _plain(text):
    return re.sub(r"[^a-z0-9 ]+", "", (text or "").lower().replace("é", "e").replace("-", " ").replace("/", " "))


def _name_tokens(pick):
    return [t for t in _plain(clean_name(pick)).split() if len(t) >= 3 and t not in _STOP]


def total_cost(item):
    """Price plus the cheapest shipping eBay quotes, or None when shipping is not given."""
    try:
        price = float(item["price"]["value"])
    except (KeyError, TypeError, ValueError):
        return None, None
    costs = []
    for option in item.get("shippingOptions") or []:
        cost = (option.get("shippingCost") or {}).get("value")
        if cost is not None:
            try:
                costs.append(float(cost))
            except ValueError:
                pass
    if not costs:
        return None, None
    return price, min(costs)


def fits(item, pick, printings):
    """Whether a search result is really this card, in this version, as a normal single listing."""
    title = item.get("title") or ""
    if item.get("itemGroupType") or "FIXED_PRICE" not in (item.get("buyingOptions") or ["FIXED_PRICE"]):
        return False  # choose-your-card listings quote the cheapest option, not this card
    if (item.get("price") or {}).get("currency") not in (None, "USD"):
        return False
    own = _plain(pick.get("name"))
    if any(_plain(hit.group(0)) not in own for hit in _JUNK.finditer(title)):
        return False  # a junk word counts unless it is part of the product's own name ("Pin Collection")
    plain = _plain(title)
    if not all(token in plain for token in _name_tokens(pick)):
        return False
    if pick["kind"] != "single":
        return True
    if _JUMBO.search(title) and "jumbo" not in (pick.get("set") or "").lower():
        return False
    printed, _padded = _number(pick)
    if printed:
        number = re.escape(printed.lower())
        if not re.search(rf"(?<![a-z0-9])0*{number}(?![0-9])", title.lower()):
            return False
    return title_fits(title, pick["printing"], printings)


def _printings(pick):
    own = {pick["printing"]}
    for v in pick.get("variants") or []:
        if str(v.get("productId")) == str(pick["productId"]):
            own.add(v["printing"])
    return own


def cheapest(items, pick):
    """The lowest-cost listing that fits, as stored on the pick, plus how many fitted."""
    printings, floor = _printings(pick), (pick.get("price") or 0) * MIN_SHARE.get(pick["kind"], 0.4)
    best, count = None, 0
    for item in items:
        if not fits(item, pick, printings):
            continue
        price, shipping = total_cost(item)
        if price is None or price + shipping < floor:
            continue
        count += 1
        if best is None or price + shipping < best["total"]:
            best = {"total": round(price + shipping, 2), "price": round(price, 2), "shipping": round(shipping, 2),
                    "title": (item.get("title") or "")[:100], "itemId": item.get("itemId"),
                    "url": (item.get("itemWebUrl") or "").split("?")[0]}
    return best, count


def _scrub(payload):
    """A raw reply with everything about sellers removed, kept so the data layout can be checked."""
    out = dict(payload)
    out["itemSummaries"] = [{k: v for k, v in item.items() if k != "seller"}
                            for item in (payload.get("itemSummaries") or [])[:12]]
    return out


def top_up(issue, log=print):
    """Attach the cheapest matching eBay listing to each pick. Returns (searches made, a scrubbed raw reply)."""
    client_id = os.environ.get("EBAY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("EBAY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        log("  no eBay keys set: skipping live eBay prices")
        return 0, None
    picks = [p for c in issue["categories"] for p in c["picks"]]
    made, matched, sample = 0, 0, None
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    try:
        token = _token(client_id, client_secret)
        for pick in picks:
            if made >= MAX_SEARCHES:
                break
            floor = (pick.get("price") or 0) * MIN_SHARE.get(pick["kind"], 0.4)
            payload = _search(token, query_for(pick), pick["kind"] == "single", floor * 0.6)
            made += 1
            time.sleep(PAUSE)
            if sample is None and payload.get("itemSummaries"):
                sample = _scrub(payload)
                sample["_query"] = query_for(pick)
            best, count = cheapest(payload.get("itemSummaries") or [], pick)
            pick.pop("ebayLow", None)
            if best:
                pick["ebayLow"] = {**best, "at": now, "matches": count}
                matched += 1
    except Stop as stop:
        log(f"  eBay lookups stopped: {stop}")
    except Exception as err:
        log(f"  eBay lookup failed: {err}")
    log(f"  eBay: {made} searches, a matching listing found for {matched} of {len(picks)} picks")
    return made, sample
