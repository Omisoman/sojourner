# Sojourner tier sandbox — "runs everywhere": debian:bookworm-slim + Bun +
# OpenCode (the TUI and its plugins) + Python 3.12/uv with new-horizons'
# locked environment baked in. Role comes from AGENT_TIER.
# Also works as a raw WSL distro: docker export <container> | wsl --import …
#
# Build contexts (compose passes all three):
#   .           this sojourner checkout
#   horizons       the sibling new-horizons checkout (its .dockerignore applies)
#   horizons-data  its generated data/ (make mock kb) — what staging and the gate read
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# tesseract: the app's document intake reads scans with it (staging serves
# that page; tier-2's validate renders it)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip xz-utils procps tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (NodeSource): OpenCode's tooling expects a node on PATH. No pnpm —
# the workspace project is Python now.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Bun (OpenCode's plugin runtime)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# OpenCode, pinned: plugin slot names (TuiHostSlotMap) are verified against
# this exact version and must match @opencode-ai/plugin in .opencode/package.json.
# The installer's own --version flag fetches that release asset; the assert
# fails the build if anything else lands on PATH.
ARG OPENCODE_VERSION=1.18.30
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" \
    && install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && rm -rf /root/.opencode \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}"

# Python 3.12 + uv, pinned. The interpreter lives under /opt/python so the
# venv's symlinks survive a read-only rootfs.
COPY --from=ghcr.io/astral-sh/uv:0.9.28 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1
RUN uv python install 3.12

# /workspace/catalog: the image-side skeleton of the shared catalog volume
# (Docker copies it, ownership included, into the empty volume on first
# mount). Its .gitignore must pre-exist: tier-1 mounts it read-only and
# OpenCode writes one into every config dir it loads. /srv/* are the staging
# volumes' mount points, pre-owned by the agent user for the same reason.
RUN useradd -m -u 1001 agent \
    && mkdir -p /workspace/catalog/commands /workspace/catalog/skills \
                /workspace/catalog/books /workspace/catalog/prompts /var/log/sojourner-audit \
                /srv/staging /srv/staging-run /srv/farm \
    && printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n' \
         > /workspace/catalog/.gitignore \
    && chown -R agent:agent /workspace /var/log/sojourner-audit /srv

# ---- one environment, the lock's exact pins ---------------------------------
# Sojourner's lock = new-horizons' pins + the A2A server's
# packages (tests/test_lock.py keeps them in step). Installed once into
# /opt/venv, BEFORE the checkout is copied: this layer depends on the two
# locks only, so an app change never reinstalls it. The wheel cache is a
# BuildKit cache mount — never part of the image. At runtime uv is offline,
# frozen and never syncs (ENV below): the sandbox cannot fetch a dependency,
# and a patch that needs one fails tier-2's build gate.
COPY --from=horizons pyproject.toml uv.lock /opt/sojourner/new-horizons/
COPY pyproject.toml uv.lock /opt/sojourner/env/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd /opt/sojourner/env \
    && UV_PROJECT_ENVIRONMENT=/opt/venv uv sync --frozen --all-groups --python 3.12 \
         --no-install-project --no-install-package new-horizons \
    && /opt/venv/bin/python -c "import streamlit, langgraph, a2a, pytest, importlinter"

# ---- the workspace project: new-horizons ------------------------------
# ONE baked base commit, tagged sojourner-base. Both tiers clone their
# /workspace/project from this same bake, so a patch tier-1 produces always
# applies onto exactly the tree tier-2 holds — no shared volume, no
# credentials in tier-1. Fixed author/committer dates keep the SHA identical
# across builds; gitea-init.sh pushes it as the in-stack origin's main.
COPY --from=horizons . /opt/sojourner/new-horizons
RUN ln -s new-horizons /opt/sojourner/horizons \
    && cd /opt/sojourner/horizons \
    && git init -q -b main \
    && git config user.name "Sojourner tier-1 agent" \
    && git config user.email "agent@sojourner.local" \
    && git add -A \
    && GIT_AUTHOR_DATE="2026-01-01T00:00:00+00:00" \
       GIT_COMMITTER_DATE="2026-01-01T00:00:00+00:00" \
       git commit -q -m "chore: new-horizons baseline" \
    && git tag sojourner-base \
    && git config --system --add safe.directory '*'

# The farm's generated data (DB-derived analytics, KB, sample scans): staging
# and the evaluation gate seed their writable data dirs from it.
COPY --from=horizons-data . /opt/sojourner/farm-data
RUN rm -rf /opt/sojourner/farm-data/_seed /opt/sojourner/farm-data/intake_cache \
           /opt/sojourner/farm-data/audit /opt/sojourner/farm-data/intents \
    && test -f /opt/sojourner/farm-data/mock_meta.json \
    && test -f /opt/sojourner/farm-data/kb/stats.json

# Tier config + the one TUI plugin (compose bind-mounts them live over these)
COPY tier1/.opencode /opt/sojourner/.opencode
COPY tier1/AGENTS.md /opt/sojourner/AGENTS.md
COPY tier1/core.json /opt/sojourner/core.json
COPY tier1/docs /opt/sojourner/docs
COPY infra/tui /opt/sojourner/tui

# Plugin dependencies baked at build time — no egress at runtime, and
# .opencode is read-only (OpenCode would otherwise write
# package.json/bun.lock/node_modules there on first load).
RUN cd /opt/sojourner/.opencode && bun install

# Compatibility symlinks: plural directory names here; singular aliases so
# either convention resolves.
RUN cd /opt/sojourner/.opencode \
    && for pair in agents:agent commands:command tools:tool \
                   skills:skill themes:theme; do \
         src="${pair%%:*}"; dst="${pair##*:}"; \
         [ -e "$dst" ] || ln -s "$src" "$dst"; \
       done \
    # root-owned stays root-owned, but the agent user must be able to READ
    # the bake to seed its workspace (host files may arrive 0600).
    && chmod -R a+rX /opt/sojourner

COPY infra/scripts/tier-entrypoint.sh infra/scripts/staging-run.sh /usr/local/bin/

USER agent
ENV HOME=/home/agent \
    PATH="/opt/venv/bin:$PATH" \
    VIRTUAL_ENV=/opt/venv \
    OPENCODE_CONFIG=/workspace/.opencode/opencode.json \
    # The workspace's code wins over nothing: the venv holds New Horizons'
    # dependencies, never horizons itself, so `uv run pytest` / `lint-imports`
    # import exactly what the agent edited.
    PYTHONPATH=/workspace/project/src \
    PYTHONDONTWRITEBYTECODE=1 \
    # uv in the sandbox: the baked environment, offline, frozen, never synced.
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_OFFLINE=1 \
    UV_FROZEN=1 \
    UV_NO_SYNC=1 \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_PYTHON_DOWNLOADS=never \
    # The sandbox is offline, so say so: at every start OpenCode npm-installs
    # @opencode-ai/plugin into the (tmpfs, always empty) ~/.config/opencode and
    # blocks bootstrap on it — npm's retry backoff made first paint take ~73 s.
    # Offline, it fails instantly (the baked .opencode copy is what loads).
    # The models.dev catalog fetch is skipped for the same reason (the model
    # list is local, in opencode.json).
    npm_config_offline=true \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    SOJOURNER_BASE_REF=sojourner-base
WORKDIR /workspace/project
ENTRYPOINT ["/usr/local/bin/tier-entrypoint.sh"]
CMD ["sleep", "infinity"]
