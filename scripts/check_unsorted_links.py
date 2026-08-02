#!/usr/bin/env python3
"""Reachability-check unsorted.md and remove links that fail.

Unlike list.md link checks (3 consecutive failures), unsorted links are purged
on the first failed probe — they are an unverified dump.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
UNSORTED_MD = ROOT / "unsorted.md"
UNSORTED_LINKS_TXT = ROOT / "unsorted_links.txt"
CONVERT_SCRIPT = ROOT / "scripts" / "convert_list_to_json.py"

URL_RE = re.compile(r"https?://[^\s|)>\"]+")
HEADER = """# Unsorted Links

Links that do not have a confirmed provider section yet.
Move links from here into `list.md` once sorted.

"""


def normalize(url: str) -> str:
    return url.strip().rstrip("/")


def extract_urls(text: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in URL_RE.findall(text):
        n = normalize(raw)
        if not n or n in seen:
            continue
        seen.add(n)
        out.append(n)
    return out


def is_working(url: str, timeout: float) -> bool:
    try:
        r = requests.get(
            url,
            timeout=timeout,
            headers={"User-Agent": "proxy-list-unsorted-checker/1.0"},
            allow_redirects=True,
        )
        return r.status_code < 400
    except Exception:
        return False


def test_links(urls: list[str], workers: int, timeout: float) -> dict[str, bool]:
    results: dict[str, bool] = {}
    total = len(urls)
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(is_working, u, timeout): u for u in urls}
        for fut in as_completed(futures):
            url = futures[fut]
            try:
                ok = bool(fut.result())
            except Exception:
                ok = False
            results[url] = ok
            done += 1
            if done % 100 == 0 or done == total:
                alive = sum(1 for v in results.values() if v)
                print(f"  progress {done}/{total} (reachable so far: {alive})", flush=True)
    return results


def write_unsorted(urls: list[str]) -> None:
    body = HEADER + "".join(f"- {u}\n" for u in urls)
    UNSORTED_MD.write_text(body, encoding="utf-8")
    UNSORTED_LINKS_TXT.write_text(("\n".join(urls) + "\n") if urls else "", encoding="utf-8")


def main() -> int:
    p = argparse.ArgumentParser(description="Check unsorted.md reachability and purge failures.")
    p.add_argument("--dry-run", action="store_true", help="Report only; do not rewrite files.")
    p.add_argument("--workers", type=int, default=40)
    p.add_argument("--timeout", type=float, default=10.0)
    p.add_argument("--no-convert", action="store_true", help="Skip convert_list_to_json.py after write.")
    p.add_argument("--limit", type=int, default=0, help="Only check first N URLs (debug).")
    args = p.parse_args()

    if not UNSORTED_MD.is_file():
        print(f"Missing {UNSORTED_MD}", file=sys.stderr)
        return 1

    urls = extract_urls(UNSORTED_MD.read_text(encoding="utf-8"))
    if args.limit > 0:
        urls = urls[: args.limit]
    if not urls:
        print("No unsorted URLs found.")
        return 0

    print(f"Checking {len(urls)} unsorted links (workers={args.workers}, timeout={args.timeout}s)...")
    results = test_links(urls, workers=args.workers, timeout=args.timeout)

    kept = [u for u in urls if results.get(u)]
    removed = [u for u in urls if not results.get(u)]

    print(f"Reachable: {len(kept)}")
    print(f"Unreachable (remove): {len(removed)}")
    if removed:
        print("Sample removals:")
        for u in removed[:15]:
            print(f"  - {u}")
        if len(removed) > 15:
            print(f"  ... and {len(removed) - 15} more")

    if args.dry_run:
        print("Dry-run: no files written.")
        return 0

    write_unsorted(kept)
    print(f"Wrote {len(kept)} links to {UNSORTED_MD.name} and {UNSORTED_LINKS_TXT.name}")

    if not args.no_convert and CONVERT_SCRIPT.is_file():
        rc = subprocess.run([sys.executable, str(CONVERT_SCRIPT)], cwd=ROOT).returncode
        if rc != 0:
            return rc

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
