#!/usr/bin/env bash
# The sandbox walls and the wiring, checked against the RUNNING stack
# (make demo2-up first). Each line prints PASS/FAIL; exit 1 on any FAIL.
#
#   egress blocked three ways  curl over HTTPS, DNS, git — in tier1, tier2, staging
#   opencode debug config      from /workspace/project: the agents + skills load
#   SANDBOX-OK                 a headless OpenCode round-trip through llm-proxy
#   offline suite              uv run pytest -q inside tier-1
#   A2A hello                  tier-1 -> tier-2 with its bearer (completed),
#                              and without one (rejected)
set -uo pipefail
fail=0
ok()  { printf '  PASS  %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
blocked() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name (reached the outside)"; else ok "$name"; fi; }

echo "egress (each must FAIL to connect):"
for c in sojourner-tier1 sojourner-tier2 sojourner-staging; do
  blocked "$c: curl https://pypi.org"          docker exec "$c" curl -sS --max-time 8 https://pypi.org/simple/
  blocked "$c: DNS github.com"                 docker exec "$c" /opt/venv/bin/python -c "import socket; socket.getaddrinfo('github.com', 443)"
  blocked "$c: git ls-remote github"           docker exec "$c" timeout 15 git ls-remote https://github.com/git/git HEAD
done

echo "walls:"
check "tier1: rootfs is read-only"  sh -c '! docker exec sojourner-tier1 touch /opt/x'
check "tier1: no Gitea/DB secret"   sh -c '! docker exec sojourner-tier1 env | grep -E "^(GITEA|DATABASE|A2A_JWT)"'
check "tier1: no route to Postgres" sh -c '! docker exec sojourner-tier1 /opt/venv/bin/python -c "import socket; socket.create_connection((\"horizons-postgres\", 5432), 3)"'

echo "opencode:"
cfg=$(docker exec -w /workspace/project sojourner-tier1 opencode debug config 2>/dev/null)
check "debug config: developer + reviewer agents" sh -c 'printf "%s" "$0" | grep -q "\"developer\"" && printf "%s" "$0" | grep -q "\"reviewer\""' "$cfg"
skills=$(docker exec -w /workspace/project sojourner-tier1 opencode debug skill 2>/dev/null || true)
for s in streamlit-view analytics-module kb-document a2a-delegate; do
  check "skill $s discoverable" sh -c 'printf "%s" "$0" | grep -q "$1"' "$skills" "$s"
done
out=$(docker exec -w /workspace/project sojourner-tier1 timeout 240 opencode run "Reply with exactly SANDBOX-OK and nothing else." 2>&1 | tail -5)
check "headless round-trip via llm-proxy says SANDBOX-OK" sh -c 'printf "%s" "$0" | grep -q "SANDBOX-OK"' "$out"

echo "tests:"
suite=$(docker exec -w /workspace/project sojourner-tier1 uv run pytest -q -p no:cacheprovider 2>&1 | tail -1)
check "tier1 offline: uv run pytest -q ($suite)" sh -c 'printf "%s" "$0" | grep -q " passed" && ! printf "%s" "$0" | grep -q -E "failed|error"' "$suite"

echo "a2a:"
hello=$(docker exec -i sojourner-tier1 /opt/venv/bin/python - <<'PY' 2>&1
import json, os, uuid, httpx
card = httpx.get("http://tier2:9000/.well-known/agent-card.json", timeout=10).json()
def send(token):
    h = {"A2A-Version": "1.0", **({"Authorization": f"Bearer {token}"} if token else {})}
    body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "SendMessage", "params": {"message": {
        "messageId": str(uuid.uuid4()), "role": "ROLE_USER",
        "parts": [{"text": json.dumps({"skill": "notify", "summary": "hello from tier-1"})}]}}}
    r = httpx.post("http://tier2:9000/", json=body, headers=h, timeout=300).json()
    task = r.get("result", {}).get("task", r.get("result", {}))
    return str(task.get("status", {}).get("state", r.get("error")))
print(card["name"], send(os.environ["A2A_BEARER_TIER1"]), send(""))
PY
)
check "agent card + notify task completed + no-token rejected ($hello)" \
  sh -c 'printf "%s" "$0" | grep -q "sojourner-tier2-ops TASK_STATE_COMPLETED TASK_STATE_REJECTED"' "$hello"

[ "$fail" = 0 ] && echo "all checks passed" || echo "SOME CHECKS FAILED"
exit "$fail"
