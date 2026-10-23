/**
 * Session tools for OpenCode (`notify_user`, `motion_*`), built from the
 * generated cross-harness specs.
 *
 * Not a tool (no default tool() export). One file per tool imports this
 * factory; `opencode_server.py` installs a tool file only when the control
 * plane enabled its gate, so a session without the gate never sees the tool.
 */
import { contractToolDefinition } from "./_contract-tool.js";
import { SESSION_TOOLS_CONTRACT } from "./_session-tools-contract.js";

export function sessionToolSpec(name) {
  const spec = SESSION_TOOLS_CONTRACT.tools.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unknown session tool: ${name}`);
  return spec;
}

/** The `tool()` input for one session tool; `z` is the plugin's `tool.schema`. */
export function sessionToolDefinition(z, name) {
  return contractToolDefinition(z, sessionToolSpec(name));
}
