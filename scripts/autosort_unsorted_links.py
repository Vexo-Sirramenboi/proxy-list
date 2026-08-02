#!/usr/bin/env python3
"""Move unsorted links into list.md when the URL (or page title) matches an existing section.

Only maps into sections that already exist in list.md — never creates new ones.
Matches:
  1) Provider title-derived slugs in the URL
  2) Known SECTION_ALIASES / extra URL keywords
  3) Optional HTTP fetch of page <title> / text for remaining URLs (--fetch)
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from html import unescape
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
LIST_MD = ROOT / "list.md"
UNSORTED_MD = ROOT / "unsorted.md"
CONVERT_SCRIPT = ROOT / "scripts" / "convert_list_to_json.py"

URL_RE = re.compile(r"https?://[^\s|)>\"]+")
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)

# Skip slug hits that are only a short TLD-like suffix (e.g. provider "Space" vs host .space).
TLD_LIKE_SLUGS = frozenset({"space", "cloud", "site", "live", "app", "dev", "net", "org", "com"})

# Words from multi-word titles that are too generic to match alone in URLs/titles.
GENERIC_WORDS = frozenset(
    {
        "project",
        "projects",
        "echo",
        "education",
        "games",
        "game",
        "network",
        "proxy",
        "arcade",
        "tutoring",
        "class",
        "lite",
        "work",
        "bean",
        "web",
        "os",
        "secured",
        "v3",
        "density",
        "soul",
        "imp",  # too short / common substring
        "void",
        "sea",
        "only",
        "lessons",
        "math",
        "hub",
        "craft",
        "blox",
    }
)

# Extra URL/title keywords → bare section name (resolved against existing list.md titles).
# Keep Cherri and Strawberri separate.
EXTRA_KEYWORDS: dict[str, str] = {
    "utopiaeducation": "Utopia Education",
    "utopia-education": "Utopia Education",
    # bare "utopia" is OK — relatively specific provider token
    "utopia": "Utopia Education",
    "voidnetwork": "Void Network",
    "relicnetwork": "Relic Network",
    "impproxy": "Imp Proxy",
    "imp-proxy": "Imp Proxy",
    "seabean": "Sea Bean",
    "noahstutoring": "Noahs Tutoring",
    "noahstutoringhelp": "Noahs Tutoring",
    "brunys": "BrunysIXLWork",
    "brunysixl": "BrunysIXLWork",
    "rhodium": "Rhodium",
    "equinox": "Equinox",
    "frosted": "Frosted",
    "svgfrosted": "Frosted",
    "shuttle": "Shuttle",
    "voya": "Voya",
    "snipershot": "Snipershot",
    "projectecho": "Project Echo",
    "project-echo": "Project Echo",
    "c00lkidtech": "C00lkidtech",
    "zakaedu": "Zaka EDU",
    "nocturne": "Nocturne",
    "polaris": "Polaris",
    "aether": "Aether",
    "aethergames": "Aether",
    "aethergamesofficial": "Aether",
    "cherri": "Cherri",
    "interstellar": "Interstellar",
    "xcloud": "Xcloud",
    "truffled": "Truffled",
    "bloxcraft": "BloxCraft Games",
    "frogie": "frogie's arcade",
    "froggie": "frogie's arcade",
    "securedv3": "Secured V3",
    "oldsecured": "Secured V3",
    "nettleweb": "Nettle Web",
    "seamlessos": "Seamless OS",
    "daydream": "DayDream X",
    "daydreamx": "DayDream X",
    "daydreaming": "DayDream X",
    "overcloaked": "OverCloaked",
    "overcloak": "OverCloaked",
    "studyhub": "StudyHub",
    "tungtung": "Tung Tung",
    "tung-tung": "Tung Tung",
    "petezah": "PeteZah",
    "dogeub": "dogeub",
    "noblocc": "Noblocc",
    "unblocc": "Noblocc",
    "strawberri": "Strawberri",
    "strawberry": "Strawberri",
    "duckmath": "Duckmath",
    "duckduckgoose": "Duckmath",
    "velara": "Velara",
    "velera": "Velara",
    "selenite": "Selenite",
    "gn-math": "gn-math",
    "gnmath": "gn-math",
    "rammerhead": "Rammerhead",
    "invisiproxy": "InvisiProxy",
    "bestspark": "BestSpark",
    "unblockedzone": "Unblockedzone",
    "catclass": "Cat Class",
    "cat-class": "Cat Class",
    "nebulios": "Nebulo",
    "nebulo": "Nebulo",
    "luminalos": "LuminalOS",
    "luminal": "LuminalOS",
    "lunaar": "Lunaar",
    "galaxymathematics": "Galaxy",
    "galaxymath": "Galaxy",
}

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
        # Never sort the repo github profile into a section
        if "github.com/yourworstnightmare1" in url.lower() and "proxy-list" not in url.lower():
            continue
        seen.add(url)
        out.append(url)
    return out


def bare_title(title: str) -> str:
    return re.sub(r"^[^\w]+", "", title).strip()


def provider_slugs(title: str, *, min_len: int) -> list[str]:
    name = bare_title(title)
    base = name.lower()
    slugs: list[str] = []
    if base and len(base) >= min_len:
        slugs.append(base)
    compact = re.sub(r"[^a-z0-9]+", "", base)
    if compact and len(compact) >= min_len and compact not in slugs:
        slugs.append(compact)
    # Individual significant words only when specific enough
    for word in re.findall(r"[a-z0-9]{6,}", base):
        if word in GENERIC_WORDS or word in TLD_LIKE_SLUGS:
            continue
        if word not in slugs:
            slugs.append(word)
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
    # Prefer token boundaries: avoid matching "math" inside random strings poorly —
    # require slug as subdomain label, path segment, or continuous alnum run of equal length.
    if len(slug) < 6:
        host = urlsplit(u).hostname or ""
        path = urlsplit(u).path or ""
        labels = host.split(".")
        if slug in labels or any(slug == lab for lab in labels):
            return True
        segs = [s for s in path.lower().split("/") if s]
        if slug in segs:
            return True
        if re.search(rf"(^|[^a-z0-9]){re.escape(slug)}([^a-z0-9]|$)", u):
            return True
        return False
    return True


def resolve_title_for_bare(bare: str, title_by_bare: dict[str, str]) -> str | None:
    key = re.sub(r"[^a-z0-9]+", "", bare.lower())
    if not key:
        return None
    # exact bare match
    for b, title in title_by_bare.items():
        if re.sub(r"[^a-z0-9]+", "", b.lower()) == key:
            return title
    # startswith / contains unique
    hits = [
        title
        for b, title in title_by_bare.items()
        if key in re.sub(r"[^a-z0-9]+", "", b.lower())
        or re.sub(r"[^a-z0-9]+", "", b.lower()) in key
    ]
    if len(hits) == 1:
        return hits[0]
    return None


def build_indexes(sections, *, min_len: int):
    providers: list[tuple[str, list[str]]] = []
    slug_owners: dict[str, list[str]] = defaultdict(list)
    title_by_bare: dict[str, str] = {}
    for sec in sections:
        bare = bare_title(sec.title)
        title_by_bare[bare] = sec.title
        slugs = provider_slugs(sec.title, min_len=min_len)
        if not slugs:
            continue
        providers.append((sec.title, slugs))
        for slug in slugs:
            slug_owners[slug].append(sec.title)

    # Alias keywords → existing titles only
    alias_to_title: dict[str, str] = {}
    for kw, bare in EXTRA_KEYWORDS.items():
        title = resolve_title_for_bare(bare, title_by_bare)
        if title:
            alias_to_title[kw.lower()] = title
    return providers, slug_owners, title_by_bare, alias_to_title


def match_provider(
    url: str,
    providers: list[tuple[str, list[str]]],
    slug_owners: dict[str, list[str]],
    alias_to_title: dict[str, str],
) -> str | None:
    u = url.lower()
    best_title: str | None = None
    best_len = 0

    for kw, title in alias_to_title.items():
        if kw in u and len(kw) > best_len:
            # require boundary for short keywords
            if len(kw) < 6 and not re.search(rf"(^|[^a-z0-9]){re.escape(kw)}([^a-z0-9]|$)", u):
                continue
            best_title = title
            best_len = len(kw)

    for title, slugs in providers:
        for slug in slugs:
            owners = slug_owners.get(slug, [])
            if len(set(owners)) != 1:
                continue
            if not slug_in_url(slug, url):
                continue
            if len(slug) > best_len:
                best_title = title
                best_len = len(slug)
    return best_title


def match_from_text(text: str, title_by_bare: dict[str, str], alias_to_title: dict[str, str]) -> str | None:
    """Match only strong provider tokens in page title/body (avoid generic words)."""
    t = text.lower()
    best = None
    best_len = 0
    # Alias keywords only — already curated; require length >= 6 and token boundary
    for kw, title in alias_to_title.items():
        if len(kw) < 6:
            continue
        if kw in GENERIC_WORDS:
            continue
        if not re.search(rf"(^|[^a-z0-9]){re.escape(kw)}([^a-z0-9]|$)", t):
            continue
        if len(kw) > best_len:
            best = title
            best_len = len(kw)
    # Full compact bare titles only (e.g. daydreamx, invisiproxy), never single generic words
    for bare, title in title_by_bare.items():
        compact = re.sub(r"[^a-z0-9]+", "", bare.lower())
        if len(compact) < 7:
            continue
        if compact in GENERIC_WORDS:
            continue
        if not re.search(rf"(^|[^a-z0-9]){re.escape(compact)}([^a-z0-9]|$)", t):
            continue
        if len(compact) > best_len:
            best = title
            best_len = len(compact)
    return best


def fetch_page_snippet(url: str, timeout: float = 8.0) -> str:
    try:
        req = Request(
            url,
            headers={"User-Agent": "proxy-list-autosort/1.0"},
            method="GET",
        )
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read(120_000)
        html = raw.decode("utf-8", errors="ignore")
        m = TITLE_RE.search(html)
        title = unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else ""
        # light text extract
        text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
        text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = unescape(re.sub(r"\s+", " ", text))[:4000]
        return f"{title} {text}"
    except Exception:
        return ""


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
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Auto-sort unsorted links into existing provider sections.")
    parser.add_argument("--apply", action="store_true", help="Write list.md and unsorted.md (default: dry-run).")
    parser.add_argument("--no-sync", action="store_true", help="Skip convert_list_to_json.py after applying.")
    parser.add_argument("--min-slug-len", type=int, default=4, help="Minimum provider slug length to match.")
    parser.add_argument(
        "--fetch",
        action="store_true",
        help="HTTP-fetch remaining unmatched URLs and match page title/text to existing sections.",
    )
    parser.add_argument("--fetch-workers", type=int, default=16, help="Parallel fetch workers.")
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
    providers, slug_owners, title_by_bare, alias_to_title = build_indexes(
        sections, min_len=args.min_slug_len
    )

    unsorted_urls = extract_unsorted_urls(UNSORTED_MD.read_text(encoding="utf-8"))
    if not unsorted_urls:
        print("No unsorted URLs to process.")
        return 0

    # Fast membership for links already in list.md
    existing_norms: set[str] = set()
    for line in lines:
        m = re.match(r"^\|\s*\|\s*(https?://[^\s|]+)", line)
        if m:
            existing_norms.add(normalize_url(m.group(1)))

    moves: list[tuple[str, str]] = []
    remaining: list[str] = []
    skipped_in_list = 0

    for url in unsorted_urls:
        if normalize_url(url) in existing_norms or find_link(lines, url):
            skipped_in_list += 1
            continue
        provider = match_provider(url, providers, slug_owners, alias_to_title)
        if provider:
            moves.append((url, provider))
        else:
            remaining.append(url)

    fetch_matched = 0
    if args.fetch and remaining:
        print(f"Fetching {len(remaining)} unmatched URLs for title/text clues…")
        still: list[str] = []
        with ThreadPoolExecutor(max_workers=max(1, args.fetch_workers)) as pool:
            futs = {pool.submit(fetch_page_snippet, u): u for u in remaining}
            for fut in as_completed(futs):
                url = futs[fut]
                snippet = fut.result() or ""
                provider = match_from_text(snippet, title_by_bare, alias_to_title) if snippet else None
                if provider:
                    moves.append((url, provider))
                    fetch_matched += 1
                else:
                    still.append(url)
        remaining = still

    by_provider: dict[str, list[str]] = defaultdict(list)
    for url, provider in moves:
        by_provider[provider].append(url)

    print(f"Unsorted URLs scanned: {len(unsorted_urls)}")
    print(f"Would move to sorted list: {len(moves)}")
    if fetch_matched:
        print(f"  (of which from page fetch: {fetch_matched})")
    print(f"Remain unsorted (no provider match): {len(remaining)}")
    if skipped_in_list:
        print(f"Skipped (already in list.md): {skipped_in_list}")

    for provider in sorted(by_provider, key=lambda p: (-len(by_provider[p]), p.lower())):
        print(f"  {provider}: {len(by_provider[provider])}")

    if dry_run:
        if moves:
            print("\nSample matches:")
            for url, provider in moves[:25]:
                print(f"  [{provider}] {url}")
            print("\nRe-run with --apply to write changes.")
        return 0

    if not moves:
        print("Nothing to apply.")
        return 0

    for provider, urls in by_provider.items():
        for url in urls:
            if find_link(lines, url):
                continue
            cur_sec = find_section(parse_sections(lines), provider)
            if not cur_sec:
                print(f"warning: section missing, skip: {provider}", file=sys.stderr)
                remaining.append(url)
                continue
            insert_link_row(
                lines,
                cur_sec,
                url=url,
                found=today_date(),
                contributor=args.contributor,
                contributor_url=DEFAULT_CONTRIBUTOR_URL
                if args.contributor == DEFAULT_CONTRIBUTOR
                else None,
            )

    total = update_section_counts(lines)
    update_total_links(lines, total)
    write_list(lines, dry_run=False)
    # Deduplicate remaining
    rem_seen: set[str] = set()
    rem_out: list[str] = []
    for u in remaining:
        n = normalize_url(u)
        if n in rem_seen:
            continue
        rem_seen.add(n)
        rem_out.append(u)
    UNSORTED_MD.write_text(build_unsorted_md(rem_out), encoding="utf-8")
    print(f"Moved {len(moves)} link(s); {len(rem_out)} remain in unsorted.md; total sorted links: {total}")

    return run_convert(no_sync=args.no_sync)


if __name__ == "__main__":
    raise SystemExit(main())
