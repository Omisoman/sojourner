#!/bin/sh
# Staging: the DEPLOYED new-horizons as a second Streamlit, restarted on
# every deploy. Read-only rootfs; the deployed source (/srv/staging, written
# only by tier-2's deploy_staging) is mounted read-only here.
#
#   /srv/staging/app        the approved commit (git archive; the baked baseline until the first deploy)
#   /srv/staging/.deployed  the deploy stamp — a change restarts the app
#   /srv/staging-run/serving  the stamp now being served (deploy_staging waits on it)
#   /srv/farm/data          HORIZONS_DATA, seeded once from the image bake
set -eu

if [ ! -f /srv/farm/data/mock_meta.json ]; then
  mkdir -p /srv/farm/data
  cp -a /opt/sojourner/farm-data/. /srv/farm/data/
fi

stamp() { cat /srv/staging/.deployed 2>/dev/null || echo baseline; }

serve() {
  if [ -f /srv/staging/app/src/new_horizons/app/app.py ]; then src=/srv/staging/app/src
  else src=/opt/sojourner/horizons/src; fi
  served=$(stamp)
  # .streamlit/ and static/ sit next to app.py
  cd "$src/new_horizons/app"
  PYTHONPATH="$src" /opt/venv/bin/python -m streamlit run app.py \
    --server.headless true --server.address 0.0.0.0 --server.port 8501 \
    --server.fileWatcherType none --browser.gatherUsageStats false &
  pid=$!
  echo "$served" > /srv/staging-run/serving
  echo "staging: serving $src ($served), pid $pid"
}

serve
while sleep 2; do
  if [ "$(stamp)" != "$served" ] || ! kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    serve
  fi
done
