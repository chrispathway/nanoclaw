# NanoClaw deploy runbook

Push-to-deploy for the prod email agent. **You never SSH in to ship a change.** Edit → commit → push to `main`, and GitHub Actions deploys it.

## How it runs (prod)

- Host: `178.104.67.7` (Hetzner, `ssh nanoclaw` alias, root login, key `~/.ssh/hetzner_nanoclaw`).
- The app is a **systemd** unit `nanoclaw.service` running as the unprivileged `nanoclaw` user: `node /home/nanoclaw/nanoclaw/dist/index.js`, `Restart=always`, TZ Europe/Berlin.
- Per agent turn the Node supervisor shells out to `docker run` (image `nanoclaw-agent:latest`, ephemeral `nanoclaw-*` containers). The repo is mounted **read-only** into the container; the group dir and `life-context` are read-write.
- `dist/` is **gitignored and built on the box** (`npm run build` = tsc). `groups/*/CLAUDE.md` memory is **read live** each turn.
- Second repo mounted for grounding: `/home/nanoclaw/life-context` (this is the life-management context system).

## Make a change

1. Edit the code/memory in this repo (locally or via Cowork).
2. Commit and push to `main`.
3. The `Deploy to prod` workflow runs `nanoclaw-deploy.sh` on the box, which:
   - **aborts** if any tracked file is dirty on the server, or if the box is ahead of `origin/main` (nothing gets silently erased);
   - `git fetch` + `git reset --hard origin/main`;
   - rebuilds only if `src/`, `package*.json` or `tsconfig.json` changed (`npm ci` + `npm run build`); rebuilds the docker image only if `container/` changed;
   - if code changed: drains in-flight `nanoclaw-*` containers, then `systemctl restart nanoclaw`;
   - if only memory/markdown changed: no restart (read live).
4. Watch it in the repo's Actions tab.

## Rollback

Revert the commit and push, the revert auto-deploys:

```
git revert <bad-sha> && git push origin main
```

## Safety invariants (do not break these)

- **Never commit on the server.** The box is deploy-only. Anything committed only there is erased on the next deploy (and Guard 2 will refuse to deploy until you resolve it).
- **`groups/*/CLAUDE.md` are human/GitHub-owned** and pinned `444 root` so the agent can't rewrite them. Change agent instructions here and push, not on the box.
- **Never `git clean`** in the deploy. `.env`, `data/` (~57 MB of Telegram/WhatsApp session auth + IPC/session state) and `node_modules` are untracked and must survive. `reset --hard` alone leaves them alone; the build only ever `rm -rf dist`.
- Deploy runs as **root** (needed to update the root-owned locked memory files and to `systemctl restart`). `node_modules/`, `dist/` end up root-owned; the service reads them fine.

## One-time setup (already done, recorded here)

1. Dedicated deploy key `~/.ssh/gha_nanoclaw_deploy`, public half in root's `authorized_keys` on the box, pinned to a forced command:
   `command="/usr/local/sbin/nanoclaw-deploy.sh",restrict ssh-ed25519 AAAA... gha-deploy`
2. `/usr/local/sbin/nanoclaw-deploy.sh` = the wrapper in `scripts/prod-deploy-wrapper.sh`, installed root:root 0700.
3. GitHub repo secrets: `DEPLOY_HOST=178.104.67.7`, `DEPLOY_USER=root`, `DEPLOY_SSH_KEY=<private key>`.

## life-context credential (rotated 2026-09-01)

Fine-grained PAT `nanoclaw-life-context-prod`, scoped to `chrispathway/life-context`, Contents read/write, expires **2027-09-01**. No token in `.git/config` anymore; it lives in `.git/nanoclaw-credentials` (0600 `nanoclaw:nanoclaw`) behind a git credential helper whose path resolves at runtime, so the same bind-mounted `.git/config` works from both the container path (`/workspace/extra/life-context`) and the host path (`/home/nanoclaw/life-context`).

## Open items

- Rotate `nanoclaw-life-context-prod` before it expires **2027-09-01** (reminder set for mid-Aug 2027).
