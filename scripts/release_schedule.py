"""User-facing release schedule (Option A): revision bumps on Sundays only."""

from __future__ import annotations

import os
from datetime import datetime


def should_publish_release(now: datetime | None = None) -> bool:
    """Return True when list.md revision and Last Updated should bump."""
    override = os.environ.get("LINK_CHECK_PUBLISH_RELEASE", "").strip().lower()
    if override in ("1", "true", "yes", "force", "publish", "release"):
        return True
    if override in ("0", "false", "no", "silent", "maintenance"):
        return False
    now = now or datetime.now()
    return now.weekday() == 6  # Sunday


def commit_message_for_run(info: dict) -> str:
    version = str(info.get("version") or "v0.0.0")
    revision = str(info.get("revision") or "r0")
    removed = str(info.get("removed") if info.get("removed") is not None else "0")
    total = str(info.get("total") if info.get("total") is not None else "0")

    release = info.get("release_published")
    if isinstance(release, str):
        release = release.strip().lower() in ("1", "true", "yes")
    elif release is None:
        release = False

    if release:
        return (
            f"{version} {revision} | purged {removed} dead links, link count: {total}"
        )
    return (
        f"Silent maintenance | link check (purged {removed} dead links, "
        f"link count: {total})"
    )
