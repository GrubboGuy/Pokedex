"""Files the job keeps between runs: price snapshots, the catalog, issues."""

import datetime as dt
import gzip
import json
import os

from . import config


def _read_gz(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def _write_gz(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))


def read_json(path, default=None):
    if not os.path.isfile(path):
        return default
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


class Store:
    def __init__(self, root):
        self.root = root
        self.history_dir = os.path.join(root, "history")
        self.issues_dir = os.path.join(root, "issues")
        os.makedirs(self.history_dir, exist_ok=True)
        os.makedirs(self.issues_dir, exist_ok=True)

    # --- price snapshots: one file per day, {key: market price} ---
    def snapshot_dates(self):
        return sorted(f[:10] for f in os.listdir(self.history_dir) if f.endswith(".json.gz"))

    def has_snapshot(self, date):
        return os.path.isfile(os.path.join(self.history_dir, f"{date}.json.gz"))

    def load_snapshot(self, date):
        return _read_gz(os.path.join(self.history_dir, f"{date}.json.gz"))

    def save_snapshot(self, date, snapshot):
        _write_gz(os.path.join(self.history_dir, f"{date}.json.gz"), snapshot)

    def prune_history(self, today):
        """Drop snapshots older than the keep window."""
        today_d = dt.date.fromisoformat(today)
        for date in self.snapshot_dates():
            if (today_d - dt.date.fromisoformat(date)).days > config.HISTORY_KEEP_DAYS:
                os.remove(os.path.join(self.history_dir, f"{date}.json.gz"))

    # --- catalog: today's products and prices, so a re-run can skip the fetch ---
    def load_catalog(self, date):
        path = os.path.join(self.root, "catalog.json.gz")
        if not os.path.isfile(path):
            return None
        data = _read_gz(path)
        return data if data.get("date") == date and data.get("v") == config.CATALOG_VERSION else None

    def save_catalog(self, catalog):
        _write_gz(os.path.join(self.root, "catalog.json.gz"), catalog)

    # --- issues ---
    def issue_index(self):
        return read_json(os.path.join(self.issues_dir, "index.json"), default=[])

    def load_issue(self, number):
        return read_json(os.path.join(self.issues_dir, f"issue-{number}.json"))

    def save_issue(self, issue):
        write_json(os.path.join(self.issues_dir, f"issue-{issue['number']}.json"), issue)
        cover = issue.get("cover") or {}
        entry = {
            "number": issue["number"],
            "date": issue["date"],
            "file": f"issue-{issue['number']}.json",
            "coverName": cover.get("name"),
            "coverImage": cover.get("image"),
            "picks": sum(len(c["picks"]) for c in issue["categories"]),
        }
        index = [e for e in self.issue_index() if e["number"] != issue["number"]]
        index.append(entry)
        index.sort(key=lambda e: e["number"], reverse=True)
        write_json(os.path.join(self.issues_dir, "index.json"), index)

    # --- today's edition: the picks the site shows, refreshed daily ---
    def load_today(self):
        return read_json(os.path.join(self.issues_dir, "today.json"))

    def save_today(self, issue):
        write_json(os.path.join(self.issues_dir, "today.json"), issue)

    def graded_cache(self):
        return read_json(os.path.join(self.root, "graded.json"), default={})

    def save_graded_cache(self, cache):
        write_json(os.path.join(self.root, "graded.json"), cache)
