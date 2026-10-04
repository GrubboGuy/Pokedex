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
ITEM_URL = os.environ.get("EBAY_ITEM_URL", "https://api.ebay.com/buy/browse/v1/item")
SCOPE = "https://api.ebay.com/oauth/api_scope"
SINGLES_CATEGORY = "183454"   # Collectible Card Games > Individual Cards
SHIP_TO = "country=US,zip=60601"  # only used so eBay can work out shipping; any US address does
MAX_SEARCHES = 150
DETAIL_TRIES = 6      # listings opened per card to read the stated condition, cheapest first
MAX_DETAILS = 300     # per run, so a day of runs stays far inside the allowance
PAGE = 50
PAUSE = float(os.environ.get("EBAY_PAUSE", "0.25"))
# The "Cheaper on eBay" scan: often-traded cards beyond the picks, looking for clean copies under market.
DEAL_MAX_SHARE = 0.85   # a deal is at least 15% under the market price, shipping included
DEAL_MIN_SHARE = 0.6    # and not so far under that it is probably something else
DEAL_TRIES = 4          # listings opened per card
DAILY_CALLS = 4200      # stay under eBay's default 5,000 calls a day

MIN_SHARE = {"single": 0.4, "sealed": 0.8}  # a listing under this share of the market price is not counted
# A clean copy far under the market price is nearly always something else (another language, a fake,
# a mislabelled card), so the bar depends on the condition the seller declared.
MIN_SHARE_BY_CONDITION = (("moderately", 0.4), ("lightly", 0.5), ("", 0.6))
# Sealed product types: a listing naming a type the product is not (an Elite Trainer Box when we
# want a Booster Box) is a different product, however many other words match.
SEALED_TYPES = (("elite trainer box", "etb"), ("booster box",), ("booster bundle",), ("booster pack", "single pack", "1 pack"),
                ("blister",), ("tin",), ("collection",), ("build & battle", "build and battle"), ("half",), ("deck",))

_JUNK = re.compile(
    r"\b(proxy|custom|reprint|replica|fan\s*art|orica|digital|online code|code card|ptcg[ol]|tcg live"
    r"|lot|bundle|playset|choose|pick your|you pick|u pick|complete your|select your|singles"
    r"|japanese|japan|jpn|jp|korean|kor|chinese|chn|german|french|italian|spanish|portuguese|thai|indonesian"
    r"|sv\d+[a-z]|s\d+[a-z]|sm\d+[a-z]"            # Japanese set codes such as SV2a, s12a
    r"|empty|no cards|box only|opened|case of|sleeve|sleeves|binder|playmat|coin|pin|sticker|keychain)\b", re.I)
# For single cards only: graded slabs, beaten-up copies, and accessories sold under the card's name.
_JUNK_SINGLE = re.compile(
    r"\b(psa|cgc|bgs|sgc|tag \d|ace \d|graded|slab"
    r"|damaged|dmg|dm|creased|crease|heavily played|poor|water damage"
    r"|case|cases|insert|display|magnetic|acrylic|stand|holder|toploader|metal|gold plated)\b"
    r"|(?<![0-9])(?<![0-9] )\bhp\b", re.I)      # "HP" as a condition, not "150 HP"
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
    # The cheapest results are otherwise all the plain version, and this one never reaches the first page.
    if "1st Edition" in pick["printing"]:
        words.append("1st")
    if pick["printing"] == "Reverse Holofoil":
        words.append("reverse")
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
    options = item.get("buyingOptions") or ["FIXED_PRICE"]
    if item.get("itemGroupType") or "FIXED_PRICE" not in options or "AUCTION" in options:
        return False  # choose-your-card listings quote the cheapest option; an auction's Buy It Now goes once bidding starts
    if (item.get("price") or {}).get("currency") not in (None, "USD"):
        return False
    own = _plain(pick.get("name"))
    hits = list(_JUNK.finditer(title)) + (list(_JUNK_SINGLE.finditer(title)) if pick["kind"] == "single" else [])
    if any(_plain(hit.group(0)) not in own for hit in hits):
        return False  # a junk word counts unless it is part of the product's own name ("Pin Collection")
    plain = _plain(title)
    if not all(token in plain for token in _name_tokens(pick)):
        return False
    if pick["kind"] != "single":
        def has(text, words):
            return any(re.search(rf"\b{re.escape(w)}\b", text) for w in words)
        lowered, name = title.lower(), (pick.get("name") or "").lower()
        return not any(has(lowered, kind) and not has(name, kind) for kind in SEALED_TYPES)
    if _JUMBO.search(title) and "jumbo" not in (pick.get("set") or "").lower():
        return False
    printed, _padded = _number(pick)
    if printed:
        number = re.escape(printed.lower())
        if not re.search(rf"(?<![0-9])0*{number}(?![0-9])", title.lower()):
            return False
    return title_fits(title, pick["printing"], printings)


def _printings(pick):
    own = {pick["printing"]}
    for v in pick.get("variants") or []:
        if str(v.get("productId")) == str(pick["productId"]):
            own.add(v["printing"])
    return own


def candidates(items, pick):
    """Every listing that fits, cheapest first, in the shape stored on the pick."""
    printings, floor = _printings(pick), (pick.get("price") or 0) * MIN_SHARE.get(pick["kind"], 0.4)
    out = []
    for item in items:
        if not fits(item, pick, printings):
            continue
        price, shipping = total_cost(item)
        if price is None or price + shipping < floor:
            continue
        out.append({"total": round(price + shipping, 2), "price": round(price, 2), "shipping": round(shipping, 2),
                    "title": (item.get("title") or "")[:100], "itemId": item.get("itemId"),
                    "url": (item.get("itemWebUrl") or "").split("?")[0]})
    out.sort(key=lambda c: c["total"])
    return out


def _item(token, item_id):
    req = urllib.request.Request(f"{ITEM_URL}/{urllib.parse.quote(item_id, safe='')}", headers={
        "Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "X-EBAY-C-ENDUSERCTX": "contextualLocation=" + urllib.parse.quote(SHIP_TO)})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        if err.code in (401, 403, 429):
            raise Stop(f"HTTP {err.code}") from err
        return {}  # the listing ended between the search and this call


def listing_language(detail):
    """The language the seller filed the card under ("English", "Japanese"), or None if not given."""
    for aspect in detail.get("localizedAspects") or []:
        if str(aspect.get("name") or "").strip().lower() == "language" and aspect.get("value"):
            return str(aspect["value"]).strip()
    return None


def established_seller(detail):
    """Whether the seller has a track record. Read to judge the listing; never stored."""
    seller = detail.get("seller") or {}
    try:
        return int(seller.get("feedbackScore") or 0) >= 25 and float(seller.get("feedbackPercentage") or 0) >= 97
    except (TypeError, ValueError):
        return False


def card_condition(detail):
    """The seller's stated card condition ("Near Mint or Better", "Lightly Played (Excellent)"), or None."""
    for block in detail.get("conditionDescriptors") or []:
        if "condition" in str(block.get("name") or "").lower():
            for value in block.get("values") or []:
                text = value.get("content") if isinstance(value, dict) else value
                if text:
                    return re.sub(r"\s*\(.*?\)\s*$", "", str(text)).strip()
    return None


def _scrub(payload):
    """A raw reply with everything about sellers removed, kept so the data layout can be checked."""
    out = dict(payload)
    out["itemSummaries"] = [{k: v for k, v in item.items() if k != "seller"}
                            for item in (payload.get("itemSummaries") or [])[:12]]
    return out


def _scrub_item(detail):
    keep = ("itemId", "title", "price", "condition", "conditionId", "conditionDescriptors", "localizedAspects", "shippingOptions",
            "itemWebUrl", "categoryPath", "estimatedAvailabilities")
    return {k: detail[k] for k in keep if k in detail}


def top_up(issue, log=print, budget=MAX_SEARCHES * 3):
    """Attach the cheapest matching eBay listing to each pick.

    For single cards the cheapest few are opened to read the condition the seller declared, and
    heavily played copies are passed over. Returns (calls made, scrubbed raw replies to inspect).
    """
    client_id = os.environ.get("EBAY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("EBAY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        log("  no eBay keys set: skipping live eBay prices")
        return 0, None
    # The "Cheaper on eBay" list is built from listings found by its own scan; those stay as found.
    picks = [p for c in issue["categories"] if c["id"] != "ebay-deals" for p in c["picks"]]
    made, details, matched, stated, sample = 0, 0, 0, 0, {}
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    try:
        token = _token(client_id, client_secret)
        for pick in picks:
            if made >= MAX_SEARCHES or made + details >= budget:
                break
            single = pick["kind"] == "single"
            floor = (pick.get("price") or 0) * MIN_SHARE.get(pick["kind"], 0.4)
            # The range is on the item price alone; leave room for shipping on cheap cards only.
            payload = _search(token, query_for(pick), single, floor * (0.6 if floor < 20 else 0.85 if single else 0.95))
            made += 1
            time.sleep(PAUSE)
            if "search" not in sample and payload.get("itemSummaries"):
                sample["search"] = {**_scrub(payload), "_query": query_for(pick)}
            found = candidates(payload.get("itemSummaries") or [], pick)
            pick.pop("ebayLow", None)
            best = None
            for choice in found[:DETAIL_TRIES] if single else found[:1]:
                condition = None
                if single and details < MAX_DETAILS and choice.get("itemId"):
                    detail = _item(token, choice["itemId"])
                    details += 1
                    time.sleep(PAUSE)
                    if "item" not in sample and detail:
                        sample["item"] = _scrub_item(detail)
                    if not detail:
                        continue
                    condition = card_condition(detail)
                    if condition and re.search(r"heavily|poor|damaged", condition, re.I):
                        continue
                    language = listing_language(detail)
                    if language and not language.lower().startswith("english"):
                        continue
                if single:
                    share = next(s for word, s in MIN_SHARE_BY_CONDITION if word in (condition or "").lower())
                    if choice["total"] < share * (pick.get("price") or 0):
                        continue
                best = {**choice, "condition": condition}
                break
            if best:
                pick["ebayLow"] = {**best, "at": now, "matches": len(found)}
                matched += 1
                stated += bool(best.get("condition"))
    except Stop as stop:
        log(f"  eBay lookups stopped: {stop}")
    except Exception as err:
        log(f"  eBay lookup failed: {err}")
    log(f"  eBay: {made} searches and {details} listing checks; a matching listing found for {matched} of "
        f"{len(picks)} picks ({stated} with the seller's condition stated)")
    return made + details, sample or None


def calls_left(data_dir):
    """How many more eBay calls today's budget allows, from the tally kept between runs."""
    day = dt.datetime.now(dt.timezone.utc).date().isoformat()
    try:
        with open(os.path.join(data_dir, "ebay-usage.json"), encoding="utf-8") as fh:
            tally = json.load(fh)
    except (OSError, ValueError):
        tally = {}
    used = tally.get("calls", 0) if tally.get("day") == day else 0
    return max(0, DAILY_CALLS - used)


def record_calls(data_dir, made):
    day = dt.datetime.now(dt.timezone.utc).date().isoformat()
    used = DAILY_CALLS - calls_left(data_dir) + made
    try:
        with open(os.path.join(data_dir, "ebay-usage.json"), "w", encoding="utf-8") as fh:
            json.dump({"day": day, "calls": used}, fh)
    except OSError:
        pass


def scan_deals(pool, budget, log=print):
    """Looks through often-traded cards for a Near Mint copy listed well under the market price.

    `pool` holds picks-in-waiting (a row plus the card's other printings). Returns
    (deals, calls made, time checked); time checked is None when the scan did not run, so the
    caller keeps whatever list it already had. Each deal is (card, listing, share of market price).
    """
    client_id = os.environ.get("EBAY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("EBAY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return [], 0, None
    need = len(pool) * 2
    if budget < need:
        log(f"  eBay deal scan skipped: {budget} calls left today, about {need} needed")
        return [], 0, None
    deals, made, complete = [], 0, False
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    try:
        token = _token(client_id, client_secret)
        for card in pool:
            if made >= budget:
                break
            price = card["price"]
            payload = _search(token, query_for(card), True, price * DEAL_MIN_SHARE * 0.85)
            made += 1
            time.sleep(PAUSE)
            cheap = [c for c in candidates(payload.get("itemSummaries") or [], card)
                     if price * DEAL_MIN_SHARE <= c["total"] <= price * DEAL_MAX_SHARE]
            for choice in cheap[:DEAL_TRIES]:
                if not choice.get("itemId"):
                    continue
                detail = _item(token, choice["itemId"])
                made += 1
                time.sleep(PAUSE)
                condition = card_condition(detail) if detail else None
                language = (listing_language(detail) or "") if detail else ""
                # A deal has to be stated plainly: Near Mint, filed as English, from a seller with a record.
                if (condition and "near mint" in condition.lower() and language.lower().startswith("english")
                        and established_seller(detail)):
                    deals.append((card, {**choice, "condition": condition, "at": now, "matches": len(cheap)},
                                  choice["total"] / price))
                    break
        complete = True
    except Stop as stop:
        log(f"  eBay deal scan stopped: {stop}")
    except Exception as err:
        log(f"  eBay deal scan failed: {err}")
    log(f"  eBay deal scan: {len(pool)} often-traded cards, {made} calls, {len(deals)} Near Mint English copies "
        f"from established sellers at least {round((1 - DEAL_MAX_SHARE) * 100)}% under market")
    return deals, made, (now if complete else None)
