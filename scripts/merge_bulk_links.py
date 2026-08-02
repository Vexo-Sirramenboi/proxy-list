#!/usr/bin/env python3
"""
Merge bulk link contributions into list.md:
- Skip BunnyCDN (hostname ends with b-cdn.net)
- Global dedupe vs existing rows + within submission order (first section wins)
- Map section titles to existing # headers; unknown titles become pending sections
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
LIST_PATH = ROOT / "list.md"

ROW_TMPL = "| | {url} | 5/9/2026 | N/A | N/A | [1NobleCyber](https://github.com/1NobleCyber)"

# Canonical markdown heading line for insertion (must match list.md exactly)
HEADER_LINE = {
    "ford": "# 🍓 Strawberri",
    "studyhub": "# 📖 StudyHub",
    "fern": "# 🪴 Fern",
    "xylora": "# ✖️ Xylora",
    "lunar": "# 🌕 Lunar",
    "daydreamx": "# ⭐ DayDream X",
    "space": "# 🌑 Space",
    "frogies arcade": "# 🐸 frogie's arcade",
    "frogiesarcade": "# 🐸 frogie's arcade",
    "vapor": "# 💨 Vapor",
    "tglsc": "# ⬡ TGLSC Density 4",
    "utopia": "# 🦄 Utopia Education",
    "cherri": "# 🌸 Cherri",
    "zen": "__NEW_Zen__",
    "shadow": "# 👤 Shadow",
    "dogeub": "# 🐶 dogeub",
    "velera": "# 🌙 Velara",
    "truffled": "# 🍄 Truffled",
    "galaxy": "# 🪐 Galaxy",
    "overcloaked": "# 🏴 OverCloaked",
    "rosin": "# 🎮 Rosin",
    "infamous": "# Infamous",
    "lucide": "# 🤍 Lucide",
    "luicide": "# 🤍 Lucide",
    "ghost": "# 👻 Ghost",
    "noah's tutoring": "# 🟨 Noahs Tutoring",
    "noahs tutoring": "# 🟨 Noahs Tutoring",
    "gn-math": "# ➗ gn-math",
    "gnmath": "# ➗ gn-math",
    "bloxcraftubg": "# ❤️ BloxCraft Games",
    "relic": "# ▶️ Relic Network",
    "chicken vault": "# Chicken Kings Vault",
    "chickenvault": "# Chicken Kings Vault",
    "1key": "# 🗝️ 1Key",
    "only lessons": "# OnlyLessons",
    "onlylessons": "# OnlyLessons",
    "freedom": "__NEW_Freedom__",
    "rammerhead": "__NEW_RammerHead__",
    "celestial": "# 🔷 Celestial",
    "selenite": "# 💜 Selenite",
    "quasar": "# ✨ Quasar",
    "axiom": "# 🔼 Axiom",
    "boredom": "# 🥱 Boredom",
    "everest": "# ⛰️ Everest",
    "flamed lite": "__NEW_Flamed Lite__",
    "hamcraft": "__NEW_Hamcraft__",
}


def normalize_header_key(line: str) -> str:
    s = line.strip().lower()
    s = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", s)
    s = re.sub(r"[^a-z0-9\s'-]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def clean_url(raw: str) -> str | None:
    raw = raw.strip()
    raw = raw.split("<")[0].strip()
    raw = raw.split("[")[0].strip()
    raw = raw.rstrip(".,;)]}\"'")
    raw = re.sub(r"\]\([^)]*\)", "", raw)
    # Fix "https:// think-learn" typos
    raw = re.sub(r"^https://\s+", "https://", raw, flags=re.I)
    raw = re.sub(r"^http://\s+", "http://", raw, flags=re.I)
    if not raw.startswith(("http://", "https://")):
        return None
    try:
        p = urlparse(raw)
    except Exception:
        return None
    if not p.netloc:
        return None
    host = p.netloc.lower().split("@")[-1]
    if host.endswith(":443"):
        host = host[:-4]
    if host == "b-cdn.net" or host.endswith(".b-cdn.net"):
        return None
    # Normalize for dedupe
    path = p.path or ""
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    q = p.query
    norm = urlunparse((p.scheme.lower(), host, path, "", q, ""))
    return norm


def norm_key(u: str) -> str:
    try:
        p = urlparse(u)
        h = p.netloc.lower()
        path = (p.path or "").lower()
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")
        return f"{p.scheme}://{h}{path}?{p.query}"
    except Exception:
        return u.lower()


def extract_existing_urls(md: str) -> set[str]:
    found = set()
    for m in re.finditer(r"\|\s*\|\s*(https?://[^\s|]+)", md):
        cu = clean_url(m.group(1))
        if cu:
            found.add(norm_key(cu))
    return found


def parse_bulk(text: str) -> list[tuple[str, str]]:
    """Return list of (header_line, cleaned_url) in order."""
    lines = text.splitlines()
    current_key: str | None = None
    out: list[tuple[str, str]] = []
    url_re = re.compile(r"(https?://[^\s\|<>\[\]()]+)", re.I)

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        low = stripped.lower()
        if stripped.startswith("#"):
            continue
        if "can you add these links" in low:
            continue
        if stripped.startswith(("-", ">", "|", "`")):
            continue
        if any(
            stripped.startswith(x)
            for x in (
                "For the following",
                "if the link",
                "if the domain",
                "if there is",
                "exclude any",
                "Note:",
                "(",
            )
        ):
            continue

        url_matches = list(url_re.finditer(stripped))
        if url_matches:
            if current_key is None:
                continue
            header_ref = HEADER_LINE.get(current_key)
            if not header_ref:
                continue
            for m in url_matches:
                cu = clean_url(m.group(1))
                if cu:
                    out.append((header_ref, cu))
            continue

        # Possible section title (no URL on line)
        nk = normalize_header_key(stripped)
        nk_compact = nk.replace(" ", "")
        key = None
        if nk in HEADER_LINE:
            key = nk
        elif nk_compact in {k.replace(" ", "") for k in HEADER_LINE}:
            for k in HEADER_LINE:
                if k.replace(" ", "") == nk_compact:
                    key = k
                    break
        if key:
            current_key = key
            continue

    return out


def section_body_span(md: str, header_line: str) -> tuple[int, int] | None:
    """Start/end indices of section body (exclusive end), inside md."""
    i = md.find(header_line)
    if i < 0:
        return None
    start = i + len(header_line)
    j = md.find("\n# ", start)
    end = len(md) if j < 0 else j
    return start, end


def append_rows_to_section(md: str, header_line: str, rows: list[str]) -> str:
    if not rows:
        return md
    span = section_body_span(md, header_line)
    if not span:
        raise SystemExit(f"Missing section: {header_line}")
    s, e = span
    chunk = md[s:e]
    lines = chunk.split("\n")
    insert_at = len(lines)
    while insert_at > 0 and lines[insert_at - 1].strip() == "":
        insert_at -= 1
    block = "\n".join(rows)
    new_chunk = "\n".join(lines[:insert_at]) + "\n" + block + "\n" + "\n".join(lines[insert_at:])
    return md[:s] + new_chunk + md[e:]


def pending_section_block(title: str, rows: list[str]) -> str:
    n = len(rows)
    note = (
        f"# {title}\n"
        "> [!NOTE]\n"
        "> | Category | Capabilities | Protocol(s) | Links |\n"
        "> | - | - | - | - |\n"
        f"> | pending | pending | pending | {n} |\n\n"
        "> [!IMPORTANT]\n"
        "> This section has not been categorized or checked for protocol(s) and capabilities.\n\n"
        "| Locked | Link | Found Date | Username | Password | Contributor |\n"
        "| - | - | - | - | - | - |\n"
        + "\n".join(rows)
        + "\n\n"
    )
    return note


def bump_note_links(md: str, header_line: str, delta: int) -> str:
    if delta == 0:
        return md
    span = section_body_span(md, header_line)
    if not span:
        return md
    s, e = span
    chunk = md[s:e]
    lines = chunk.split("\n")
    out: list[str] = []
    bumped = False
    for line in lines:
        if (
            not bumped
            and line.startswith("> |")
            and "| - |" not in line
            and "Category | Capabilities" not in line
        ):
            m = re.search(r"\|\s*(\d+)\s*\|\s*$", line)
            if m:
                n = int(m.group(1))
                line = line[: m.start(1)] + str(n + delta) + line[m.end(1) :]
                bumped = True
        out.append(line)
    return md[:s] + "\n".join(out) + md[e:]


NEW_MARKERS = {
    "__NEW_Zen__": "Zen",
    "__NEW_Freedom__": "Freedom",
    "__NEW_RammerHead__": "RammerHead",
    "__NEW_Flamed Lite__": "Flamed Lite",
    "__NEW_Hamcraft__": "Hamcraft",
}


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: merge_bulk_links.py <bulk_raw.txt>", file=sys.stderr)
        sys.exit(1)
    raw_path = Path(sys.argv[1])
    text = raw_path.read_text(encoding="utf-8")
    pairs = parse_bulk(text)
    md = LIST_PATH.read_text(encoding="utf-8")
    existing = extract_existing_urls(md)

    # Dedupe submission order; gather rows per real header
    seen_new: set[str] = set()
    per_header: dict[str, list[str]] = {}
    new_sections: dict[str, list[str]] = {}

    for header_ref, cu in pairs:
        nk = norm_key(cu)
        if nk in existing or nk in seen_new:
            continue
        seen_new.add(nk)
        row = ROW_TMPL.format(url=cu)
        if header_ref in NEW_MARKERS:
            title = NEW_MARKERS[header_ref]
            new_sections.setdefault(title, []).append(row)
            continue
        per_header.setdefault(header_ref, []).append(row)

    # Append to existing sections (stable order)
    for hline in sorted(per_header.keys()):
        rows = per_header[hline]
        if not rows:
            continue
        md = append_rows_to_section(md, hline, rows)
        md = bump_note_links(md, hline, len(rows))

    # Insert new pending sections before # Zyron
    if new_sections:
        idx = md.find("# Zyron")
        if idx < 0:
            idx = len(md)
        blocks = []
        for title in ("Zen", "Freedom", "RammerHead", "Flamed Lite", "Hamcraft"):
            if title not in new_sections:
                continue
            blocks.append(pending_section_block(title, new_sections[title]))
        md = md[:idx] + "\n".join(blocks) + md[idx:]

    LIST_PATH.write_text(md, encoding="utf-8")
    print(
        "Merged:",
        {k: len(v) for k, v in per_header.items()},
        "new:",
        {k: len(v) for k, v in new_sections.items()},
    )


if __name__ == "__main__":
    main()
