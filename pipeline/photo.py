"""Checks that an eBay listing's photo shows the same card as the catalogue picture.

A seller can file a card under the wrong catalogue entry, and then the title, number, set and
language all match while the photo shows something else: another card of the same Pokemon, a
metal novelty card, or a Japanese copy of the same artwork. The only way to catch that is to look.

How it looks, in two steps:

1. Find the card in the photo. Both pictures are reduced to their fine detail (SIFT keypoints),
   points that look alike are paired, and the pairs that agree on one flat-card position give the
   card's outline in the photo. The photo is then flattened onto that outline, so a card shot at
   an angle, in a sleeve or on a desk ends up lying exactly over the catalogue picture.

2. Compare the two, patch by patch (edges only, so lighting and foil glare matter less):
   - the whole card, cut into 60 patches: at least three quarters of them have to agree. Another
     card of the same Pokemon agrees on the name and the frame but not on the artwork, and fails.
   - the name printed at the top: it has to agree by itself. A Japanese or Korean copy has the
     same artwork but a different name line, and fails.

Measured on 479 real listings (October 2026), every one looked at by eye: 48 showed a different
card (whole-card score 0.15 at most), 16 were Japanese, Korean or Chinese copies (name score 0.31
at most) and one was a different print of the same art (0.22). None of them passes. Of the
listings showing the right card, about 19 in 20 pass; a dark, blurred or glare-covered photo can
fail and is then treated as unconfirmed.

What it cannot see: a copy in another language that happens to print the same name (Spanish or
Italian, say), a different finish of the same picture (the pictures are compared in grey), or a
small stamp. The title checks in ebay.py still cover those as far as titles can.

Needs OpenCV (installed by the workflow). Without it nothing is checked and nothing is filtered.
"""

import re
import urllib.request

try:
    import cv2
    import numpy as np
except Exception:  # not installed: the photo check is skipped
    cv2 = None

WHOLE_MARK = 0.30        # a quarter of the card's patches may disagree (glare), no more
NAME_MARK = 0.50         # agreement needed on the printed name
MIN_ANCHORS = 10         # paired points needed before the card's outline is trusted

CATALOGUE_SIDE = 720     # pictures are scaled so their longer side is this many pixels
LISTING_SIDE = 1400      # listing photos are read larger: the card is often small in the frame
CATALOGUE_POINTS = 2500
LISTING_POINTS = 6000
FLAT = (432, 605)        # both pictures are brought to this size, card edge to card edge

# Where the name sits, as shares of the card's width and height. Several overlapping boxes, and the
# worst one counts: an evolution's little portrait, the HP figure or bold artwork behind the name
# are the same on a foreign copy, and a single wide box would let them outvote the letters.
NAME_BOXES = ((0.09, 0.62, 0.025, 0.115), (0.19, 0.62, 0.025, 0.115),
              (0.09, 0.45, 0.025, 0.115), (0.19, 0.50, 0.030, 0.110))

_cache = {}              # keypoints, kept for the length of a run
_pictures = {}           # the last few pictures loaded


def available():
    return cv2 is not None


def catalogue_picture(image_url):
    """TCGplayer's large picture of a card, from the small one stored on a pick."""
    return (image_url or "").replace("_200w.", "_in_1000x1000.")


def listing_picture(image_url):
    """The full-size copy of an eBay listing photo (the search gives a thumbnail)."""
    return re.sub(r"s-l\d+\.", "s-l1600.", image_url or "")


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
    """(keypoints, descriptors, width, height) of a picture, or None if it cannot be used."""
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


def flatten(catalogue_url, listing_url):
    """(catalogue picture, listing photo laid over it), both FLAT in size, or None.

    None means the card could not be found in the photo at all.
    """
    card = _points(catalogue_url, CATALOGUE_SIDE, CATALOGUE_POINTS)
    photo = _points(listing_url, LISTING_SIDE, LISTING_POINTS)
    if not card or not photo:
        return None
    points, desc, width, height = card
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(desc, photo[1], k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < MIN_ANCHORS:
        return None
    src = np.float32([points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([photo[0][m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    outline, kept = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if outline is None or kept is None or int(kept.sum()) < MIN_ANCHORS:
        return None
    try:
        grow = np.diag([FLAT[0] / width, FLAT[1] / height, 1.0])
        laid = cv2.warpPerspective(_picture(listing_url, LISTING_SIDE), grow @ np.linalg.inv(outline), FLAT,
                                   flags=cv2.INTER_AREA)
        flat = cv2.resize(_picture(catalogue_url, CATALOGUE_SIDE), FLAT, interpolation=cv2.INTER_AREA)
    except Exception:
        return None
    return flat, laid


def _edges(image, fine, coarse):
    """A picture with slow changes of light removed: what is left is outlines and lettering."""
    grey = image.astype(np.float32)
    return cv2.GaussianBlur(grey, (0, 0), fine) - cv2.GaussianBlur(grey, (0, 0), coarse)


def _agree(card, photo, box, slack, either_way=False):
    """How well one box of the catalogue picture matches the photo, allowing a few pixels of slip.

    1 is a perfect match, 0 is none. `either_way` also counts a match with light and dark swapped,
    which is how a foil name line often photographs.
    """
    height, width = card.shape
    left, right, top, bottom = int(box[0] * width), int(box[1] * width), int(box[2] * height), int(box[3] * height)
    patch = card[top:bottom, left:right]
    around = photo[max(0, top - slack):min(height, bottom + slack), max(0, left - slack):min(width, right + slack)]
    if patch.std() < 1e-3 or around.shape[0] < patch.shape[0] or around.shape[1] < patch.shape[1]:
        return 0.0
    found = np.nan_to_num(cv2.matchTemplate(around, patch, cv2.TM_CCOEFF_NORMED))
    return float(np.abs(found).max() if either_way else found.max())


def agreement(flat, laid, rows=10, cols=6):
    """(whole card, name) agreement between a catalogue picture and a flattened listing photo."""
    card, photo = _edges(flat, 1.0, 4.0), _edges(laid, 1.0, 4.0)
    patches = [_agree(card, photo, (c / cols, (c + 1) / cols, r / rows, (r + 1) / rows), 5)
               for r in range(rows) for c in range(cols)]
    whole = float(np.percentile(patches, 25))
    card, photo = _edges(flat, 0.8, 2.5), _edges(laid, 0.8, 2.5)   # finer: letters, not artwork
    name = min(_agree(card, photo, box, 6, either_way=True) for box in NAME_BOXES)
    return whole, name


def check(card, listing):
    """(confirmed, score) for a card and an eBay listing that is meant to be it.

    confirmed is True when the photo shows this card, False when it does not or cannot be told,
    and None when the check could not run at all (no OpenCV), in which case nothing is filtered.
    The score is the whole-card agreement out of 100, kept on the pick for reference.
    """
    if cv2 is None:
        return None, None
    if not card.get("image") or not listing.get("img"):
        return False, None
    pair = flatten(catalogue_picture(card["image"]), listing_picture(listing["img"]))
    if not pair:
        return False, 0
    whole, name = agreement(*pair)
    return (whole >= WHOLE_MARK and name >= NAME_MARK), round(whole * 100)
