#!/usr/bin/env bash
# Build + restart half of the deploy, lives IN the repo so it can be iterated
# via a normal push. Invoked by /usr/local/sbin/nanoclaw-deploy.sh AFTER the
# guarded fetch+reset. Runs as root on the prod box.
#
# Contract: the caller exports DEPLOY_BEFORE and DEPLOY_AFTER (commit shas
# before/after the reset). If BEFORE is empty we rebuild unconditionally.
set -euo pipefail
cd "$(dirname "$0")/.."

BEFORE="${DEPLOY_BEFORE:-}"
AFTER="${DEPLOY_AFTER:-$(git rev-parse HEAD)}"

if [ -n "$BEFORE" ]; then
  CHANGED="$(git diff --name-only "$BEFORE" "$AFTER" || true)"
else
  CHANGED="__ALL__"
fi
echo "== changed files =="
echo "$CHANGED"

RESTART=0

# dist/ is gitignored and built on the box, so any src/dep/config change needs a rebuild.
if [ "$CHANGED" = "__ALL__" ] || echo "$CHANGED" | grep -qE '^(src/|package\.json$|package-lock\.json$|tsconfig\.json$)'; then
  echo "== code or deps changed -> rebuild =="
  rm -rf dist                 # remove stale output only; NEVER git clean (would nuke .env, data/, node_modules)
  npm ci --no-audit --no-fund
  npm run build
  RESTART=1
fi

# The docker agent image only rebuilds when container/ changes.
if echo "$CHANGED" | grep -qE '^container/'; then
  echo "== container/ changed -> rebuild agent image =="
  bash ./container/build.sh
  RESTART=1
fi

if [ "$RESTART" = "1" ]; then
  # KillMode=process means a restart orphans in-flight agent containers.
  # Drain them first (bounded), then restart the supervisor.
  echo "== draining in-flight agent containers =="
  for i in $(seq 1 24); do
    n="$(docker ps --filter 'name=nanoclaw-' --format '{{.Names}}' | wc -l | tr -d ' ')"
    [ "$n" = "0" ] && { echo "  drained"; break; }
    echo "  $n container(s) still running, waiting ($i/24)"
    sleep 5
  done
  systemctl restart nanoclaw.service
  sleep 2
  systemctl --no-pager --lines=0 is-active nanoclaw.service
  echo "== restarted nanoclaw.service =="
else
  echo "== memory/markdown-only change, read live, no restart needed =="
fi
