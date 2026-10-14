#!/usr/bin/env python
"""Human approval CLI — moves a blocked deploy task past the approval gate.

    docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/approve.py <task_id>

Sends an `approve` message into the task over A2A with an ADMIN JWT (the
approval is a human governance act; the audit chain records who approved).
Also exposed to the ops persona as the OpenCode command /approve.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))   # tier2/ (approve, tools) from anywhere
from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[1] / ".env")

import httpx

from new_horizons.shared.rules.rbac import issue_token

A2A_URL = os.environ.get("A2A_TIER2_URL", "http://localhost:9000/")


def rpc(method: str, params: dict, token: str) -> dict:
    r = httpx.post(A2A_URL, json={"jsonrpc": "2.0", "id": str(uuid.uuid4()),
                                  "method": method, "params": params},
                   headers={"Authorization": f"Bearer {token}",
                            "A2A-Version": "1.0"}, timeout=600)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise SystemExit(f"A2A error: {body['error']}")
    return body["result"]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: approve.py <task_id>")
    task_id = sys.argv[1]
    token = issue_token(role="admin", sub="human-approver")

    task = rpc("GetTask", {"id": task_id}, token)
    state = task.get("status", {}).get("state", "?")
    print(f"task {task_id}: state={state}")
    if "INPUT_REQUIRED" not in str(state).upper() and "input-required" not in str(state):
        raise SystemExit("task is not awaiting approval — nothing to do")

    result = rpc("SendMessage", {"message": {
        "messageId": str(uuid.uuid4()),
        "taskId": task_id,
        "role": "ROLE_USER",
        "parts": [{"text": "approve"}],
    }}, token)
    task = result.get("task", result)
    state = task.get("status", {}).get("state", "?")
    print(f"approved -> state={state}")
    for a in task.get("artifacts", []):
        name = a.get("name", "artifact")
        for p in a.get("parts", []):
            if "text" in p:
                print(f"--- {name} ---")
                try:
                    print(json.dumps(json.loads(p["text"]), indent=1)[:1200])
                except Exception:
                    print(p["text"][:800])


if __name__ == "__main__":
    main()
