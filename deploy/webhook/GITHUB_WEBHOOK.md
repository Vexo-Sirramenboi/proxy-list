# GitHub webhook → local link checker

Runs `scripts/run_link_check_pipeline.py` on your machine when `main` is pushed with link-list changes.

## Why you need a public URL

GitHub cannot POST to a private LAN IP (`192.168.68.200`). Use **Cloudflare Tunnel** (recommended), ngrok, or port-forward + dynamic DNS so GitHub can reach:

```text
https://<your-public-host>/github/webhook
```

The server listens on `0.0.0.0:8787` locally (`/health`, `/github/webhook`).

## 1. Install on the server

```bash
ssh jason@192.168.68.200
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yourworstnightmare1/proxy-list/main/deploy/webhook/install.sh)"
```

Or clone the repo and run `deploy/webhook/install.sh` manually.

The installer registers a **user** systemd service (`systemctl --user`) so root/sudo is not required.

Edit `deploy/webhook/.env`:

- `WEBHOOK_REPO_ROOT` — path to the clone
- `GITHUB_WEBHOOK_SECRET` — random string (install.sh generates one)
- `DISCORD_WEBHOOK_URL` — optional notifications

## 2. Git push credentials

The pipeline can commit dead-link purges like CI. On the server (`jason@debian` / `192.168.68.200` — **same machine**; run these locally, do not `ssh` to yourself):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/proxy-list-deploy -N ""
cat ~/.ssh/proxy-list-deploy.pub
```

Add that public key in GitHub → **repo → Settings → Deploy keys** → **Allow write access**.

Then configure SSH for GitHub and switch the remote to SSH:

```bash
ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts

cat >> ~/.ssh/config << 'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/proxy-list-deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

cd ~/proxy-list
git remote set-url origin git@github.com:yourworstnightmare1/proxy-list.git
git pull --ff-only origin main
```

**Until the deploy key is on GitHub**, use HTTPS to pull updates:

```bash
cd ~/proxy-list
git remote set-url origin https://github.com/yourworstnightmare1/proxy-list.git
git pull --ff-only origin main
systemctl --user restart proxy-list-webhook
```

## 3. Expose with Cloudflare Tunnel (example)

```bash
cloudflared tunnel create proxy-list-webhook
# Route webhook.yourdomain.com → http://127.0.0.1:8787
cloudflared tunnel run proxy-list-webhook
```

See `deploy/webhook/cloudflared.example.yml`.

## 4. GitHub repository webhook

**Settings → Webhooks → Add webhook**

| Field | Value |
|--------|--------|
| Payload URL | `https://<your-public-host>/github/webhook` |
| Content type | `application/json` |
| Secret | Same as `GITHUB_WEBHOOK_SECRET` in `.env` |
| SSL verification | Enable |
| Events | **Just the push event** |

### Watched paths (same as CI)

Triggers only when the push touches:

- `list.md`, `unsorted.md`, `unsorted_raw.txt`
- `scripts/link_checker.py`, `scripts/convert_list_to_json.py`
- `scripts/update_link_check_meta.py`, `scripts/update_unsorted_from_raw.py`

## 5. Verify

```bash
curl -s http://127.0.0.1:8787/health | jq
```

In GitHub webhook settings, use **Recent Deliveries** → redeliver a `push` event. You should get `202` and see logs:

```bash
journalctl --user -u proxy-list-webhook -f
```

Manual run without webhook:

```bash
cd ~/proxy-list
.venv/bin/python scripts/run_link_check_pipeline.py
```

## Nightly schedule (11:00 PM local time)

`install.sh` enables a **systemd user timer** that runs the full pipeline every day at **23:00** in the server’s local timezone:

```bash
systemctl --user list-timers proxy-list-link-check.timer
journalctl --user -u proxy-list-link-check.service -f
```

Run once immediately (without waiting for 11 PM):

```bash
systemctl --user start proxy-list-link-check.service
```

Change the time by editing `deploy/webhook/proxy-list-link-check.timer` (`OnCalendar=*-*-* 23:00:00`), then:

```bash
sed "s|%h|$HOME|g" ~/proxy-list/deploy/webhook/proxy-list-link-check.timer > ~/.config/systemd/user/proxy-list-link-check.timer
systemctl --user daemon-reload
systemctl --user restart proxy-list-link-check.timer
```

**GitHub Actions** also runs the checker every 6 hours on GitHub’s runners. To avoid duplicate bot commits, narrow or remove the `schedule:` block in `.github/workflows/link_checker.yml` if you rely on the local nightly run instead.
