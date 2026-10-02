"""Reads Pokemon product and price data from TCGCSV (a daily mirror of TCGplayer)."""

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from . import config

BASE = os.environ.get("TCGCSV_BASE", "https://tcgcsv.com").rstrip("/")
USER_AGENT = "MarketDexWeekly/0.1 (+https://github.com/GrubboGuy/Pokedex)"
PAUSE = float(os.environ.get("TCGCSV_PAUSE", "0.25"))


class NotFound(Exception):
    pass


def _get(url, timeout=120, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code in (403, 404):
                raise NotFound(url) from err
            last = err
        except Exception as err:  # network hiccup: retry
            last = err
        time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"could not fetch {url}: {last}")


def _get_json(path):
    data = json.loads(_get(f"{BASE}{path}"))
    time.sleep(PAUSE)
    return data.get("results", [])


def last_updated():
    """Date (YYYY-MM-DD, UTC) of TCGCSV's most recent refresh."""
    text = _get(f"{BASE}/last-updated.txt").decode("utf-8", "replace").strip()
    match = re.search(r"\d{4}-\d{2}-\d{2}", text)
    if match:
        return match.group(0)
    # Unexpected format: fall back to the UTC day of the most recent 20:00 refresh.
    now = dt.datetime.now(dt.timezone.utc)
    print(f"  could not read a date from last-updated.txt ({text[:60]!r}); using the clock")
    return (now - dt.timedelta(hours=20, minutes=30)).date().isoformat()


def groups():
    return _get_json(f"/tcgplayer/{config.CATEGORY_ID}/groups")


def products(group_id):
    try:
        return _get_json(f"/tcgplayer/{config.CATEGORY_ID}/{group_id}/products")
    except NotFound:
        return []


def prices(group_id):
    try:
        return _get_json(f"/tcgplayer/{config.CATEGORY_ID}/{group_id}/prices")
    except NotFound:
        return []


def price_key(product_id, sub_type):
    return f"{product_id}|{sub_type or 'Normal'}"


def _extract(archive_path, out_dir, date):
    """Unpack only the Pokemon folder of a daily archive. Returns the folder or None."""
    wanted = f"{date}/{config.CATEGORY_ID}"
    target = os.path.join(out_dir, date, str(config.CATEGORY_ID))
    exe = shutil.which("7z") or shutil.which("7za") or shutil.which("7zr")
    if exe:
        for args in ([wanted], []):  # filtered first, then everything
            subprocess.run(
                [exe, "x", "-y", f"-o{out_dir}", archive_path, *args],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
            if os.path.isdir(target):
                return target
    try:
        import py7zr  # optional fallback

        with py7zr.SevenZipFile(archive_path, "r") as z:
            names = [n for n in z.getnames() if n.startswith(wanted + "/")]
            if names:
                z.extract(path=out_dir, targets=names)
            else:
                z.extractall(path=out_dir)
    except Exception as err:
        print(f"  py7zr could not unpack {date}: {err}")
    if os.path.isdir(target):
        return target
    # Some archives may not nest under the date folder; look for the category folder.
    for root, dirs, _files in os.walk(out_dir):
        if os.path.basename(root) == str(config.CATEGORY_ID) and dirs:
            return root
    return None


def archive_prices(date):
    """Market prices for one past day from TCGCSV's archive: {key: price}, or None."""
    url = f"{BASE}/archive/tcgplayer/prices-{date}.ppmd.7z"
    tmp = tempfile.mkdtemp(prefix="tcgcsv-")
    try:
        archive_path = os.path.join(tmp, "prices.7z")
        try:
            blob = _get(url, timeout=300)
        except NotFound:
            return None
        with open(archive_path, "wb") as fh:
            fh.write(blob)
        folder = _extract(archive_path, os.path.join(tmp, "out"), date)
        if not folder:
            print(f"  archive {date}: downloaded {len(blob)} bytes but found no Pokemon folder")
            return None
        snapshot = {}
        for group in os.listdir(folder):
            path = os.path.join(folder, group, "prices")
            if not os.path.isfile(path):
                continue
            try:
                with open(path, "rb") as fh:
                    rows = json.load(fh).get("results", [])
            except Exception:
                continue
            for row in rows:
                market = row.get("marketPrice")
                if market:
                    snapshot[price_key(row.get("productId"), row.get("subTypeName"))] = market
        time.sleep(1.0)
        return snapshot or None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
