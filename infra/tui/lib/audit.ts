/**
 * The tier's audit channel from the console side.
 *
 *   CH-1  tier-1: JSONL on its audit volume (the tool log the audit-log
 *         plugin writes; console actions go to sojourner-ui.jsonl beside it)
 *   CH-2  tier-2: the Postgres hash chain (new_horizons/shared/audit/audit.py) and its
 *         JSONL mirror — console actions are appended through the same
 *         audit() so they are chained, verifiable and tamper-evident.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { AGENT, AUDIT, CAN, PATHS, TIER } from "./env.ts";

export type AuditLine = { ts: string; who: string; what: string; detail: string; hash?: string };

async function python(code: string, args: string[] = []): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn([PATHS.python, "-c", code, ...args], {
      cwd: PATHS.shared, env: process.env, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code_ = await proc.exited;
    return { ok: code_ === 0, out: (code_ === 0 ? out : err || out).trim() };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}

const AUDIT_PY = "import json,sys; " +
  "from new_horizons.shared.audit.audit import audit; print(audit(sys.argv[1], sys.argv[2], json.loads(sys.argv[3])))";

/** Record a console action (catalog publish, approval, prompt saved …). */
export async function record(event: string, payload: Record<string, unknown>): Promise<string | undefined> {
  const body = { ...payload, agent: AGENT.id };
  if (CAN.verifyChain) {
    const r = await python(AUDIT_PY, ["ops-console", event, JSON.stringify(body)]);
    if (r.ok) return r.out.slice(0, 12);
  }
  try {
    mkdirSync(PATHS.auditDir, { recursive: true });
    appendFileSync(`${PATHS.auditDir}/sojourner-ui.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), tier: TIER, event, ...body }) + "\n");
  } catch {
    // audit never breaks the console; a missing volume shows up in `History`
  }
  return undefined;
}

function summarize(o: Record<string, any>): AuditLine {
  if (CAN.verifyChain) {
    const p = o["payload"] ?? {};
    const bits = ["task", "state", "tool", "gate", "approved_by", "kind", "name", "model", "role"]
      .filter((k) => p[k] !== undefined).map((k) => `${k}=${String(p[k]).slice(0, 36)}`);
    return { ts: o["ts"] ?? "", who: o["actor"] ?? "?", what: o["event_type"] ?? "?",
             detail: bits.join(" "), hash: String(o["hash"] ?? "").slice(0, 10) };
  }
  const detail = o["title"] || (o["args"] ? JSON.stringify(o["args"]).slice(0, 60) : "") || o["callId"] || "";
  return { ts: o["ts"] ?? "", who: `tier-${o["tier"] ?? "?"}`, what: `${o["tool"] ?? o["event"] ?? "?"} ${o["phase"] ?? ""}`.trim(),
           detail: String(detail) };
}

/** Last `n` events of this tier's channel, newest first. */
export function tail(n = 40): AuditLine[] {
  let text = "";
  try {
    text = readFileSync(AUDIT.file, "utf8");
  } catch {
    return [];
  }
  const lines = text.trimEnd().split("\n").slice(-n).reverse();
  const out: AuditLine[] = [];
  for (const line of lines) {
    try {
      out.push(summarize(JSON.parse(line)));
    } catch {
      // a torn last line while the writer appends — skip it
    }
  }
  return out;
}

const VERIFY_PY = "import json; " +
  "from new_horizons.shared.audit.audit import verify_chain; print(json.dumps(verify_chain()))";

/** CH-2 only: recompute the whole hash chain. */
export async function verifyChain(): Promise<{ ok: boolean; rows?: number; reason?: string }> {
  const r = await python(VERIFY_PY);
  if (!r.ok) return { ok: false, reason: r.out.split("\n").pop() };
  try {
    const v = JSON.parse(r.out.split("\n").pop() ?? "{}");
    return { ok: !!v.ok, rows: v.rows, reason: v.reason };
  } catch {
    return { ok: false, reason: r.out.slice(0, 200) };
  }
}

export { python };
