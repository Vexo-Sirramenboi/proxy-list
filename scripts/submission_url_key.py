"""Normalize proxy URLs for submission duplicate checks (full URL, not domain-only)."""

from __future__ import annotations

import re


def submission_url_key(url: str) -> str:
    """Match import_link_request_csv.normalize_key — preserves subdomain + path."""
    u = (url or "").strip()
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    u = u.replace("?/", "/")
    while True:
        u2 = re.sub(r"(https?://[^/]+)//+", r"\1/", u)
        if u2 == u:
            break
        u = u2
    parts = u.split("://", 1)
    if len(parts) == 2:
        scheme, rest = parts
        host_path = rest.split("/", 1)
        netloc = host_path[0].lower()
        path_part = "/" + host_path[1] if len(host_path) > 1 else ""
        u = f"{scheme}://{netloc}{path_part}"
    if u.endswith("/") and u.count("/") > 3:
        u = u.rstrip("/")
    return u


def normalize_submission_url(url: str) -> str:
    """Canonical display URL for stored submissions."""
    u = (url or "").strip().rstrip(",")
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    u = u.replace("?/", "/")
    while True:
        u2 = re.sub(r"(https?://[^/]+)//+", r"\1/", u)
        if u2 == u:
            break
        u = u2
    return u
