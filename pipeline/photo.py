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


def measure(issue):
    """For tuning: every pick's listing photo scored against its own catalogue picture ("same"),
    and against the next pick's in the same list ("other"), which is a card it certainly is not."""
    rows = []
    for category in issue["categories"]:
        picks = [p for p in category["picks"] if p.get("kind") == "single" and (p.get("ebayLow") or {}).get("img")]
        for i, pick in enumerate(picks):
            other = picks[(i + 1) % len(picks)] if len(picks) > 1 else None
            def both(card):
                return scores(catalogue_picture(card["image"]), listing_picture(pick["ebayLow"]["img"])) if card else None
            rows.append({"list": category["id"], "name": pick["name"], "title": pick["ebayLow"].get("title"),
                         "url": pick["ebayLow"].get("url"), "img": pick["ebayLow"]["img"], "cat": pick["image"],
                         "same": both(pick), "other": both(other), "otherName": other["name"] if other else None})
    return rows
