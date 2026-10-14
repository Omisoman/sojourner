#!/bin/sh
# Seeds the writable /workspace volume from the image bake on first boot.
# Runs as the unprivileged `agent` user; read-only rootfs; no egress.
# A marker file makes each seed atomic-ish: an interrupted copy re-runs in
# full on the next boot (WORKDIR also pre-creates an empty /workspace/project).
set -eu

MARKS=/workspace/.seed-marks
mkdir -p "$MARKS"

seed() {
  src="$1"; dst="$2"; mark="$MARKS/$(basename "$dst").done"
  [ -e "$src" ] || return 0
  [ -f "$mark" ] && return 0
  if [ -e "$dst" ] && [ ! -w "$dst" ]; then
    return 0                      # read-only bind mount owns this path
  fi
  # A read-only bind mount may live INSIDE $dst: tier-1 mounts .opencode into
  # the worktree, because OpenCode only walks up to the git worktree root to
  # find agents and skills. `rm` cannot remove that mount, and under `set -e`
  # the failure killed the entrypoint — the container restart-looped and every
  # exec failed. So clear what can be cleared, then lay the bake over the top.
  if [ -d "$src" ]; then
    rm -rf "$dst" 2>/dev/null || true
    mkdir -p "$dst"
    cp -a "$src/." "$dst/"
  else
    rm -f "$dst" 2>/dev/null || true
    cp -a "$src" "$dst"
  fi
  touch "$mark"
}

# The workspace project is a CLONE of the baked new-horizons baseline
# (tag sojourner-base), so `git format-patch sojourner-base..HEAD` in tier-1
# and `git am` in tier-2 run against the very same commit.
clone_project() {
  mark="$MARKS/project.done"
  [ -f "$mark" ] && return 0
  dst=/workspace/project
  # clear what can be cleared — the ro .opencode mount inside stays
  find "$dst" -mindepth 1 -maxdepth 1 ! -name .opencode -exec rm -rf {} + 2>/dev/null || true
  tmp=$(mktemp -d /workspace/.clone.XXXXXX)
  git clone -q /opt/sojourner/horizons "$tmp"
  cp -a "$tmp/." "$dst/"
  rm -rf "$tmp"
  git -C "$dst" config user.name "Sojourner tier-1 agent"
  git -C "$dst" config user.email "agent@sojourner.local"
  # the read-only config mount is not the project's: keep it out of `git status`
  printf '.opencode/\n' >> "$dst/.git/info/exclude"
  touch "$mark"
}

clone_project
seed /opt/sojourner/docs       /workspace/docs      # no-op when bind-mounted ro
seed /opt/sojourner/.opencode  /workspace/.opencode # no-op when bind-mounted ro
seed /opt/sojourner/AGENTS.md  /workspace/AGENTS.md # no-op when bind-mounted ro
# tier-2's data home (HORIZONS_DATA): the farm's generated analytics + KB, which
# the evaluation gate's scorecard and validate's truth tests read
[ "${AGENT_TIER:-1}" = 2 ] && seed /opt/sojourner/farm-data /workspace/farm/data

exec "$@"
