#!/usr/bin/env python3
"""Move unsorted links into list.md when the URL contains a provider name.

Matches provider section titles from list.md (e.g. gn-math, Noblocc, Velara) against
each unsorted URL. Uses the longest unique provider slug found in the URL.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
UNSORTED_MD = ROOT / "unsorted.md"
CONVERT_SCRIPT = ROOT / "scripts" / "convert_list_to_json.py"

URL_RE = re.compile(r"https?://[^\s|)>\"]+")

# Skip slug hits that are only a short TLD-like suffix (e.g. provider "Space" vs host .space).
TLD_LIKE_SLUGS = frozenset({"space", "cloud", "site", "live", "app", "dev", "net", "org", "com"})

sys.path.insert(0, str(Path(__file__).resolve().parent))
from list_cli import (  # noqa: E402
    DEFAULT_CONTRIBUTOR,
    DEFAULT_CONTRIBUTOR_URL,
    find_link,
    find_section,
    format_contributor,
    insert_link_row,
    parse_sections,
    read_list,
    today_date,
    update_section_counts,
    update_total_links,
    url_match,
    write_list,
)


def normalize_url(url: str) -> str:
    return url.strip().rstrip("/")


def extract_unsorted_urls(content: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in URL_RE.findall(content):
        url = normalize_url(raw)
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


def provider_slugs(title: str, *, min_len: int) -> list[str]:
    name = re.sub(r"^[^\w]+", "", title).strip()
    base = name.lower()
    slugs: list[str] = []
    if base and len(base) >= min_len:
        slugs.append(base)
    compact = re.sub(r"[^a-z0-9]+", "", base)
    if compact and len(compact) >= min_len and compact not in slugs:
        slugs.append(compact)
    return slugs


def slug_in_url(slug: str, url: str) -> bool:
    u = url.lower()
    if slug not in u:
        return False
    if len(slug) <= 5 and slug in TLD_LIKE_SLUGS:
        if u.endswith("." + slug) or u.endswith("." + slug + "/"):
            return False
        host = u.split("://", 1)[-1].split("/", 1)[0]
        if host.endswith("." + slug):
            return False
    return True


def build_provider_index(sections, *, min_len: int) -> tuple[list[tuple[str, list[str]]], dict[str, list[str]]]:
    providers: list[tuple[str, list[str]]] = []
    slug_owners: dict[str, list[str]] = defaultdict(list)
    for sec in sections:
        slugs = provider_slugs(sec.title, min_len=min_len)
        if not slugs:
            continue
        providers.append((sec.title, slugs))
        for slug in slugs:
            slug_owners[slug].append(sec.title)
    return providers, slug_owners


def match_provider(
    url: str,
    providers: list[tuple[str, list[str]]],
    slug_owners: dict[str, list[str]],
) -> str | None:
    best_title: str | None = None
    best_len = 0
    for title, slugs in providers:
        for slug in slugs:
            if len(slug_owners.get(slug, [])) != 1:
                continue
            if not slug_in_url(slug, url):
                continue
            if len(slug) > best_len:
                best_title = title
                best_len = len(slug)
    return best_title


def build_unsorted_md(urls: list[str]) -> str:
    lines = [
        "# Unsorted Links",
        "",
        "Links that do not have a confirmed provider section yet.",
        "Move links from here into `list.md` once sorted.",
        "",
    ]
    lines.extend(f"- {u}" for u in urls)
    lines.append("")
    return "\n".join(lines)


def run_convert(*, no_sync: bool) -> int:
    if no_sync:
        return 0
    if not CONVERT_SCRIPT.is_file():
        print(f"warning: missing {CONVERT_SCRIPT}", file=sys.stderr)
        return 0
    proc = subprocess.run([sys.executable, str(CONVERT_SCRIPT)], cwd=ROOT, check=False)
    return proc.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Auto-sort unsorted links into provider sections by URL name match.")
    parser.add_argument("--apply", action="store_true", help="Write list.md and unsorted.md (default: dry-run).")
    parser.add_argument("--no-sync", action="store_true", help="Skip convert_list_to_json.py after applying.")
    parser.add_argument("--min-slug-len", type=int, default=4, help="Minimum provider slug length to match.")
    parser.add_argument(
        "--contributor",
        default=DEFAULT_CONTRIBUTOR,
        help=f"Contributor label for moved rows (default: {DEFAULT_CONTRIBUTOR}).",
    )
    args = parser.parse_args(argv)
    dry_run = not args.apply

    if not LIST_MD.is_file():
        raise SystemExit(f"Missing {LIST_MD}")
    if not UNSORTED_MD.is_file():
        raise SystemExit(f"Missing {UNSORTED_MD}")

    lines = read_list()
    sections = parse_sections(lines)
    providers, slug_owners = build_provider_index(sections, min_len=args.min_slug_len)

    unsorted_urls = extract_unsorted_urls(UNSORTED_MD.read_text(encoding="utf-8"))
    if not unsorted_urls:
        print("No unsorted URLs to process.")
        return 0

    contrib_md = format_contributor(
        args.contributor,
        DEFAULT_CONTRIBUTOR_URL if args.contributor == DEFAULT_CONTRIBUTOR else None,
    )
    found_date = today_date()

    moves: list[tuple[str, str]] = []
    remaining: list[str] = []
    skipped_in_list = 0
    skipped_no_match = 0

    for url in unsorted_urls:
        if find_link(lines, url):
            skipped_in_list += 1
            continue
        provider = match_provider(url, providers, slug_owners)
        if provider:
            moves.append((url, provider))
        else:
            remaining.append(url)
            skipped_no_match += 1

    by_provider: dict[str, list[str]] = defaultdict(list)
    for url, provider in moves:
        by_provider[provider].append(url)

    print(f"Unsorted URLs scanned: {len(unsorted_urls)}")
    print(f"Would move to sorted list: {len(moves)}")
    print(f"Remain unsorted (no provider match): {len(remaining)}")
    if skipped_in_list:
        print(f"Skipped (already in list.md): {skipped_in_list}")

    for provider in sorted(by_provider, key=lambda p: (-len(by_provider[p]), p.lower())):
        print(f"  {provider}: {len(by_provider[provider])}")

    if dry_run:
        if moves:
            print("\nSample matches:")
            for url, provider in moves[:15]:
                print(f"  [{provider}] {url}")
            print("\nRe-run with --apply to write changes.")
        return 0

    if not moves:
        print("Nothing to apply.")
        return 0

    for provider, urls in by_provider.items():
        sec = find_section(parse_sections(lines), provider)
        for url in urls:
            if find_link(lines, url):
                continue
            cur_sec = find_section(parse_sections(lines), provider)
            insert_link_row(
                lines,
                cur_sec,
                url=url,
                found=found_date,
                contributor=args.contributor,
                contributor_url=DEFAULT_CONTRIBUTOR_URL if args.contributor == DEFAULT_CONTRIBUTOR else None,
            )

    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry_run=False)
    UNSORTED_MD.write_text(build_unsorted_md(remaining), encoding="utf-8")
    print(f"Moved {len(moves)} link(s); {len(remaining)} remain in unsorted.md; total sorted links: {total}")

    return run_convert(no_sync=args.no_sync)


if __name__ == "__main__":
    raise SystemExit(main())
