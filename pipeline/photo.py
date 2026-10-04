"""Checks that an eBay listing's photo shows the same card as the catalogue picture.

A seller can file a card under the wrong catalogue entry, and then the title, number, set and
language all match while the photo shows something else. The only way to catch that is to look.

This compares the two pictures by their fine detail (SIFT keypoints): it finds points that look
alike in both, then keeps only those that agree on one flat-card position, so a photo taken at an
angle, in a sleeve or on a desk still matches. The score is how many points agree. The same card
scores in the dozens to hundreds; a different card scores close to zero, apart from the few points
every card of that design shares (the frame, symbols and small print).

Needs OpenCV (installed by the workflow). Without it every check answers None and nothing is filtered.
"""

import re
import urllib.request

try:
    import cv2
    import numpy as np
except Exception:  # not installed: the photo check is skipped
    cv2 = None

SIDE = 720            # pictures are scaled so their longer side is this many pixels
_features = {}        # picture URL -> (keypoints, descriptors), kept for the length of a run


def available():
    return cv2 is not None


def catalogue_picture(image_url):
    """TCGplayer's large picture of a card, from the small one stored on a pick."""
    return (image_url or "").replace("_200w.", "_in_1000x1000.")


def listing_picture(image_url):
    """A mid-sized copy of an eBay listing photo (the search gives a thumbnail)."""
    return re.sub(r"s-l\d+\.", "s-l800.", image_url or "")


def _load(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; PokedexDaily/1.0)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("not a picture")
    scale = SIDE / max(image.shape[:2])
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return image


def _describe(url):
    if url not in _features:
        try:
            _features[url] = cv2.SIFT_create(nfeatures=2500).detectAndCompute(_load(url), None)
        except Exception:
            _features[url] = None
    return _features[url]


def score(catalogue_url, listing_url):
    """How many points of the catalogue picture are found, in the right places, in the listing photo.

    None when a picture could not be loaded or OpenCV is missing.
    """
    if cv2 is None or not catalogue_url or not listing_url:
        return None
    first, second = _describe(catalogue_url), _describe(listing_url)
    if not first or not second or first[1] is None or second[1] is None:
        return None
    (points_a, desc_a), (points_b, desc_b) = first, second
    if len(points_a) < 8 or len(points_b) < 8:
        return 0
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc_a, desc_b, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < 8:
        return 0
    src = np.float32([points_a[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([points_b[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    _homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return int(mask.sum()) if mask is not None else 0


ART_ZONE = (0.10, 0.62)   # the band of a card, top to bottom, that holds its artwork on every frame design


def scores(catalogue_url, listing_url):
    """(points agreeing anywhere on the card, points agreeing inside the artwork band), or None.

    Cards of one design share their frame, symbols and rules text, so two different cards agree
    on a few dozen points there. The artwork is what tells them apart.
    """
    if cv2 is None or not catalogue_url or not listing_url:
        return None
    first, second = _describe(catalogue_url), _describe(listing_url)
    if not first or not second or first[1] is None or second[1] is None:
        return None
    (points_a, desc_a), (points_b, desc_b) = first, second
    if len(points_a) < 8 or len(points_b) < 8:
        return 0, 0
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc_a, desc_b, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < 8:
        return 0, 0
    src = np.float32([points_a[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([points_b[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    _homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if mask is None:
        return 0, 0
    height = max(pt.pt[1] for pt in points_a) or 1.0
    kept = [src[i][0] for i in range(len(good)) if mask[i][0]]
    in_art = sum(1 for _x, y in kept if ART_ZONE[0] <= y / height <= ART_ZONE[1])
    return len(kept), in_art


def for_listing(pick, listing):
    """Score of a pick's catalogue picture against a listing's photo (None if either is missing)."""
    if not pick.get("image") or not listing.get("img"):
        return None
    return score(catalogue_picture(pick["image"]), listing_picture(listing["img"]))


LISTING_SIDE = 1400    # listing photos are compared at this size: the card is often small in the frame
LISTING_POINTS = 6000
CATALOGUE_POINTS = 2500


def _points(url, side, count):
    """(keypoints, descriptors, width, height) of a picture, or None if it cannot be loaded."""
    key = (url, side, count)
    if key not in _features:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; PokedexDaily/1.0)"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                image = cv2.imdecode(np.frombuffer(resp.read(), np.uint8), cv2.IMREAD_GRAYSCALE)
            scale = side / max(image.shape[:2])
            if scale < 1:
                image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            points, desc = cv2.SIFT_create(nfeatures=count).detectAndCompute(image, None)
            _features[key] = (points, desc, image.shape[1], image.shape[0]) if desc is not None and len(points) >= 8 else None
        except Exception:
            _features[key] = None
    return _features[key]


def _own_points(catalogue_url, decoy_urls):
    """The points of a catalogue picture that belong to this card alone.

    Whatever also appears, in the same place, on other cards of the same design (the frame, the
    symbols, the rules text) is dropped, because a different card would match on those too.
    """
    key = ("own", catalogue_url, tuple(decoy_urls))
    if key in _features:
        return _features[key]
    card = _points(catalogue_url, SIDE, CATALOGUE_POINTS)
    if not card:
        _features[key] = None
        return None
    points, desc, width, height = card
    shared = np.zeros(len(points), dtype=bool)
    for url in decoy_urls:
        decoy = _points(url, SIDE, CATALOGUE_POINTS)
        if not decoy:
            continue
        for pair in cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, decoy[1], k=2):
            if len(pair) == 2 and pair[0].distance < 0.8 * pair[1].distance:
                ax, ay = points[pair[0].queryIdx].pt
                bx, by = decoy[0][pair[0].trainIdx].pt
                if abs(ax / width - bx / decoy[2]) < 0.04 and abs(ay / height - by / decoy[3]) < 0.04:
                    shared[pair[0].queryIdx] = True
    keep = [i for i in range(len(points)) if not shared[i]]
    _features[key] = ([points[i] for i in keep], desc[keep], int(shared.sum()))
    return _features[key]


def own_score(catalogue_url, decoy_urls, listing_url):
    """How many of the card's own points are found, in the right places, in the listing photo. None if unknown."""
    if cv2 is None or not catalogue_url or not listing_url:
        return None
    own = _own_points(catalogue_url, decoy_urls)
    photo = _points(listing_url, LISTING_SIDE, LISTING_POINTS)
    if not own or not photo:
        return None
    points, desc, _shared = own
    if len(points) < 8:
        return 0
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, photo[1], k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < 8:
        return 0
    src = np.float32([points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([photo[0][m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    _h, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return int(mask.sum()) if mask is not None else 0


def decoys_for(pick, catalog, count=2):
    """Catalogue pictures of other cards of the same design: same set and rarity, a different name."""
    out = []
    for item in catalog["items"]:
        if (item["gid"] == pick["gid"] and item.get("rarity") == pick.get("rarity") and item.get("image")
                and item["kind"] == "single" and item["id"] != pick["productId"]
                and item["name"].split(" - ")[0].split(" (")[0] != pick["name"].split(" - ")[0].split(" (")[0]):
            out.append(catalogue_picture(item["image"]))
            if len(out) == count:
                break
    return out


def measure(issue, catalog):
    """For tuning: each listing photo scored against its own card ("same") and against another card
    of the same set and rarity ("wrong"), which is what a mislabelled listing looks like."""
    rows = []
    for category in issue["categories"]:
        for pick in category["picks"]:
            listing = pick.get("ebayLow") or {}
            if pick.get("kind") != "single" or not listing.get("img") or not pick.get("image"):
                continue
            decoys = decoys_for(pick, catalog, 3)
            photo_url = re.sub(r"s-l\d+\.", "s-l1600.", listing["img"])
            mine = catalogue_picture(pick["image"])
            row = {"list": category["id"], "name": pick["name"], "title": listing.get("title"),
                   "url": listing.get("url"), "decoys": len(decoys),
                   "same": own_score(mine, decoys[:2], photo_url)}
            if decoys:  # pretend the listing was filed under the first decoy card
                row["wrong"] = own_score(decoys[0], [mine] + decoys[1:3], photo_url)
            own = _own_points(mine, decoys[:2])
            row["own"], row["shared"] = (len(own[0]), own[2]) if own else (None, None)
            rows.append(row)
    return rows
