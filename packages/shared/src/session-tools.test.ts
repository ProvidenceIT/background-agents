import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSessionToolsSandboxContract,
  formatSessionToolGates,
  formatSessionToolsContractFiles,
  notifyUserInputSchema,
  SESSION_TOOL_GATES,
  SESSION_TOOLS_CONTRACT_FILES,
} from "./session-tools";

const root = new URL("../../../", import.meta.url);

describe("session tool specs", () => {
  it.each(Object.entries(SESSION_TOOLS_CONTRACT_FILES))(
    "keeps the generated %s artifact in sync (run `npm run generate:session-tools-contract -w @open-inspect/shared`)",
    (kind, path) => {
      const expected =
        formatSessionToolsContractFiles()[kind as keyof typeof SESSION_TOOLS_CONTRACT_FILES];
      const file = new URL(path, root);
      if (process.env.UPDATE_SESSION_TOOLS_CONTRACT === "1") writeFileSync(file, expected);
      expect(readFileSync(file, "utf8")).toBe(expected);
    }
  );

  it("gives every tool a known gate and a strict input", () => {
    const { tools } = buildSessionToolsSandboxContract();
    expect(tools.map((tool) => [tool.name, tool.gate])).toEqual([
      ["notify_user", "notify"],
      ["motion_get_task", "motion_read"],
      ["motion_add_note", "motion_write"],
    ]);
    for (const tool of tools) {
      expect(SESSION_TOOL_GATES).toContain(tool.gate);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("lets the agent say what and how urgent, never to whom", () => {
    const notify = buildSessionToolsSandboxContract().tools.find(
      (tool) => tool.name === "notify_user"
    )!;
    expect(notify.inputSchema).toMatchObject({
      required: ["message"],
      properties: {
        message: { maxLength: 500 },
        urgency: { enum: ["normal", "high"], default: "normal" },
      },
    });
    expect(
      notifyUserInputSchema.safeParse({ message: "PR ready", recipient: "someone" }).success
    ).toBe(false);
  });

  it("formats the enabled gates for the sandbox environment", () => {
    expect(formatSessionToolGates(["motion_write", "notify", "notify"])).toBe(
      "motion_write,notify"
    );
    expect(formatSessionToolGates([])).toBe("");
  });
});
