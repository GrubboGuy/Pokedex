"""Checks that an eBay listing's photo shows the same card as the catalogue picture.

A seller can file a card under the wrong catalogue entry, and then the title, number, set and
language all match while the photo shows something else. The only way to catch that is to look.

How it looks: both pictures are reduced to their fine detail (SIFT keypoints). Points that look
alike in both are paired, and only pairs that agree on one flat-card position are kept, so a
photo taken at an angle, in a sleeve or on a desk still matches.

Cards of one design share their frame, symbols and rules text, and a different card matches on
those too. So before comparing, everything the card has in common with other cards of its set and
rarity is thrown away, and only the points that belong to this card alone are counted.

Measured on real listings (October 2026): the right card scored 46 and up, typically several
hundred; four listings known to show the wrong card scored 5 to 9; a listing deliberately checked
against another card of its set never scored above 37. A blurry, tiny or glare-covered photo of
the right card can fall below the pass mark too, and is then treated as unconfirmed.

Needs OpenCV (installed by the workflow). Without it nothing is checked and nothing is filtered.
"""

import re
import urllib.request

try:
    import cv2
    import numpy as np
except Exception:  # not installed: the photo check is skipped
    cv2 = None

PASS_MARK = 110          # points of the card's own detail that must be found in the listing photo
CATALOGUE_SIDE = 720     # pictures are scaled so their longer side is this many pixels
LISTING_SIDE = 1400      # listing photos are compared larger: the card is often small in the frame
CATALOGUE_POINTS = 2500
LISTING_POINTS = 6000
DECOYS = 2               # other cards of the same design used to find what the design shares

_cache = {}              # work kept for the length of a run
_by_design = None        # (set, rarity) -> catalogue items, built on first use


def available():
    return cv2 is not None


def catalogue_picture(image_url):
    """TCGplayer's large picture of a card, from the small one stored on a pick."""
    return (image_url or "").replace("_200w.", "_in_1000x1000.")


def listing_picture(image_url):
    """The full-size copy of an eBay listing photo (the search gives a thumbnail)."""
    return re.sub(r"s-l\d+\.", "s-l1600.", image_url or "")


_pictures = {}           # the last few pictures loaded


def _picture(url, side):
    """A picture in grey, scaled so its longer side is at most `side` pixels."""
    if (url, side) not in _pictures:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; PokedexDaily/1.0)"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            image = cv2.imdecode(np.frombuffer(resp.read(), np.uint8), cv2.IMREAD_GRAYSCALE)
        scale = side / max(image.shape[:2])
        if scale < 1:
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        while len(_pictures) >= 6:
            _pictures.pop(next(iter(_pictures)))
        _pictures[(url, side)] = image
    return _pictures[(url, side)]


def _points(url, side, count):
    """(keypoints, descriptors, width, height) of a picture, or None if it cannot be loaded."""
    key = (url, side, count)
    if key not in _cache:
        try:
            image = _picture(url, side)
            points, desc = cv2.SIFT_create(nfeatures=count).detectAndCompute(image, None)
            usable = desc is not None and len(points) >= 8
            _cache[key] = (points, desc, image.shape[1], image.shape[0]) if usable else None
        except Exception:
            _cache[key] = None
    return _cache[key]


def _own_points(catalogue_url, decoy_urls):
    """The points of a catalogue picture that belong to this card alone.

    Whatever also appears, in the same place, on other cards of the same design is dropped.
    """
    key = ("own", catalogue_url, tuple(decoy_urls))
    if key in _cache:
        return _cache[key]
    card = _points(catalogue_url, CATALOGUE_SIDE, CATALOGUE_POINTS)
    if not card:
        _cache[key] = None
        return None
    points, desc, width, height = card
    shared = np.zeros(len(points), dtype=bool)
    for url in decoy_urls:
        decoy = _points(url, CATALOGUE_SIDE, CATALOGUE_POINTS)
        if not decoy:
            continue
        for pair in cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, decoy[1], k=2):
            if len(pair) == 2 and pair[0].distance < 0.8 * pair[1].distance:
                ax, ay = points[pair[0].queryIdx].pt
                bx, by = decoy[0][pair[0].trainIdx].pt
                if abs(ax / width - bx / decoy[2]) < 0.04 and abs(ay / height - by / decoy[3]) < 0.04:
                    shared[pair[0].queryIdx] = True
    keep = [i for i in range(len(points)) if not shared[i]]
    _cache[key] = ([points[i] for i in keep], desc[keep])
    return _cache[key]


def own_score(catalogue_url, decoy_urls, listing_url):
    """How many of the card's own points are found, in the right places, in the listing photo.

    None when a picture could not be loaded or OpenCV is missing.
    """
    if cv2 is None or not catalogue_url or not listing_url:
        return None
    own = _own_points(catalogue_url, decoy_urls)
    photo = _points(listing_url, LISTING_SIDE, LISTING_POINTS)
    if not own or not photo:
        return None
    points, desc = own
    if len(points) < 8:
        return 0
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, photo[1], k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < 8:
        return 0
    src = np.float32([points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([photo[0][m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    _homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return int(mask.sum()) if mask is not None else 0


def _plain_name(name):
    return (name or "").split(" - ")[0].split(" (")[0].strip().lower()


def decoys_for(card, catalog, count=DECOYS):
    """Catalogue pictures of other cards of the same design: same set and rarity, a different name."""
    global _by_design
    if _by_design is None:
        _by_design = {}
        for item in catalog["items"]:
            if item["kind"] == "single" and item.get("image"):
                _by_design.setdefault((item["gid"], item.get("rarity")), []).append(item)
    mine = _plain_name(card.get("name"))
    out = []
    for item in _by_design.get((card.get("gid"), card.get("rarity")), []):
        if item["id"] != card.get("productId") and _plain_name(item["name"]) != mine:
            out.append(catalogue_picture(item["image"]))
            if len(out) == count:
                break
    return out


def check(card, listing, catalog):
    """(confirmed, score) for a card and an eBay listing that is meant to be it.

    confirmed is True when the photo shows this card, False when it does not or cannot be told,
    and None when the check could not run at all (no OpenCV), in which case nothing is filtered.
    """
    if cv2 is None:
        return None, None
    if not card.get("image") or not listing.get("img"):
        return False, None
    found = own_score(catalogue_picture(card["image"]), decoys_for(card, catalog), listing_picture(listing["img"]))
    return (found is not None and found >= PASS_MARK), found


# ---- Tuning record (temporary): what each comparison found, point by point, so the rule can be
# ---- worked out from real listings. Holds pictures' addresses and item numbers, nothing on sellers.

TRACE = {"cards": {}, "listings": []}
SHOTS = {}               # file name -> JPEG: each card, and each listing photo flattened onto the card's outline
FLAT = (432, 605)
_seen = set()
_by_name = None


def _shared_with(points, desc, width, height, url):
    """Two yes/no lists per point: also on the other card anywhere, and also on it in the same place."""
    anywhere = np.zeros(len(points), dtype=bool)
    in_place = np.zeros(len(points), dtype=bool)
    other = _points(url, CATALOGUE_SIDE, CATALOGUE_POINTS)
    if other:
        for pair in cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, other[1], k=2):
            if len(pair) == 2 and pair[0].distance < 0.8 * pair[1].distance:
                anywhere[pair[0].queryIdx] = True
                ax, ay = points[pair[0].queryIdx].pt
                bx, by = other[0][pair[0].trainIdx].pt
                if abs(ax / width - bx / other[2]) < 0.04 and abs(ay / height - by / other[3]) < 0.04:
                    in_place[pair[0].queryIdx] = True
    return anywhere, in_place


def _same_name(card, catalog, count=3):
    global _by_name
    if _by_name is None:
        _by_name = {}
        for item in catalog["items"]:
            if item["kind"] == "single" and item.get("image"):
                _by_name.setdefault(_plain_name(item["name"]), []).append(item)
    mine = card.get("productId")
    others = [i for i in _by_name.get(_plain_name(card.get("name")), []) if i["id"] != mine]
    others.sort(key=lambda i: (i["gid"] != card.get("gid"), abs(i["id"] - (mine or 0))))
    return others[:count]


def record(card, listing, catalog, where):
    """Adds one comparison to the tuning record."""
    if cv2 is None or not card.get("image") or not listing.get("img"):
        return
    pid = card.get("productId")
    if (pid, listing["img"]) in _seen:
        return
    _seen.add((pid, listing["img"]))
    base = _points(catalogue_picture(card["image"]), CATALOGUE_SIDE, CATALOGUE_POINTS)
    photo = _points(listing_picture(listing["img"]), LISTING_SIDE, LISTING_POINTS)
    entry = {"card": pid, "item": listing.get("itemId"), "img": listing["img"], "title": listing.get("title"),
             "total": listing.get("total"), "price": card.get("price"), "where": where}
    TRACE["listings"].append(entry)
    if not base or not photo:
        entry["failed"] = "catalogue" if not base else "listing"
        return
    points, desc, width, height = base
    if str(pid) not in TRACE["cards"]:
        flags = np.zeros(len(points), dtype=np.int32)
        set_decoys = decoys_for(card, catalog)
        for n, url in enumerate(set_decoys):
            flags |= _shared_with(points, desc, width, height, url)[1].astype(np.int32) << n
        named = _same_name(card, catalog)
        for n, item in enumerate(named):
            anywhere, in_place = _shared_with(points, desc, width, height, catalogue_picture(item["image"]))
            flags |= anywhere.astype(np.int32) << (2 + n)
            flags |= in_place.astype(np.int32) << (5 + n)
        try:
            flat = cv2.resize(_picture(catalogue_picture(card["image"]), CATALOGUE_SIDE), FLAT, interpolation=cv2.INTER_AREA)
            SHOTS[f"card-{pid}.jpg"] = cv2.imencode(".jpg", flat, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
        except Exception:
            pass
        TRACE["cards"][str(pid)] = {
            "name": card.get("name"), "number": card.get("number"), "rarity": card.get("rarity"),
            "setDecoys": set_decoys, "nameDecoys": [[i["id"], i["name"], i.get("number"), i["gid"] == card.get("gid")] for i in named],
            "pts": [[round(k.pt[0] / width * 1000), round(k.pt[1] / height * 1000), int(f)] for k, f in zip(points, flags)]}
    entry.update({"n": len(photo[0]), "w": photo[2], "h": photo[3]})
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, photo[1], k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    inside = [0] * len(good)
    if len(good) >= 8:
        src = np.float32([points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([photo[0][m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if mask is not None:
            inside = [int(v) for v in mask.ravel()]
        if homography is not None:
            corners = np.float32([[0, 0], [width, 0], [width, height], [0, height]]).reshape(-1, 1, 2)
            entry["quad"] = [[round(float(x)), round(float(y))] for x, y in cv2.perspectiveTransform(corners, homography).reshape(-1, 2)]
            try:
                grow = np.diag([FLAT[0] / width, FLAT[1] / height, 1.0])
                flat = cv2.warpPerspective(_picture(listing_picture(listing["img"]), LISTING_SIDE),
                                           grow @ np.linalg.inv(homography), FLAT, flags=cv2.INTER_AREA)
                entry["shot"] = f"shot-{len(TRACE['listings'])}.jpg"
                SHOTS[entry["shot"]] = cv2.imencode(".jpg", flat, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
            except Exception:
                pass
    entry["good"] = [[m.queryIdx, round(photo[0][m.trainIdx].pt[0]), round(photo[0][m.trainIdx].pt[1]), i]
                     for m, i in zip(good, inside)]
    entry["score"] = own_score(catalogue_picture(card["image"]), decoys_for(card, catalog), listing_picture(listing["img"]))
