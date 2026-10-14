/**
 * a2a_delegate — tier-1's ONLY path to tier-2 ops (A2A over tier-net).
 *
 * Creates a task on the tier-2 agent (http://tier2:9000), streams state
 * transitions, and returns the final state + artifacts. Bearer token comes
 * from env (role: tier1-dev); tier-1 holds no Gitea/deploy credentials.
 *
 * The work itself travels as a git patch: this tool runs `git format-patch`
 * over the commits the developer made since the baked base commit and sends
 * that text with the task. Tier-2 replays it onto its own copy of the same
 * base. So tier-1 still cannot reach the git server, holds no credentials and
 * shares no volume with tier-2 — what crosses the boundary is a signed,
 * hash-identified patch, and the hash lands in the audit chain.
 *
 * The patch is collected HERE, by code — never composed by the model.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";
// NOTE: no root "@a2a-js/sdk" import — OpenCode's plugin bundler trips over
// that package's export map; the /client subpath loads fine. Numeric enum
// values are stable in the v1 proto.
const ROLE_USER = 1;
const STATE_NAMES = ["unspecified", "submitted", "working", "completed",
  "failed", "canceled", "input-required", "rejected", "auth-required"];

const TIER2_URL = process.env["A2A_TIER2_URL"] ?? "http://tier2:9000";
const PROJECT = process.env["SOJOURNER_WRITE_ROOT"] ?? "/workspace/project";
const BASE_REF = process.env["SOJOURNER_BASE_REF"] ?? "sojourner-base";
/** Demo-scale guard: a patch this big means something unintended is in it. */
const MAX_PATCH_BYTES = 1_500_000;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: PROJECT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

type Work =
  | { ok: true; patch: string; sha256: string; diffstat: string; files: string[]; commits: string[] }
  | { ok: false; reason: string };

/** The commits made since the baked baseline — or why there is nothing to send. */
function collectWork(): Work {
  try {
    git("rev-parse", "--git-dir");
  } catch {
    return { ok: false, reason: `${PROJECT} is not a git repository` };
  }
  const dirty = git("status", "--porcelain");
  if (dirty) {
    const files = dirty.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n");
    return {
      ok: false,
      reason: "uncommitted changes — commit them first, the patch is built " +
        `from commits:\n${files}`,
    };
  }
  const count = Number(git("rev-list", "--count", `${BASE_REF}..HEAD`));
  if (!count) {
    return { ok: false, reason: `no commits since ${BASE_REF} — nothing to send` };
  }
  const patch = execFileSync("git", ["format-patch", `${BASE_REF}..HEAD`, "--stdout"], {
    cwd: PROJECT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (patch.length > MAX_PATCH_BYTES) {
    return { ok: false, reason: `patch is ${Math.round(patch.length / 1024)} KB — too large to delegate` };
  }
  return {
    ok: true,
    patch,
    sha256: createHash("sha256").update(patch).digest("hex"),
    diffstat: git("diff", "--stat", `${BASE_REF}..HEAD`),
    files: git("diff", "--name-only", `${BASE_REF}..HEAD`).split("\n").filter(Boolean),
    commits: git("log", "--format=%s", `${BASE_REF}..HEAD`).split("\n").filter(Boolean),
  };
}

export default tool({
  description:
    "Delegate a build/validate/evaluate/deploy task to the tier-2 ops agent over A2A. " +
    "Sends your committed work as a git patch (commit first — uncommitted " +
    "changes are refused). Deploys block on human approval (task reaches " +
    "input-required). Returns task id, state transitions and artifacts.",
  args: {
    skill: tool.schema
      .string()
      .describe("tier-2 skill: build | validate | evaluate | deploy | notify"),
    summary: tool.schema
      .string()
      .describe("one-line conventional-commit style summary of the change"),
    detail: tool.schema
      .string()
      .describe("extra instructions for the ops agent (empty string if none)"),
  },
  async execute(args) {
    const needsWork = ["build", "validate", "evaluate", "deploy"].includes(args.skill);
    const work = collectWork();
    if (needsWork && !work.ok) {
      return {
        title: "nothing delegated",
        output: `cannot delegate ${args.skill}: ${work.reason}`,
        metadata: { state: "not-sent" },
      };
    }

    const f = authFetch();
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: f })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: f }),
      }),
    );
    const client = await factory.createFromUrl(TIER2_URL);

    const text = JSON.stringify({
      skill: args.skill,
      summary: args.summary,
      detail: args.detail ?? "",
      requested_by: "tier1-dev",
      ...(work.ok
        ? {
            base: BASE_REF,
            patch: work.patch,
            patch_sha256: work.sha256,
            diffstat: work.diffstat,
            files: work.files,
            commits: work.commits,
          }
        : {}),
    });
    const transitions: string[] = [];
    const artifacts: string[] = [];
    let taskId = "";
    let finalState = "unknown";
    const sent = work.ok
      ? [`sent: ${work.commits.length} commit(s), ${work.files.length} file(s)`,
         `patch sha256: ${work.sha256.slice(0, 16)}…`, work.diffstat]
      : [];

    const push = (stateNum: number | undefined) => {
      if (stateNum === undefined || stateNum === null) return;
      const name = STATE_NAMES[stateNum] ?? String(stateNum);
      if (transitions[transitions.length - 1] !== name) transitions.push(name);
      finalState = name;
    };

    const stream = client.sendMessageStream({
      message: {
        messageId: crypto.randomUUID(),
        role: ROLE_USER,
        parts: [{ content: { $case: "text", value: text } }],
      },
    } as never);

    type Ev = { payload?: { $case?: string; value?: any } };
    for await (const event of stream as AsyncGenerator<Ev>) {
      const c = event?.payload?.$case;
      const v = event?.payload?.value;
      if (!c || !v) continue;
      if (c === "task") {
        taskId = v.id ?? taskId;
        push(v.status?.state);
      } else if (c === "statusUpdate") {
        taskId = v.taskId ?? taskId;
        push(v.status?.state);
      } else if (c === "artifactUpdate") {
        const parts = v.artifact?.parts ?? [];
        const texts = parts
          .map((p: any) => p?.content?.$case === "text" ? p.content.value : "")
          .filter(Boolean);
        artifacts.push(`${v.artifact?.name ?? "artifact"}: ${texts.join(" ").slice(0, 1500)}`);
      }
      if (finalState === "input-required") {
        return {
          title: `A2A task ${taskId.slice(0, 8)} — approval required`,
          output: [
            ...sent,
            `task_id: ${taskId}`,
            "state: input-required",
            `transitions: ${transitions.join(" -> ")}`,
            `next: approval required — the operator approves in the tier-2 console, or run: docker exec sojourner-tier2 /opt/venv/bin/python /opt/sojourner/tier2/approve.py ${taskId}`,
            ...artifacts.map((a) => `artifact ${a}`),
          ].join("\n"),
          metadata: { task_id: taskId, state: "input-required", transitions },
        };
      }
    }
    return {
      title: `A2A task ${taskId.slice(0, 8)} — ${finalState}`,
      output: [
        ...sent,
        `task_id: ${taskId}`,
        `state: ${finalState}`,
        `transitions: ${transitions.join(" -> ")}`,
        ...artifacts.map((a) => `artifact ${a}`),
      ].join("\n"),
      metadata: { task_id: taskId, state: finalState, transitions },
    };
  },
});

function authFetch(): typeof fetch {
  const token = process.env["A2A_BEARER_TIER1"] ?? "";
  return createAuthenticatingFetchWithRetry(fetch, {
    headers: async () => ({ Authorization: `Bearer ${token}` }),
    shouldRetryWithHeaders: async () => undefined,
  });
}
