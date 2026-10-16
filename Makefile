# sojourner — the governed tier stack around new-horizons.
# Never run new-horizons' `make demo1` and this stack together (16 GB
# budget). Postgres alone is fine: both repos use New Horizons' container and volume.

SHELL := /bin/bash
UV    ?= uv
HORIZONS ?= ../new-horizons
# compose resolves .env from the COMPOSE FILE's directory, not the repo root, so
# without this a lane switch rewrites .env and the tiers keep dialling host Ollama.
COMPOSE_ENV := $(if $(wildcard .env),--env-file .env,)
COMPOSE := docker compose $(COMPOSE_ENV) -f infra/compose/docker-compose.yml
CLIENT_WORDS := j[i]co|j[e]rusal[e]m|القد[س]|ins[u]r|cl[a]im|pol[i]cy|gar[a]ge|adjust[e]r|IB[A]N|tar[i]ff|J[O]D

.PHONY: demo2-build demo2-up demo2-down demo2-reset demo2-attach demo2-ops demo2-verify deepseek-tools \
        test lint core brand books client-free llm-target

## Build the tier image (tier-2 and staging derive FROM it). The image bakes the
## sibling new-horizons checkout AND its generated data/ — make mock kb there first.
## (bun install keeps the ro-mounted .opencode self-contained — no egress at runtime)
demo2-build:
	@test -f $(HORIZONS)/data/mock_meta.json -a -f $(HORIZONS)/data/kb/stats.json || \
	  { echo "no farm data in $(HORIZONS)/data — run: make -C $(HORIZONS) db-up mock kb"; exit 1; }
	cd tier1/.opencode && bun install
	cd tier2/.opencode && bun install
	$(COMPOSE) build tier1     # tier2 + staging derive FROM sojourner-tier:latest
	$(COMPOSE) build tier2

## Optional: deepseek under the qwen3 tool template (reasoning-only otherwise)
deepseek-tools:
	ollama create deepseek-r1-tools:8b -f infra/scripts/deepseek-tools.Modelfile

## New Horizons' Postgres first (it owns the container, the volume and the internal
## horizons-db network the tiers join), then the stack, then Gitea's baseline.
demo2-up:
	$(MAKE) -C $(HORIZONS) db-up
	$(COMPOSE) up -d
	@sh infra/scripts/gitea-init.sh
	@echo "make demo2-attach (tier-1 developer)  |  make demo2-ops (tier-2 operator)"
	@echo "staging (the deployed app): http://localhost:$${STAGING_PORT:-8080}"

demo2-down:
	-tmux kill-session -t sojourner 2>/dev/null
	-tmux kill-session -t sojourner-ops 2>/dev/null
	$(COMPOSE) down

## Re-seed the tier workspaces from a freshly built image. tier-entrypoint.sh
## marks a seeded workspace done, so a rebuilt image does NOT reach an existing
## volume — after `make demo2-build`, reset or you demo the old code. Keeps the
## Gitea repo and the audit chain (New Horizons' Postgres); clears the workspaces and
## staging (source, run state, data).
demo2-reset:
	-$(COMPOSE) down
	-docker volume rm $$(docker volume ls -q | grep -E '^sojourner_(tier1-workspace|tier2-workspace|staging-src|staging-run|staging-farm)$$')
	@echo "workspaces + staging cleared — run make demo2-up to re-seed from the image"

## The walls and the wiring, checked against the running stack (egress three ways,
## opencode config, SANDBOX-OK, the offline suite in tier-1, A2A hello).
demo2-verify:
	bash infra/scripts/verify-walls.sh

## The Sojourner TUI + a hidden shell (tmux; ctrl-b t shows/hides it) — tier-1 developer sandbox…
demo2-attach:
	bash infra/scripts/tier-attach.sh 1

## …and the tier-2 operator console (approvals, the catalog it publishes, audit channel 2).
demo2-ops:
	bash infra/scripts/tier-attach.sh 2

## Unit tests (records, patch channel, tier-2 tools, compose walls, TUI, brand).
## Tests marked `stack` need make demo2-up; `model` needs Ollama.
test:
	$(UV) run pytest -q

## Every generated file matches its generator, and the client-free grep is zero.
lint:
	$(UV) run python scripts/core-compile.py --check
	$(UV) run python scripts/brand-sync.py --check
	$(UV) run python scripts/book-covers.py --check
	@$(MAKE) --no-print-directory client-free

## Compile each tier's core.json (the record) into its .opencode/opencode.json.
## The record is the agent; opencode.json is output (tests/test_core.py diffs it).
core:
	$(UV) run python scripts/core-compile.py

## TUI brand: OpenCode theme (both tiers) + the TUI's tokens, mark and chips,
## sampled from new-horizons' generated AC marks — never traced.
brand:
	$(UV) run python scripts/brand-sync.py

## Braille covers for the Books shelf: tier1/docs/books/covers/<name>.json
books:
	$(UV) run python scripts/book-covers.py

client-free:
	@! grep -rIinE "$(CLIENT_WORDS)" --exclude-dir=node_modules --exclude-dir=.venv \
	  --exclude-dir=data --exclude-dir=dist --exclude-dir=.git --exclude=LICENSE . \
	  && echo "client-free: ok"

## Point every surface at one inference lane: local | rented | claude | hybrid —
## New Horizons' script rewrites its .env and this repo's tier + staging env files.
##   make llm-target MODE=rented URL=http://gpu-box:8000/v1 MODEL=qwen3-coder:30b
llm-target:
	cd $(HORIZONS) && bash scripts/llm-target.sh $(MODE) $(URL) $(MODEL)
