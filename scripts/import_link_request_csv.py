#!/usr/bin/env python3
"""Merge Link Request Form CSV into list.md (run from repo root).

- Found Date is N/A when the form does not give a discovery date.
- Empty contributor cell -> plain "Anonymous Contributor".
- Dedupes against URLs already in list.md.

Usage:
  python3 scripts/import_link_request_csv.py [path/to/Link Request Form.csv]
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LIST_MD = REPO / "list.md"

LINK_NAME_TO_HEADING_SLUG: dict[str, str] = {
    "slenite": "Selenite",
    "selenite": "Selenite",
    "truffled": "Truffled",
    "utopia education": "Utopia Education",
    "rammerhead": "CanLite",
    "duckmath": "Duckmath",
    "galaxy": "Galaxy",
    "gn-math": "gn-math",
    "endis": "Endis",
    "studyhub": "StudyHub",
    "void network": "Void Network",
    "lunar": "Lunar",
    "vapor": "Vapor",
    "cowboy station": "CanLite",
    "dogehub": "dogeub",
    "noblocc": "Noblocc",
    "fern": "Fern",
    "rosin": "Rosin",
    "boredom": "Boredom",
}


def normalize_key(url: str) -> str:
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    u = u.replace("?/", "/")
    while True:
        u2 = re.sub(r"(https?://[^/]+)//+", r"\1/", u)
        if u2 == u:
            break
        u = u2
    p = u.split("://", 1)
    if len(p) == 2:
        scheme, rest = p
        host_path = rest.split("/", 1)
        netloc = host_path[0].lower()
        path_part = "/" + host_path[1] if len(host_path) > 1 else ""
        u = f"{scheme}://{netloc}{path_part}"
    return u.rstrip("/") if u.endswith("/") and u.count("/") > 3 else u


def format_table_row(url: str, contributor_md: str) -> str:
    return f"| | {url} | N/A | N/A | N/A | {contributor_md}\n"


def parse_contributor_cell(raw: str) -> str:
    if not (raw or "").strip():
        return "Anonymous Contributor"
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    name_line = lines[0]
    prof = None
    for ln in lines[1:]:
        if ln.startswith("http"):
            prof = ln
            break
    if prof and "github.com" in prof:
        return f"[{name_line}]({prof})"
    return name_line


def normalize_url(url: str) -> str:
    u = url.strip().rstrip(",")
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    u = u.replace("?/", "/")
    while True:
        u2 = re.sub(r"(https?://[^/]+)//+", r"\1/", u)
        if u2 == u:
            break
        u = u2
    return u


def collect_csv_rows(csv_path: Path) -> list[dict]:
    out: list[dict] = []
    with csv_path.open(newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) < 7:
                continue
            _, lname, urls_raw, _, _, _, contrib = row[:7]
            if not lname.strip() or not urls_raw.strip():
                continue
            if lname.strip().casefold() == "link name":
                continue
            key = re.sub(r"[^\w\s-]", "", lname).strip().casefold()
            slug = LINK_NAME_TO_HEADING_SLUG.get(key)
            if not slug:
                print(f"skip unmapped Link Name: {lname!r}", file=sys.stderr)
                continue
            raw_urls = [x.strip() for x in re.split(r"[\n\r]+", urls_raw) if x.strip()]
            urls: list[str] = []
            for x in raw_urls:
                nu = normalize_url(x)
                if nu not in urls:
                    urls.append(nu)
            out.append({"slug": slug, "urls": urls, "contrib_cell": contrib})
    return out


def split_h1_sections(lines: list[str]) -> list[tuple[str, list[str]]]:
    """Return ordered (title, section_lines) including # Proxy List."""
    out: list[tuple[str, list[str]]] = []
    i = 0
    n = len(lines)
    while i < n:
        if lines[i].startswith("# ") and not lines[i].startswith("##"):
            title = lines[i][2:].strip()
            start = i
            i += 1
            while i < n and not (
                lines[i].startswith("# ") and not lines[i].startswith("##")
            ):
                i += 1
            out.append((title, lines[start:i]))
        else:
            i += 1
    return out


def strip_title_key(title: str) -> str:
    return re.sub(r"[^\w\s\-]", "", title, flags=re.UNICODE).strip().casefold()


def match_heading(slug: str, title: str) -> bool:
    """True if list.md H1 `title` is the section for canonical form `slug`."""
    inner = strip_title_key(slug)
    st = strip_title_key(title)
    if inner == st:
        return True
    if slug == "CanLite" and "CanLite" in title:
        return True
    if slug == "dogeub" and "dogeub" in title.casefold():
        return True
    return False


def bump_note_links_count(section_lines: list[str], delta: int) -> None:
    """Increment the numeric Links cell in the first NOTE category row in-place list."""
    for i, line in enumerate(section_lines):
        m = re.match(
            r"^> \| ([^|]+) \| ([^|]+) \| ([^|]+) \| (\d+) \|",
            line,
        )
        if not m:
            continue
        if m.group(1).strip().casefold() == "category":
            continue
        n = int(m.group(4)) + delta
        line = (
            f"> | {m.group(1).strip()} | {m.group(2).strip()} | "
            f"{m.group(3).strip()} | {n} |\n"
        )
        section_lines[i] = line
        return
    raise RuntimeError("could not find NOTE links count row")


def main() -> int:
    csv_arg = (
        sys.argv[1]
        if len(sys.argv) > 1
        else str(Path.home() / "Documents/proxy-list/Link Request Form.csv")
    )
    csv_path = Path(csv_arg)
    if not csv_path.is_file():
        print(f"CSV not found: {csv_path}", file=sys.stderr)
        return 1

    text = LIST_MD.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

    existing_keys: set[str] = set()
    for m in re.finditer(r"https?://[^\s|)>\]\\]+", text):
        existing_keys.add(normalize_key(m.group(0)))

    rows_by_slug: dict[str, list[tuple[str, str]]] = {}
    for entry in collect_csv_rows(csv_path):
        slug = entry["slug"]
        c = parse_contributor_cell(entry["contrib_cell"])
        for u in entry["urls"]:
            k = normalize_key(u)
            if k in existing_keys:
                continue
            existing_keys.add(k)
            rows_by_slug.setdefault(slug, []).append((u, c))

    total_new = sum(len(v) for v in rows_by_slug.values())
    if total_new == 0:
        print("No new URLs to add (all duplicates).")
        return 0

    sections = split_h1_sections(lines)
    titles = [t for t, _ in sections]

    rebuilt: list[str] = []
    touched = 0
    for title, sec_lines in sections:
        sec_list = list(sec_lines)
        slugs_here = [s for s in rows_by_slug if match_heading(s, title)]
        if len(slugs_here) != 1:
            if slugs_here:
                print(f"ambiguous slug for {title}: {slugs_here}", file=sys.stderr)
            rebuilt.extend(sec_list)
            continue
        slug = slugs_here[0]
        new_rows = rows_by_slug.get(slug)
        if not new_rows:
            rebuilt.extend(sec_list)
            continue

        last_data = -1
        for i, ln in enumerate(sec_list):
            if ln.startswith("| | http"):
                last_data = i
        if last_data < 0:
            print(f"no table data rows in section {title!r}", file=sys.stderr)
            rebuilt.extend(sec_list)
            continue

        inserts = [format_table_row(u, c) for u, c in new_rows]
        sec_list = sec_list[: last_data + 1] + inserts + sec_list[last_data + 1 :]
        bump_note_links_count(sec_list, len(new_rows))
        rebuilt.extend(sec_list)
        touched += 1

    new_text = "".join(rebuilt)

    m = re.search(
        r"Total onsite links: (\d+) \((\d+) sorted \+ (\d+) unsorted\)",
        new_text,
    )
    if m:
        _, sorted_n, unsorted_n = map(int, m.groups())
        sorted_n2 = sorted_n + total_new
        total_s2 = sorted_n2 + unsorted_n
        new_text = re.sub(
            r"(> Total onsite links: )\d+ \(\d+ sorted \+ \d+ unsorted\)\\",
            rf"\g<1>{total_s2} ({sorted_n2} sorted + {unsorted_n} unsorted)\\",
            new_text,
            count=1,
        )

    LIST_MD.write_text(new_text, encoding="utf-8")
    print(
        f"Added {total_new} rows in {touched} section(s); "
        f"sorted total +{total_new}.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
