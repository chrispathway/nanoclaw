#!/usr/bin/env bash
# Prod deploy ENTRYPOINT. Installed at /usr/local/sbin/nanoclaw-deploy.sh
# (root:root, chmod 0700) and pinned as the forced command for the GitHub
# Actions deploy key in root's authorized_keys. Runs as root.
#
# Kept OUTSIDE the repo (this file is a versioned reference copy only) so the
# reset below can never replace it mid-run. The build/restart logic lives in
# the repo at scripts/deploy-steps.sh and is re-read fresh on every deploy.
set -euo pipefail
REPO=/home/nanoclaw/nanoclaw
cd "$REPO"

# Guard 1: refuse if a TRACKED file was modified on the box (e.g. the agent
# writing to its own memory). A reset would silently erase it.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "DEPLOY ABORTED: tracked files are dirty on the server:"
  git status --porcelain --untracked-files=no
  exit 1
fi

git fetch --all --prune

# Guard 2: refuse if the box has commits origin doesn't (the old 'ahead 4'
# case). A reset would erase them. Push or back them up first.
AHEAD="$(git rev-list --count origin/main..HEAD)"
if [ "$AHEAD" != "0" ]; then
  echo "DEPLOY ABORTED: server is $AHEAD commit(s) ahead of origin/main:"
  git log --oneline origin/main..HEAD
  exit 1
fi

BEFORE="$(git rev-parse HEAD)"
git reset --hard origin/main   # reset ONLY. never git clean: .env, data/, node_modules are untracked and must survive.
AFTER="$(git rev-parse HEAD)"

export DEPLOY_BEFORE="$BEFORE" DEPLOY_AFTER="$AFTER"
exec bash "$REPO/scripts/deploy-steps.sh"
