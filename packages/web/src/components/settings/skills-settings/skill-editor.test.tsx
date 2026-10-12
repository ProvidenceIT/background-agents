// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@open-inspect/shared/types/skills";
import { SkillEditor } from "./skill-editor";

expect.extend(matchers);

const { createSkillMock, previewSkillMock, replaceSkillMock, toastErrorMock } = vi.hoisted(() => ({
  createSkillMock: vi.fn(),
  previewSkillMock: vi.fn(),
  replaceSkillMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  createSkill: createSkillMock,
  previewSkill: previewSkillMock,
  replaceSkillContentAndAssignments: replaceSkillMock,
}));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false, error: undefined }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [], loading: false, error: undefined }),
}));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock, success: vi.fn() } }));
vi.mock("./skill-assignments", () => ({ SkillAssignments: () => null }));
vi.mock("./skill-reimport", () => ({ SkillReimport: () => null }));

const frontmatter = {
  "disable-model-invocation": true,
  "argument-hint": "[branch]",
  paths: ["src/**"],
};

const skill: Skill = {
  id: "skill_1",
  name: "open-pr",
  description: "Opens pull requests",
  enabled: true,
  currentRevisionId: "rev_1",
  revisionNumber: 1,
  revisionSha256: "a".repeat(64),
  revisionCreatedBy: "user_1",
  creatorDisplayName: null,
  lastEditorDisplayName: null,
  revisionAuthorDisplayName: null,
  assignments: [{ id: "assign_1", type: "global" }],
  source: null,
  createdBy: "user_1",
  updatedBy: "user_1",
  createdAt: 1,
  updatedAt: 1,
  body: "# Open a PR\n",
  license: null,
  compatibility: null,
  metadata: { "credits.author": "Matt" },
  frontmatter,
  files: [],
};

beforeEach(() => {
  createSkillMock.mockReset();
  previewSkillMock.mockReset();
  replaceSkillMock.mockReset().mockResolvedValue({ ...skill, revisionNumber: 2 });
  toastErrorMock.mockReset();
});

afterEach(cleanup);

function renderEditor() {
  const onSaved = vi.fn();
  render(<SkillEditor skill={skill} creating={false} onSaved={onSaved} onCancel={vi.fn()} />);
  return { onSaved };
}

describe("SkillEditor frontmatter", () => {
  it("shows stored frontmatter and saves it back unchanged", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderEditor();

    expect(
      JSON.parse((screen.getByLabelText("Frontmatter (JSON)") as HTMLTextAreaElement).value)
    ).toEqual(frontmatter);

    await user.click(screen.getByRole("button", { name: "Save new revision" }));

    expect(replaceSkillMock).toHaveBeenCalledWith("skill_1", "rev_1", {
      content: expect.objectContaining({ frontmatter, metadata: { "credits.author": "Matt" } }),
      assignments: [{ type: "global" }],
    });
    expect(onSaved).toHaveBeenCalledWith("skill_1");
  });

  it("tracks frontmatter edits as unsaved changes and sends them on validate and save", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    previewSkillMock.mockResolvedValue({
      skillMarkdown: "---\nname: open-pr\n---\n",
      revisionSha256: "b".repeat(64),
      totalBytes: 10,
    });
    renderEditor();

    fireEvent.change(screen.getByLabelText("Frontmatter (JSON)"), {
      target: { value: '{"disable-model-invocation": false}' },
    });
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved skill changes?");

    await user.click(screen.getByRole("button", { name: "Validate" }));
    expect(previewSkillMock).toHaveBeenCalledWith(
      "open-pr",
      expect.objectContaining({ frontmatter: { "disable-model-invocation": false } })
    );

    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(replaceSkillMock).toHaveBeenCalledWith(
      "skill_1",
      "rev_1",
      expect.objectContaining({
        content: expect.objectContaining({ frontmatter: { "disable-model-invocation": false } }),
      })
    );
    confirm.mockRestore();
  });

  it.each([
    ["malformed JSON", "{", "Frontmatter must be a JSON object"],
    ["a denied key", '{"allowed-tools": ["Bash"]}', /Frontmatter is invalid: "allowed-tools"/],
    ["a reserved key", '{"name": "other"}', /structured skill field/],
  ])("refuses to save %s", async (_case, value, message) => {
    const user = userEvent.setup();
    renderEditor();

    fireEvent.change(screen.getByLabelText("Frontmatter (JSON)"), { target: { value } });
    await user.click(screen.getByRole("button", { name: "Save new revision" }));

    expect(replaceSkillMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(message));
  });
});
