#!/usr/bin/env bash
# Install the webhook server (or any Linux host) to automatically update the proxy list.
set -euo pipefail

REPO="${REPO:-$HOME/proxy-list}"
SERVICE_NAME="proxy-list-webhook"
ENV_FILE="$REPO/deploy/webhook/.env"

echo "==> Repo: $REPO"

if [[ ! -d "$REPO/.git" ]]; then
  echo "Cloning repository..."
  git clone https://github.com/yourworstnightmare1/proxy-list.git "$REPO"
fi

cd "$REPO"
git pull --ff-only origin main || true

echo "==> Python venv + dependencies"
python3 -m venv "$REPO/.venv"
"$REPO/.venv/bin/pip" install --upgrade pip requests

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$REPO/deploy/webhook/env.example" "$ENV_FILE"
  SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  sed -i "s/replace-with-long-random-string/$SECRET/" "$ENV_FILE"
  echo "Created $ENV_FILE with a generated GITHUB_WEBHOOK_SECRET."
  echo "Save this secret for GitHub webhook setup:"
  grep GITHUB_WEBHOOK_SECRET "$ENV_FILE"
fi

echo "==> systemd unit (user service, no sudo)"
USER_UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$USER_UNIT_DIR"
sed "s|%h|$HOME|g" "$REPO/deploy/webhook/proxy-list-webhook.user.service" > "$USER_UNIT_DIR/${SERVICE_NAME}.service"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user status "$SERVICE_NAME" --no-pager || true

echo ""
echo "Done. Next steps:"
echo "  1. Expose port 8787 to the internet (Cloudflare Tunnel — see deploy/webhook/cloudflared.example.yml)."
echo "  2. Add GitHub webhook (see deploy/webhook/GITHUB_WEBHOOK.md)."
echo "  3. Configure git push: ssh deploy key with write access to the repo."
echo "  4. curl http://127.0.0.1:8787/health"