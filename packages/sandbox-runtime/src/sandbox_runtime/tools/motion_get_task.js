import { tool } from "@opencode-ai/plugin";
import { sessionToolDefinition } from "./_session-tool.js";

export default tool(sessionToolDefinition(tool.schema, "motion_get_task"));
