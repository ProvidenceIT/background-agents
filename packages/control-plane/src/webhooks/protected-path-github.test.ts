import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitHubAppModule from "../auth/github-app";
import { createProtectedPathGitHub } from "./protected-path-github";

const mocks = vi.hoisted(() => ({ getCachedInstallationToken: vi.fn() }));

vi.mock("../auth/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAppModule>()),
  getCachedInstallationToken: mocks.getCachedInstallationToken,
}));

const PR = { repositoryId: 9001, repoOwner: "acme", repoName: "web", number: 7 };
const APP = { appId: "1", privateKey: "unused", installationId: "2" };

describe("createProtectedPathGitHub", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    mocks.getCachedInstallationToken.mockResolvedValue("token-1");
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  const github = () => createProtectedPathGitHub(APP, { userAgent: "test-agent" });

  it("lists every page of changed files, including both sides of a rename", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ filename: `src/f${index}.ts` }));
    fetchMock
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(
        Response.json([{ filename: "ci/old.yml", previous_filename: ".github/workflows/ci.yml" }])
      );

    const files = await github().listChangedFiles(PR);

    expect(files).toHaveLength(102);
    expect(files.slice(-2)).toEqual(["ci/old.yml", ".github/workflows/ci.yml"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=1",
      "https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=2",
    ]);
    expect(mocks.getCachedInstallationToken).toHaveBeenCalledWith(
      APP,
      { userAgent: "test-agent" },
      { scope: { kind: "repositories", repositoryIds: [9001] } }
    );
  });

  it("refuses to report a diff GitHub stopped listing", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ filename: `f${index}` }));
    fetchMock.mockImplementation(async () => Response.json(fullPage));

    await expect(github().listChangedFiles(PR)).rejects.toThrow("cannot verify paths");
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it("treats removing an already-removed label as done, and other failures as errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(github().removeLabel(PR, "sf:hold-protected-path")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/web/issues/7/labels/sf%3Ahold-protected-path"
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(github().addLabel(PR, "sf:hold-protected-path")).rejects.toThrow(
      "GitHub add label failed (status 403)"
    );
  });
});
