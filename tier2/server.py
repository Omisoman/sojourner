"""Tier-2 ops agent — A2A server on :9000.

Agent Card declares bearer security + skills build/validate/evaluate/deploy/
notify. The JWT `role` field is validated on every request; access rules from
new_horizons/shared/rules/rules.yaml. The agent itself is the shared
LangGraph harness (toolset "ops"). deploy: submitted → working →
input-required (human approval via approve.py) → completed. Everything lands
in the ONE audit chain new-horizons reads — an approved deploy as a
`deploy` event its Changes page lists.

The server imports the BAKED baseline of new-horizons (PYTHONPATH), not
the workspace tier-1's patch is replayed into: a patch can change the app, it
can never change the server or the gate that judges it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import a2a.types as T
from a2a.auth.user import UnauthenticatedUser, User
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.context import ServerCallContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandlerV2
from a2a.server.routes import create_jsonrpc_routes
from a2a.server.routes.agent_card_routes import create_agent_card_routes
from a2a.server.routes.common import ServerCallContextBuilder
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from starlette.applications import Starlette
from starlette.requests import Request

from new_horizons.shared.audit.audit import audit, record_deploy
from new_horizons.shared.harness.graph import ask, build_graph, register_toolset
from new_horizons.shared.patch.apply import apply_patch, reset_to_base
from new_horizons.shared.rules.rbac import AccessDenied, check, validate_token

import tools as ops_tools

SYSTEM_MD = (Path(__file__).parent / "agents/ops/SYSTEM.md").read_text()
MODEL = os.environ.get("LLM_MODEL_DEFAULT", "qwen3:8b")

# task_id -> phase-A results (in-memory, parity with InMemoryTaskStore)
_pending: dict[str, dict] = {}

PROJECT_DIR = Path(os.environ.get("PROJECT_DIR", "/workspace/project"))
BASE_REF = os.environ.get("SOJOURNER_BASE_REF", "sojourner-base")


class TokenUser(User):
    def __init__(self, fields: dict):
        self._fields = fields

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def user_name(self) -> str:
        return str(self._fields.get("sub", "unknown"))


class JwtContextBuilder(ServerCallContextBuilder):
    def build(self, request: Request) -> ServerCallContext:
        # headers must land in state: the SDK's version validator reads
        # A2A-Version from there (absent headers ⇒ treated as v0.3).
        state: dict = {"headers": dict(request.headers)}
        user: User = UnauthenticatedUser()
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            try:
                fields = validate_token(auth[7:])
                state["fields"] = fields
                user = TokenUser(fields)
            except Exception as exc:
                state["auth_error"] = str(exc)
        return ServerCallContext(state=state, user=user)


def _phase(graph, task_id: str, instruction: str) -> tuple[str, list[tuple[str, dict]]]:
    ops_tools.RESULTS.clear()
    out = ask(graph, instruction, MODEL, thread_id=f"task-{task_id}",
              toolset="ops")
    return out.get("answer", ""), list(ops_tools.RESULTS)


def _result_of(results, tool):
    for name, res in results:
        if name == tool:
            return res
    return None


async def _text_artifact(updater: TaskUpdater, name: str, payload: dict):
    await updater.add_artifact(
        [T.Part(text=json.dumps(payload, ensure_ascii=False)[:8000])], name=name)


class OpsExecutor(AgentExecutor):
    def __init__(self):
        register_toolset("ops", ops_tools.REGISTRY, ops_tools.run_tool,
                         system_md=SYSTEM_MD, retrieval=False,
                         actor="ops-agent", audits_calls=True)
        self.graph = build_graph(with_memory=True)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        await updater.cancel()

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        cc = context.call_context
        fields = (cc.state.get("fields") if cc else None) or {}
        role = fields.get("role", "")
        text = context.get_user_input().strip()
        audit("ops-agent", "a2a_message",
              {"task": context.task_id, "role": role or "unauthenticated",
               "text": text[:300]})

        prior = _pending.get(context.task_id)
        if prior is not None:
            await self._resume_after_approval(updater, context, role, text, prior)
            return

        # ---- new task: enqueue the initial Task object FIRST (the runtime
        # rejects status updates that precede it), then authenticate ----
        await event_queue.enqueue_event(T.Task(
            id=context.task_id, context_id=context.context_id,
            status=T.TaskStatus(state=T.TaskState.TASK_STATE_SUBMITTED),
            history=[context.message] if context.message else [],
        ))
        if not fields:
            await updater.reject(updater.new_agent_message(
                [T.Part(text="access error: missing/invalid bearer token "
                             f"({(cc.state.get('auth_error') if cc else None) or 'no token'})")]))
            audit("ops-agent", "access_denied", {"task": context.task_id,
                                                 "role": "unauthenticated"})
            return
        try:
            check(role, "a2a_delegate")
        except AccessDenied as exc:
            audit("ops-agent", "access_denied", {"task": context.task_id,
                                                 "role": role, "reason": str(exc)})
            await updater.reject(updater.new_agent_message(
                [T.Part(text=f"access error: {exc}")]))
            return

        try:
            req = json.loads(text)
        except json.JSONDecodeError:
            req = {"skill": "evaluate", "summary": text, "detail": ""}
        skill = req.get("skill", "evaluate")
        summary = req.get("summary", "(no summary)")
        detail = req.get("detail", "")

        audit("ops-agent", "state", {"task": context.task_id, "state": "submitted",
                                     "skill": skill, "summary": summary})
        await updater.start_work()
        audit("ops-agent", "state", {"task": context.task_id, "state": "working"})

        # Tier-1's work arrives as a patch, not a shared filesystem. Replay it
        # before any pipeline step so the PR, the build and the evaluation all
        # run on the code the developer actually wrote and committed.
        applied: dict = {"ok": True, "skipped": "no patch in request"}
        if req.get("patch"):
            applied = apply_patch(req["patch"], project_dir=PROJECT_DIR,
                                  base_ref=BASE_REF,
                                  sha_stated=req.get("patch_sha256", ""),
                                  branch=f"deploy/{context.task_id[:8]}")
            audit("ops-agent", "patch_applied",
                  {"task": context.task_id, "ok": applied.get("ok"),
                   "sha256": applied.get("sha256"), "head": applied.get("head"),
                   "files": applied.get("files"),
                   "commits": applied.get("commits"),
                   "error": applied.get("error")})
            if not applied["ok"]:
                await _text_artifact(updater, "patch-rejected", applied)
                await updater.failed(updater.new_agent_message(
                    [T.Part(text=f"patch did not apply: {applied.get('error')}")]))
                audit("ops-agent", "state", {"task": context.task_id,
                                             "state": "failed",
                                             "reason": "patch apply"})
                return
        else:
            # No patch means "ship the baseline" — ENFORCE it. The work tree
            # still holds the previous request's patch, so building it here
            # silently redeployed the last change under the word "baseline".
            applied = reset_to_base(project_dir=PROJECT_DIR, base_ref=BASE_REF)
            audit("ops-agent", "baseline_reset",
                  {"task": context.task_id, "ok": applied.get("ok"),
                   "head": applied.get("head"), "error": applied.get("error")})
            if not applied["ok"]:
                await updater.failed(updater.new_agent_message(
                    [T.Part(text=f"could not reset to {BASE_REF}: "
                                 f"{applied.get('error')}")]))
                audit("ops-agent", "state", {"task": context.task_id,
                                             "state": "failed",
                                             "reason": "baseline reset"})
                return

        if skill == "deploy":
            await self._deploy_phase_a(updater, context, summary, detail, applied)
            return

        single = {"build": "build_run", "evaluate": "evaluate_run",
                  "validate": "validate_run", "notify": "notify"}.get(skill)
        if not single:
            await updater.failed(updater.new_agent_message(
                [T.Part(text=f"unknown skill: {skill}")]))
            return
        args = f'{{"summary": {json.dumps(summary)}}}' if single == "evaluate_run" \
            else (f'{{"message": {json.dumps(summary)}}}' if single == "notify" else "{}")
        answer, results = _phase(
            self.graph, context.task_id,
            f"Run exactly one tool: {single} with args {args}. "
            f"Context: {summary}. {detail} Then reply final with the outcome.")
        await _text_artifact(updater, f"{skill}-result",
                       {"answer": answer, "results": dict(results)})
        ok = all("error" not in r for _, r in results) and results
        if ok:
            await updater.complete()
            audit("ops-agent", "state", {"task": context.task_id, "state": "completed"})
        else:
            await updater.failed(updater.new_agent_message(
                [T.Part(text=f"{skill} failed: {answer[:400]}")]))
            audit("ops-agent", "state", {"task": context.task_id, "state": "failed"})

    async def _deploy_phase_a(self, updater, context, summary, detail, applied=None):
        # Pipeline ORDER is a rule in code, not model discretion: the agent drives
        # each tool through the JSON protocol, the server sequences steps.
        steps = [
            ("gitea_pr", {"summary": summary, "detail": detail}),
            ("build_run", {}),
            ("validate_run", {}),
            ("evaluate_run", {"summary": summary}),
        ]
        answers, results = [], []
        for tool, args in steps:
            a, r = _phase(
                self.graph, context.task_id,
                f"Run exactly one tool: {tool} with args "
                f"{json.dumps(args, ensure_ascii=False)}. Then reply final "
                "with its outcome in one line.")
            answers.append(f"{tool}: {a[:200]}")
            results.extend(r)
            res = _result_of(r, tool)
            if res is None or "error" in res:
                break
        answer = " | ".join(answers)
        # The model's own narration stays evidence — in the chain, not in the
        # artifact an operator approves from.
        audit("ops-agent", "agent_narration",
              {"task": context.task_id, "phase": "a", "text": answer[:800]})
        ev = _result_of(results, "evaluate_run") or {}
        build = _result_of(results, "build_run") or {}
        val = _result_of(results, "validate_run") or {}
        pr = _result_of(results, "gitea_pr") or {}
        # Tool results only — no model prose. An 8B model narrating
        # "staging_url=…, smoke ok=true" during phase A invents outcomes that
        # have not happened yet, and this artifact is what an approval rests on.
        await _text_artifact(updater, "phase-a",
                       {"patch": applied or {}, "pr": pr,
                        "build": {"ok": build.get("ok"), "tests": (build.get("tests") or {}).get("summary"),
                                  "sync": (build.get("sync") or {}).get("ok")},
                        "validate": {k: (v.get("ok") if isinstance(v, dict) else v)
                                     for k, v in val.items()},
                        "evaluation": {k: ev.get(k) for k in ("verdict", "model", "pass_rate",
                                                              "threshold", "misses", "llm_review", "error")}})
        if ev.get("verdict") != "pass" or not build.get("ok") or not val.get("ok") or "error" in pr:
            await updater.failed(updater.new_agent_message(
                [T.Part(text=f"evaluation gate failed: verdict={ev.get('verdict')}, "
                             f"build_ok={build.get('ok')}, validate_ok={val.get('ok')}, "
                             f"pr={'ok' if 'error' not in pr else pr['error']}")]))
            audit("ops-agent", "state", {"task": context.task_id, "state": "failed",
                                         "reason": "phase-a gate"})
            return
        _pending[context.task_id] = {"summary": summary, "pr": pr, "evaluation": ev,
                                     "patch": applied or {}}
        await updater.requires_input(updater.new_agent_message(
            [T.Part(text="approval required for deploy_staging — run: "
                         f"docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/approve.py {context.task_id}")]))
        audit("ops-agent", "state", {"task": context.task_id,
                                     "state": "input-required",
                                     "gate": "deploy_staging approval"})

    async def _resume_after_approval(self, updater, context, role, text, prior):
        if text.lower() != "approve":
            await updater.requires_input(updater.new_agent_message(
                [T.Part(text=f"still awaiting approval (got: {text[:60]!r})")]))
            return
        try:
            check(role, "deploy_staging")
        except AccessDenied as exc:
            audit("ops-agent", "access_denied", {"task": context.task_id,
                                                 "role": role, "reason": str(exc)})
            await updater.requires_input(updater.new_agent_message(
                [T.Part(text=f"access error: {exc} — approval must come from an "
                             "authorized role")]))
            return
        fields = (context.call_context.state.get("fields") if context.call_context else None) or {}
        approver = f"{role}:{fields.get('sub', 'unknown')}"
        audit("ops-agent", "approval", {"task": context.task_id, "approved_by":
                                        approver, "gate": "deploy_staging"})
        await updater.start_work()
        summary = prior["summary"]
        steps = [
            ("deploy_staging", {}),
            ("notify", {"message": f"deployed to staging: {summary}"}),
        ]
        answers, results = [], []
        for tool, args in steps:
            a, r = _phase(
                self.graph, context.task_id,
                f"Run exactly one tool: {tool} with args "
                f"{json.dumps(args, ensure_ascii=False)}. Then reply final "
                "with its outcome in one line.")
            answers.append(f"{tool}: {a[:200]}")
            results.extend(r)
            res = _result_of(r, tool)
            if res is None or "error" in res:
                break
        answer = " | ".join(answers)
        audit("ops-agent", "agent_narration",
              {"task": context.task_id, "phase": "b", "text": answer[:800]})
        dep = _result_of(results, "deploy_staging") or {}
        ntf = _result_of(results, "notify") or {}
        recorded = None
        if dep.get("ok"):
            # The one event the app's Changes page reads. Written here, by
            # code, from what the server knows — never from model output.
            ev = prior.get("evaluation") or {}
            recorded = record_deploy(
                ref=dep.get("ref", ""), approved_by=approver, task_id=context.task_id,
                summary=summary, files=dep.get("files", []),
                evaluation={k: ev.get(k) for k in ("model", "pass_rate", "threshold", "verdict")},
                staging_url=dep.get("staging_url"))
        await _text_artifact(updater, "phase-b",
                       {"deploy": dep, "notify": ntf, "audit_event": recorded})
        del _pending[context.task_id]
        if dep.get("ok"):
            await updater.complete()
            audit("ops-agent", "state", {"task": context.task_id, "state": "completed"})
        else:
            await updater.failed(updater.new_agent_message(
                [T.Part(text=f"deploy failed: {json.dumps(dep, ensure_ascii=False)[:600]}")]))
            audit("ops-agent", "state", {"task": context.task_id, "state": "failed"})


def agent_card() -> T.AgentCard:
    skills = [
        T.AgentSkill(id=s, name=s, description=d, tags=["ops"])
        for s, d in [
            ("build", "uv lock check + frozen sync dry run + the hermetic test suite"),
            ("validate", "import contracts + knowledge-base dry run + business-truth tests"),
            ("evaluate", "bilingual question-set scorecard on the evaluation model (the gate)"),
            ("deploy", "Full pipeline: PR, build, validate, evaluate, HUMAN APPROVAL, "
                       "deploy to staging, audit event, notify"),
            ("notify", "Notify the ops channel (ntfy)"),
        ]
    ]
    return T.AgentCard(
        name="sojourner-tier2-ops",
        description="Sojourner tier-2 operations agent — a rules-gated delivery "
                    "pipeline for new-horizons behind A2A; deploys require human approval.",
        version="1.0.0",
        supported_interfaces=[T.AgentInterface(
            url=os.environ.get("A2A_PUBLIC_URL", "http://tier2:9000/"),
            protocol_binding="JSONRPC", protocol_version="1.0")],
        capabilities=T.AgentCapabilities(streaming=True),
        security_schemes={"bearer": T.SecurityScheme(
            http_auth_security_scheme=T.HTTPAuthSecurityScheme(
                scheme="bearer", bearer_format="JWT",
                description="HS256 JWT with a `role` field"))},
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=skills,
    )


def build_app() -> Starlette:
    # audit_log is new-horizons' table (its schema.sql): the one chain
    card = agent_card()
    handler = DefaultRequestHandlerV2(
        agent_executor=OpsExecutor(),
        # Single-org ops queue: tasks are shared across identities (the
        # requester and the human approver are DIFFERENT subjects by design);
        # who did what stays in the JWT fields + audit chain.
        task_store=InMemoryTaskStore(owner_resolver=lambda ctx: "sojourner-ops"),
        agent_card=card,
    )
    routes = create_agent_card_routes(card) + create_jsonrpc_routes(
        handler, rpc_url="/", context_builder=JwtContextBuilder())
    return Starlette(routes=routes)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(build_app(), host="0.0.0.0", port=9000)
