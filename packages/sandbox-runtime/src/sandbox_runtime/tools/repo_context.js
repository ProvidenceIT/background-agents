import { tool } from "@opencode-ai/plugin";
import { sessionToolDefinition } from "./_session-tool.js";

export default tool(sessionToolDefinition(tool.schema, "repo_context"));
