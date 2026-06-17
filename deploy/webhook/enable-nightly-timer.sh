#!/usr/bin/env bash
set -euo pipefail
USER_UNIT_DIR="$HOME/.config/systemd/user"
REPO="$HOME/proxy-list"
mkdir -p "$USER_UNIT_DIR"
sed "s|%h|$HOME|g" "$REPO/deploy/webhook/proxy-list-link-check.service" > "$USER_UNIT_DIR/proxy-list-link-check.service"
sed "s|%h|$HOME|g" "$REPO/deploy/webhook/proxy-list-link-check.timer" > "$USER_UNIT_DIR/proxy-list-link-check.timer"
systemctl --user unmask proxy-list-link-check.timer 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now proxy-list-link-check.timer
systemctl --user list-timers proxy-list-link-check.timer --no-pager
