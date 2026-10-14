#!/usr/bin/env python
"""The tier-2 A2A queue, for the operator console (and its /queue command).

    docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/ops_queue.py [task_id]

Lists tasks newest first — state, skill, summary and the evaluation verdict
once phase A has run. Read-only; signs an ops JWT like approve.py signs admin.
(Not `queue.py`: server.py runs from this directory, and that name would
shadow the stdlib `queue` module its A2A runtime imports.)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from approve import rpc  # same JSON-RPC client, same endpoint

from new_horizons.shared.rules.rbac import issue_token


def state(task: dict) -> str:
    return str(task.get("status", {}).get("state", "?")).lower() \
        .replace("task_state_", "").replace("_", "-")


def request(task: dict) -> dict:
    """The tier-1 request is the JSON message that opened the task (later
    messages are status text and the human's `approve`)."""
    for msg in task.get("history", []):
        for part in msg.get("parts", []):
            try:
                req = json.loads(part.get("text", ""))
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(req, dict) and "skill" in req:
                return req
    return {}


def verdict(task: dict) -> str:
    for art in task.get("artifacts", []):
        for part in art.get("parts", []):
            try:
                ev = json.loads(part.get("text", "")).get("evaluation", {})
            except (json.JSONDecodeError, AttributeError):
                continue
            if ev:
                return str(ev.get("verdict", "?"))
    return "-"


def patch(task: dict) -> dict:
    """What the approval actually covers: the replayed patch from phase-a."""
    for art in task.get("artifacts", []):
        for part in art.get("parts", []):
            try:
                p = json.loads(part.get("text", "")).get("patch", {})
            except (json.JSONDecodeError, AttributeError):
                continue
            if p:
                return p
    return {}


def print_patch(task: dict) -> None:
    p = patch(task)
    if not p:
        return
    if not p.get("ok"):
        print(f"  patch: NOT APPLIED — {p.get('error', p.get('skipped', '?'))}")
        return
    print(f"  patch sha256: {p.get('sha256', '?')}")
    print(f"  author:       {p.get('author', '?')}  head: {p.get('head', '?')}")
    for c in p.get("commits", []):
        print(f"  commit:       {c}")
    for f in p.get("files", []):
        print(f"  file:         {f}")
    if p.get("diffstat"):
        for line in str(p["diffstat"]).splitlines():
            print(f"  | {line}")


def main() -> None:
    token = issue_token(role="ops", sub="ops-console")
    if len(sys.argv) > 1:
        tasks = [rpc("GetTask", {"id": sys.argv[1], "historyLength": 50}, token)]
    else:
        tasks = rpc("ListTasks", {"historyLength": 50, "includeArtifacts": True,
                                  "pageSize": 50}, token).get("tasks", [])
    if not tasks:
        print("queue empty")
        return
    single = len(sys.argv) > 1
    for t in reversed(tasks):
        req = request(t)
        print(f"{t.get('id')}  {state(t):15s} {req.get('skill', '?'):9s} "
              f"verdict={verdict(t):5s} {req.get('summary', '')}")
        if single:
            print_patch(t)


if __name__ == "__main__":
    main()
