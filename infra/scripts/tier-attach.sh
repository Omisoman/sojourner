#!/usr/bin/env bash
# A tier's TUI + a shell side by side — the devcontainer pairing without VS Code.
# Left: OpenCode with the Sojourner TUI. Right: sh in the tier's working dir.
#
#   make demo2-attach                             # tier-1 developer sandbox
#   make demo2-ops                                # tier-2 operator console
#   bash infra/scripts/tier-attach.sh 2 --detach  # create only (headless checks)
#
# The shell starts hidden: the TUI pane opens zoomed to full width, and
# ctrl-b t toggles between them (shows the shell and focuses it, or hides it
# and goes back to the TUI).
#
# Mouse is on so the PROJECT · MODEL · SETTINGS tabs and ALERTS are clickable
# (hold shift/option to select text with the terminal instead).
set -euo pipefail
cd "$(dirname "$0")/../.."

TIER="${1:-1}"
case "$TIER" in
  1) CONTAINER=sojourner-tier1; DIR=/workspace/project; SESSION=sojourner;     LABEL="Sojourner tier-1 · developer" ;;
  2) CONTAINER=sojourner-tier2; DIR=/workspace;         SESSION=sojourner-ops; LABEL="Sojourner tier-2 · operator" ;;
  *) echo "usage: $0 [1|2] [--detach]" >&2; exit 2 ;;
esac
command -v tmux >/dev/null || { echo "need tmux: brew install tmux" >&2; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] ||
  { echo "$CONTAINER is not running — make demo2-up first" >&2; exit 1; }

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tok() { grep -o "\"$1\": *\"#[0-9a-fA-F]*\"" infra/tui/brand/tokens.json | grep -o '#[0-9a-fA-F]*'; }
  # attaching resizes to the real terminal; without a TTY (--detach, CI) tput
  # would report 80x24 and squeeze the TUI pane, so default to a roomy size
  if [ -t 1 ]; then cols=$(tput cols); lines=$(tput lines); else cols=200; lines=50; fi
  # a killed tmux session leaves its `docker exec` opencode running in the container
  docker exec "$CONTAINER" pkill -x opencode 2>/dev/null || true
  # -w: tier-2's image WORKDIR is the A2A server; the console works from /workspace
  tmux new-session -d -s "$SESSION" -x "$cols" -y "$lines" "docker exec -it -w $DIR $CONTAINER opencode"
  tmux split-window -h -t "$SESSION" -l 40% "docker exec -it -w $DIR $CONTAINER sh"
  tmux set -t "$SESSION" mouse on
  tmux set -t "$SESSION" status-style "bg=$(tok bgElement),fg=$(tok text)"
  tmux set -t "$SESSION" status-left-length 60
  tmux set -t "$SESSION" status-left "#[fg=$(tok accent),bold] $LABEL · $DIR "
  tmux set -t "$SESSION" status-right ""
  tmux set -t "$SESSION" pane-active-border-style "fg=$(tok accent)"
  tmux select-pane -t "$SESSION:0.0"
  tmux resize-pane -Z -t "$SESSION:0.0"
fi
# server-wide, so re-bound on every attach; pane 0 = TUI, pane 1 = shell
tmux bind-key t if-shell -F '#{window_zoomed_flag}' \
  'resize-pane -Z ; select-pane -t :.1' \
  'select-pane -t :.0 ; resize-pane -Z -t :.0'


[ "${2:-}" = "--detach" ] && { echo "tmux session '$SESSION' ready — tmux attach -t $SESSION"; exit 0; }
if [ -n "${TMUX:-}" ]; then exec tmux switch-client -t "$SESSION"; fi
exec tmux attach -t "$SESSION"
