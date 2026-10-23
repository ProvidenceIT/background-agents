/**
 * Memory tools for OpenCode, built from the generated cross-harness specs.
 *
 * Not a tool (no default tool() export). See `_contract-tool.js` for how a
 * spec becomes a tool; `harness/contract_tools.py` builds the Claude twins.
 */
import { contractToolArgs, contractToolDefinition, executeContractTool } from "./_contract-tool.js";
import { MEMORY_CONTRACT } from "./_memory-contract.js";

function memoryToolSpec(name) {
  const spec = MEMORY_CONTRACT.tools.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unknown memory tool: ${name}`);
  return spec;
}

export const memoryToolArgs = contractToolArgs;

export function executeMemoryTool(name, args) {
  return executeContractTool(memoryToolSpec(name), args);
}

export function memoryToolDefinition(z, name) {
  return contractToolDefinition(z, memoryToolSpec(name));
}
