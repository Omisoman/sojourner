#!/bin/sh
# Idempotent Gitea bootstrap (folded into `make demo2-up`):
#   1. the ops user tier-2 opens PRs as;
#   2. the repo it opens them against, holding the baked new-horizons
#      baseline as `main` + tag sojourner-base — pushed from tier-2, the only
#      container with both the bake and a route to Gitea.
set -eu

USER=sojourner-ops
PASS=sojourner-ops-demo-pass1

i=0
until docker exec -u 1000 sojourner-gitea gitea admin user list >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "gitea: not ready after 120 s" >&2; exit 1; }
  sleep 2
done
docker exec -u 1000 sojourner-gitea gitea admin user create \
  --username "$USER" --password "$PASS" --email ops@sojourner.local \
  --admin --must-change-password=false >/dev/null 2>&1 \
  && echo "gitea: user $USER created" \
  || echo "gitea: user $USER already present"

# A rebuilt image carries a new baseline commit: Gitea is the in-stack mirror
# of the bake, so main + the tag follow it (force: that branch is only ever
# the baseline — every change lives on its own PR branch).
docker exec sojourner-tier2 sh -c '
  set -eu
  api="http://gitea:3000/api/v1"
  auth="$GITEA_USER:$GITEA_PASSWORD"
  url="http://$auth@gitea:3000/$GITEA_USER/$GITEA_REPO.git"
  base=$(git -C /opt/sojourner/horizons rev-parse sojourner-base)
  if ! curl -sf -u "$auth" "$api/repos/$GITEA_USER/$GITEA_REPO" >/dev/null; then
    curl -sf -u "$auth" -H "Content-Type: application/json" -X POST "$api/user/repos" \
      -d "{\"name\": \"$GITEA_REPO\", \"private\": true, \"default_branch\": \"main\"}" >/dev/null
    echo "gitea: $GITEA_REPO created"
  fi
  have=$(git ls-remote "$url" refs/tags/sojourner-base | cut -f1)
  if [ "$have" = "$base" ]; then
    echo "gitea: $GITEA_REPO holds baseline ${base%"${base#????????????}"}"
    exit 0
  fi
  git -C /opt/sojourner/horizons push -q --force "$url" main refs/tags/sojourner-base
  echo "gitea: baseline ${base%"${base#????????????}"} pushed as main + sojourner-base"'
