#!/usr/bin/env python
"""Recompute the audit chain (channel 2 — the one Postgres chain tier-2 and
new-horizons both append to) and print one verdict.

    docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/audit_verify.py
"""

from __future__ import annotations

from new_horizons.shared.audit.audit import verify_chain


def main() -> int:
    v = verify_chain()
    if v["ok"]:
        print(f"audit chain intact — {v['rows']} rows")
        return 0
    print(f"audit chain BROKEN at row {v['break_at']} of {v['rows']}: {v.get('reason')}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
