// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { SkillImportReview } from "./skill-import-review";

expect.extend(matchers);

afterEach(cleanup);

const preview: SkillImportPreviewResponse = {
  name: "deploy-service",
  source: {
    provider: "gitlab",
    repoOwner: "acme",
    repoName: "skills",
    requestedRef: null,
    resolvedRef: "main",
    commitSha: "a".repeat(40),
    subdirectory: "deploy-service",
    sourceSha256: "b".repeat(64),
  },
  description: "Deploys the service",
  body: "# Deploy\n",
  license: null,
  compatibility: null,
  metadata: {},
  frontmatter: {},
  revisionSha256: "c".repeat(64),
  totalBytes: 88,
  files: [
    {
      path: "SKILL.md",
      content: "---\nname: deploy-service\n---\n# Deploy\n",
      sizeBytes: 48,
      executable: false,
    },
    {
      path: "scripts/deploy.sh",
      content: "#!/bin/sh\necho deploy-reviewed-content\n",
      sizeBytes: 40,
      executable: true,
    },
  ],
  warnings: [],
  nameAvailable: true,
};

describe("SkillImportReview", () => {
  it("shows the source provider and the content of every supporting file", () => {
    render(<SkillImportReview preview={preview} />);

    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("gitlab")).toBeInTheDocument();
    expect(screen.getByText("scripts/deploy.sh")).toBeInTheDocument();
    expect(screen.getByText(/deploy-reviewed-content/)).toBeInTheDocument();
    expect(screen.getByText("executable")).toBeInTheDocument();
    expect(screen.getByText(/name: deploy-service/)).toBeInTheDocument();
    expect(screen.queryByText("Preserved frontmatter")).not.toBeInTheDocument();
  });

  it("shows preserved frontmatter and the mapping warnings", () => {
    render(
      <SkillImportReview
        preview={{
          ...preview,
          frontmatter: { "disable-model-invocation": true, paths: ["deploy/**"] },
          warnings: [
            {
              code: "preserved-frontmatter",
              message: 'SKILL.md frontmatter "disable-model-invocation" was preserved as-is',
            },
            {
              code: "denied-frontmatter",
              message:
                'SKILL.md frontmatter "allowed-tools" grants permissions or changes cost and was not imported',
            },
          ],
        }}
      />
    );

    expect(screen.getByText("Preserved frontmatter")).toBeInTheDocument();
    expect(screen.getByText("disable-model-invocation")).toBeInTheDocument();
    expect(screen.getByText('["deploy/**"]')).toBeInTheDocument();
    expect(screen.getByText(/"disable-model-invocation" was preserved as-is/)).toBeInTheDocument();
    expect(screen.getByText(/"allowed-tools" grants permissions/)).toBeInTheDocument();
  });
});
