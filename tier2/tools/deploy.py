"""deploy_staging — publish the approved checkout to the staging Streamlit.
Access rules: approval_required — the A2A task parks at input-required first.

The staging container runs the deployed tree (`/srv/staging/app`, its src/
on PYTHONPATH) as a second Streamlit, read-only, with its data on its own
volume (HORIZONS_DATA); a supervisor restarts it when the deploy stamp changes
and writes the stamp it now serves to /srv/staging-run/serving. This tool:

* rotates the current tree to /srv/staging/.prev (rollback = a directory swap),
* exports the approved commit with `git archive HEAD` — what was reviewed is
  exactly what ships, never an untracked or ignored file of the workspace —
  and writes the stamp,
* waits until staging serves THAT stamp and answers its health check.

The audit event that makes the deploy appear on the app's Changes page is
written by the server once this returns ok (it knows the task and the human
who approved it — the model never supplies either).
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .workspace import PROJECT, changed_files, head

STAGING = Path(os.environ.get("STAGING_DIR", "/srv/staging"))
RUN = Path(os.environ.get("STAGING_RUN_DIR", "/srv/staging-run"))
STAGING_URL = os.environ.get("STAGING_URL", "http://staging:8501/")
WAIT_S = int(os.environ.get("STAGING_WAIT_S", "120"))


def _healthy(stamp: str) -> dict:
    deadline = time.time() + WAIT_S
    last = "not started"
    while time.time() < deadline:
        serving = (RUN / "serving").read_text().strip() if (RUN / "serving").exists() else ""
        if serving == stamp:
            try:
                r = httpx.get(STAGING_URL.rstrip("/") + "/_stcore/health", timeout=5)
                if r.status_code == 200:
                    shell = httpx.get(STAGING_URL, timeout=5)
                    return {"ok": shell.status_code == 200, "serving": serving,
                            "health": r.text.strip()[:20], "shell": shell.status_code}
                last = f"health {r.status_code}"
            except httpx.HTTPError as exc:
                last = type(exc).__name__
        else:
            last = f"serving {serving or '-'}"
        time.sleep(2)
    return {"ok": False, "error": f"staging did not serve {stamp} within {WAIT_S}s ({last})"}


def _export(dest: Path) -> None:
    tree = subprocess.run(["git", "archive", "--format=tar", "HEAD"], cwd=PROJECT,
                          capture_output=True, check=True, timeout=120).stdout
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(tree)) as tar:
        tar.extractall(dest, filter="data")


def deploy_staging() -> dict:
    if not (PROJECT / "src" / "new_horizons" / "app" / "app.py").exists():
        return {"error": f"no app in {PROJECT / 'src'} — nothing to deploy"}
    STAGING.mkdir(parents=True, exist_ok=True)
    incoming = STAGING / ".incoming"
    shutil.rmtree(incoming, ignore_errors=True)
    try:
        _export(incoming)
    except (subprocess.CalledProcessError, tarfile.TarError) as exc:
        return {"error": f"could not export HEAD: {exc}"}
    prev = STAGING / ".prev"
    if (STAGING / "app").exists():
        shutil.rmtree(prev, ignore_errors=True)
        prev.mkdir()
        shutil.move(str(STAGING / "app"), prev / "app")
    incoming.rename(STAGING / "app")
    ref = head()
    stamp = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {ref[:12]}"
    (STAGING / ".deployed").write_text(stamp + "\n")
    smoke = _healthy(stamp)
    return {"ok": bool(smoke.get("ok")), "ref": ref, "stamp": stamp,
            "files": changed_files(),
            # the URL a human opens, not the internal one the smoke test uses
            "staging_url": os.environ.get("STAGING_PUBLIC_URL", "http://localhost:8080/"),
            "smoke": smoke, "rollback": "previous tree kept in /srv/staging/.prev/app"}
