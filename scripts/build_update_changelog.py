#!/usr/bin/env python3
"""Build docs/update_changelog.json from list.md git history (user-facing update notices)."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
OUTPUT = ROOT / "docs" / "update_changelog.json"


def git_show_list(commit: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{commit}:list.md"], text=True, errors="replace"
    )


def parse_meta_and_notice(text: str) -> tuple[str, str, str, str]:
    version = revision = released = ""
    match = re.search(r">\s*(v[^\s|]+)\s*\|\s*Released:\s*([^\n]+)", text)
    if match:
        version, released = match.group(1).strip(), match.group(2).strip()
    rev = re.search(r">\s*(r\d+)", text, re.IGNORECASE)
    if rev:
        revision = rev.group(1).lower()
    notice_match = re.search(r"## Update Notice\s*\n+([\s\S]*?)(?=\n# [^\#]|\Z)", text)
    notice = notice_match.group(1).strip() if notice_match else ""
    return version, revision, released, notice


def build_from_git() -> list[dict[str, str]]:
    commits = subprocess.check_output(
        ["git", "log", "main", "--format=%H", "--", "list.md"], text=True
    ).strip().splitlines()
    seen_notices: set[str] = set()
    entries: list[dict[str, str]] = []
    for commit in commits:
        try:
            text = git_show_list(commit)
        except subprocess.CalledProcessError:
            continue
        version, revision, released, notice = parse_meta_and_notice(text)
        if not notice or notice in seen_notices:
            continue
        seen_notices.add(notice)
        entries.append(
            {
                "version": version,
                "revision": revision,
                "released": released,
                "update_notice": notice,
            }
        )
    return entries


def build_from_current_list() -> list[dict[str, str]]:
    if not LIST_MD.is_file():
        return []
    text = LIST_MD.read_text(encoding="utf-8")
    version, revision, released, notice = parse_meta_and_notice(text)
    if not notice:
        return []
    return [
        {
            "version": version,
            "revision": revision,
            "released": released,
            "update_notice": notice,
        }
    ]


def main() -> int:
    try:
        entries = build_from_git()
    except subprocess.CalledProcessError:
        entries = build_from_current_list()
    if not entries:
        entries = build_from_current_list()
    body = {
        "_note": "Archived site update notices. Regenerate with: python3 scripts/build_update_changelog.py",
        "entries": entries,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} update notice entries to {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
