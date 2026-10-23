/**
 * OpenCode tools built from a generated cross-harness contract.
 *
 * Not a tool (no default tool() export). The memory tools and the session
 * tools are both specs generated from TypeScript; `harness/contract_tools.py`
 * builds the Claude twins from the same specs with the same requests and error
 * text (each harness reports errors its own way). Arguments are forwarded
 * verbatim after dropping keys the input schema does not declare; the control
 * plane derives identity, scope and authority from the session.
 */
import { bridgeFetch, extractError } from "./_bridge-client.js";

/** Convert one JSON Schema property (the subset the specs use) to a zod schema. */
function toArg(z, key, property, required) {
  let arg;
  switch (property.type) {
    case "string":
      arg = property.enum ? z.enum(property.enum) : z.string();
      if (property.minLength !== undefined) arg = arg.min(property.minLength);
      if (property.maxLength !== undefined) arg = arg.max(property.maxLength);
      break;
    case "integer":
      arg = z.number().int();
      if (property.minimum !== undefined) arg = arg.min(property.minimum);
      if (property.maximum !== undefined) arg = arg.max(property.maximum);
      break;
    default:
      throw new Error(`Unsupported contract tool argument type for ${key}: ${property.type}`);
  }
  if (property.default !== undefined) arg = arg.default(property.default);
  // optional() after default() keeps a defaulted field out of the provider-facing `required`.
  if (!required) arg = arg.optional();
  if (property.description !== undefined) arg = arg.describe(property.description);
  return arg;
}

/** OpenCode `args` for a tool's input schema; `z` is the plugin's `tool.schema`. */
export function contractToolArgs(z, inputSchema) {
  const required = new Set(inputSchema.required ?? []);
  return Object.fromEntries(
    Object.entries(inputSchema.properties).map(([key, property]) => [
      key,
      toArg(z, key, property, required.has(key)),
    ])
  );
}

/** Call a contract endpoint through the session-scoped bridge, reporting failures as text. */
export async function executeContractTool(spec, args) {
  const name = spec.name;
  const body = Object.fromEntries(
    Object.keys(spec.inputSchema.properties)
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]])
  );
  const path = spec.path.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = body[key] ?? "";
    delete body[key];
    return encodeURIComponent(String(value));
  });
  let response;
  try {
    response = await bridgeFetch(
      path,
      spec.method === "GET"
        ? { method: "GET" }
        : { method: spec.method, body: JSON.stringify(body) }
    );
  } catch {
    // Transport details can name internal hosts; the agent only needs the outcome.
    return `${name} failed (unavailable)`;
  }
  if (!response.ok) return `${name} failed (${response.status}): ${await extractError(response)}`;
  return response.text();
}

/** The `tool()` input for one spec: its description and args, the generic executor. */
export function contractToolDefinition(z, spec) {
  return {
    description: spec.description,
    args: contractToolArgs(z, spec.inputSchema),
    execute: (args) => executeContractTool(spec, args),
  };
}
