/**
 * Approvals & requests — the tier-2 A2A task queue, read over the same
 * channel the agents use (JSON-RPC ListTasks on tier-2, bearer JWT). How this
 * console authenticates is the record's a2a connection:
 *
 *   token_env   a bearer issued to it (tier-1, role tier1-dev): sees the
 *               requests it made
 *   secret_env  it signs its own JWT for `role` (tier-2, admin), approves via
 *               approve.py — the same human-approval CLI as the runbook, so
 *               the hash chain records the approval exactly as before — and
 *               rejects with CancelTask.
 */
import { A2A, A2A_URL, CAN, PATHS } from "./env.ts";

export type Task = {
  id: string;
  state: string; // submitted | working | input-required | completed | failed | canceled | rejected
  skill: string;
  summary: string;
  requestedBy: string;
  /** what tier-1 sent: its instructions and the committed work (git format-patch) */
  detail: string;
  commits: string[];
  files: string[];
  diffstat: string;
  patch: string;
  updated: string;
  message: string;
  artifacts: { name: string; text: string }[];
};

const b64url = (data: string | ArrayBuffer) =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

let signed: string | undefined;
async function signedToken(secretEnv: string, role: string): Promise<string> {
  if (signed) return signed;
  const secret = process.env[secretEnv] ?? "";
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ role, sub: "ops-console" }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`));
  signed = `${head}.${body}.${b64url(sig)}`;
  return signed;
}

async function bearer(): Promise<string> {
  if (A2A?.secret_env) return signedToken(A2A.secret_env, A2A.role ?? "admin");
  return (A2A?.token_env && process.env[A2A.token_env]) || "";
}

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(A2A_URL.replace(/\/?$/, "/"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0",
               Authorization: `Bearer ${await bearer()}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(4000),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "A2A error");
  return json.result as T;
}

export function normState(s: unknown): string {
  return String(s ?? "unknown").toLowerCase().replace(/^task_state_/, "").replace(/_/g, "-");
}

function texts(parts: any[] | undefined): string {
  return (parts ?? []).map((p) => p?.text ?? p?.content?.value ?? "").filter(Boolean).join(" ");
}

/** The tier-1 request: the JSON message that opened the task (later ones are
 *  status text and the approver's `approve`). */
function request(history: any[] | undefined): Record<string, any> {
  for (const m of history ?? []) {
    for (const p of m?.parts ?? []) {
      try {
        const req = JSON.parse(p?.text ?? p?.content?.value ?? "");
        if (req && typeof req === "object" && "skill" in req) return req;
      } catch {
        // status text, not the request
      }
    }
  }
  return {};
}

function toTask(t: any): Task {
  const req = request(t.history);
  return {
    id: String(t.id ?? ""),
    state: normState(t.status?.state),
    skill: req["skill"] ?? "?",
    summary: req["summary"] ?? "(no summary)",
    requestedBy: req["requested_by"] ?? "?",
    detail: String(req["detail"] ?? ""),
    commits: Array.isArray(req["commits"]) ? req["commits"].map(String) : [],
    files: Array.isArray(req["files"]) ? req["files"].map(String) : [],
    diffstat: String(req["diffstat"] ?? ""),
    patch: String(req["patch"] ?? ""),
    updated: String(t.status?.timestamp ?? ""),
    message: texts(t.status?.message?.parts),
    artifacts: (t.artifacts ?? []).map((a: any) => ({ name: String(a.name ?? "artifact"), text: texts(a.parts) })),
  };
}

export async function listTasks(): Promise<Task[]> {
  const r = await rpc<{ tasks?: any[] }>("ListTasks", { historyLength: 50, includeArtifacts: true, pageSize: 50 });
  return (r.tasks ?? []).map(toTask).reverse();
}

export const needsApproval = (t: Task) => t.state === "input-required";
export const finished = (t: Task) => ["completed", "failed", "canceled", "rejected"].includes(t.state);

/** Approver: approve through approve.py (admin JWT, audited like the runbook). */
export async function approve(taskId: string): Promise<{ ok: boolean; out: string }> {
  if (!CAN.approve) return { ok: false, out: "approvals happen in the tier-2 console" };
  try {
    const proc = Bun.spawn([PATHS.python, `${PATHS.tier2}/approve.py`, taskId], {
      cwd: PATHS.tier2, env: { ...process.env, A2A_TIER2_URL: A2A_URL }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { ok: (await proc.exited) === 0, out: (out + err).trim() };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}

/** Approver: reject = cancel the waiting task (the console records it in CH-2). */
export async function reject(taskId: string): Promise<{ ok: boolean; out: string }> {
  if (!CAN.approve) return { ok: false, out: "rejections happen in the tier-2 console" };
  try {
    const t = await rpc<any>("CancelTask", { id: taskId });
    return { ok: true, out: `state=${normState(t?.status?.state)}` };
  } catch (e) {
    return { ok: false, out: String((e as Error).message ?? e) };
  }
}
