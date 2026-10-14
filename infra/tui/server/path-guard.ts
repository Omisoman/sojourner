/**
 * path-guard — belt-and-braces enforcement on top of opencode.json
 * permissions: file mutations outside the tier's write root are refused,
 * and refusals are audit-logged. Tier-1 writes only /workspace/project;
 * tier-2 only its catalog (SOJOURNER_WRITE_ROOT, set per tier in compose).
 * Loaded by absolute path from each tier's opencode.json.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

const ALLOWED = process.env["SOJOURNER_WRITE_ROOT"] ?? "/workspace/project";
const MUTATING = new Set(["write", "edit", "patch", "multiedit"]);
const DIR = process.env["AUDIT_DIR"] ?? "/var/log/sojourner-audit";

function refuse(tool: string, path: string): never {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(`${DIR}/path-guard.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), tool, path,
                       action: "refused" }) + "\n");
  } catch { /* logged best-effort */ }
  throw new Error(`path-guard: ${tool} outside ${ALLOWED} is forbidden (${path})`);
}

export const PathGuard: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (!MUTATING.has(input.tool)) return;
      const p = (output.args as { filePath?: string; path?: string }) ?? {};
      const target = p.filePath ?? p.path ?? "";
      if (!target) return;
      // Tools pass EITHER an absolute path or one relative to the agent's cwd.
      // Comparing the raw string refused every relative write — the agent then
      // retries forever against a wall it cannot see. Resolve first; `resolve`
      // also collapses any `..`, so traversal still lands outside and is caught.
      const abs = isAbsolute(target) ? target : resolve(process.cwd(), target);
      if (!abs.startsWith(ALLOWED + "/") && abs !== ALLOWED) {
        refuse(input.tool, `${target} -> ${abs}`);
      }
      // `.opencode` is mounted INSIDE the write root so OpenCode can discover
      // this tier's agents and skills. It is governance, not workspace — the
      // read-only mount already refuses, but deny it here too so the attempt
      // is audited rather than surfacing as a confusing filesystem error.
      if (abs.startsWith(`${ALLOWED}/.opencode`)) {
        refuse(input.tool, `${target} -> ${abs} (governance, read-only)`);
      }
    },
  };
};
