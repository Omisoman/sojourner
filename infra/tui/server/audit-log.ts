/**
 * audit-log — every tool execution (before/after) to JSONL on the audit
 * volume. Mirrors the Postgres hash chain used elsewhere; inside the
 * sandbox JSONL is the local ground truth. Loaded by absolute path from
 * each tier's opencode.json (tier-2's lands on its own audit volume).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";

const DIR = process.env["AUDIT_DIR"] ?? "/var/log/sojourner-audit";
const FILE = `${DIR}/opencode-tools.jsonl`;

function write(entry: Record<string, unknown>) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(
      FILE,
      JSON.stringify({ ts: new Date().toISOString(), tier: process.env["AGENT_TIER"] ?? "?", ...entry }) + "\n",
    );
  } catch {
    // audit must never break the tool loop; failures surface via ls on the volume
  }
}

export const AuditLog: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      write({ phase: "before", tool: input.tool, callId: input.callID,
              args: output.args });
    },
    "tool.execute.after": async (input, output) => {
      const title = (output as { title?: string }).title ?? "";
      write({ phase: "after", tool: input.tool, callId: input.callID, title });
    },
  };
};
