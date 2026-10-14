"""notify — ntfy topic sojourner-ops (internal, ops-net)."""

from __future__ import annotations

import os

import httpx

NTFY_URL = os.environ.get("NTFY_URL", "http://ntfy")
TOPIC = os.environ.get("NTFY_TOPIC", "sojourner-ops")


def notify(message: str) -> dict:
    r = httpx.post(f"{NTFY_URL}/{TOPIC}", content=message.encode(),
                   headers={"Title": "Sojourner ops"}, timeout=10)
    return {"ok": r.status_code == 200, "status": r.status_code, "topic": TOPIC}
