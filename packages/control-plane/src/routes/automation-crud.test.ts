/**
 * Background consent on automation edits: the consent is the automation
 * owner's, so an edit by anyone else withdraws it and is audited.
 *
 * Same harness as automation-update.test.ts: mocked stores, production
 * admission, mocked authentication.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as AuthorizationGuardModule from "../automation/authorization-guard";
import { isAutomationExecutionAuthorized } from "../automation/authorization-guard";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { SqlStatement } from "../db/sql-database";
import { automationRoutes } from "./automations";
import {
  mocks,
  mockStore,
  mockProviderAuthStore,
  mockProviderAccountStore,
  mockUserStore,
  mockEnvironmentStore,
  mockBatch,
  mockProviderAdapterGet,
  mockResolveGitHubCredentialAuthority,
  mockResolveGitHubEnrichmentForRequest,
  sampleRow,
  applyMockDefaults,
} from "./automations.test-support";

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: (...args: Parameters<typeof mocks.authenticate>) => mocks.authenticate(...args),
}));

vi.mock("../db/automation-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
    toAutomation: vi.fn((row: unknown) => row),
    toAutomationRun: vi.fn((row: unknown) => row),
  };
});

vi.mock("../db/automation-model-provider-auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
      return mockProviderAuthStore;
    }),
  };
});

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return mockProviderAccountStore;
  }),
}));

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return mockEnvironmentStore;
  }),
}));

vi.mock("../auth/model-provider-account-default-adapters", () => ({
  modelProviderAccountAdapterRegistry: {
    get: (...args: unknown[]) => mockProviderAdapterGet(...args),
  },
}));

vi.mock("../source-control/github-credential-authority", () => ({
  resolveGitHubCredentialAuthority: (...args: unknown[]) =>
    mockResolveGitHubCredentialAuthority(...args),
}));

vi.mock("../session/identity", () => ({
  resolveGitHubEnrichmentForRequest: (...args: unknown[]) =>
    mockResolveGitHubEnrichmentForRequest(...args),
}));

vi.mock("../auth/crypto", () => ({
  generateId: vi.fn(() => "generated-id"),
}));

vi.mock("../automation/authorization-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthorizationGuardModule>()),
  isAutomationExecutionAuthorized: vi.fn(),
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn().mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    }),
  };
});

const handleRequest = createTestRequestHandler([automationRoutes]);
const OWNER = "user-1";
const EDITOR = "user-2";

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

/** Admission answers for `userId`; every other statement is recorded with its bindings. */
function recordingEnv(userId: string) {
  const recorded: RecordedStatement[] = [];
  const DB = authorizationDatabase({
    userId,
    statement: (sql) => {
      const entry: RecordedStatement = { sql, args: [] };
      recorded.push(entry);
      const statement = {
        bind: (...args: unknown[]) => {
          entry.args = args;
          return statement;
        },
        first: async () => ({ satisfied: 1 }),
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement as unknown as SqlStatement;
    },
    batch: mockBatch,
  });
  return { env: createTestEnv({ ...TEST_SERVICE_SECRETS, SCM_PROVIDER: "github", DB }), recorded };
}

function put(userId: string, body: unknown) {
  const { env, recorded } = recordingEnv(userId);
  mocks.authenticate.mockImplementation(async (request: Request) => ({
    principal: { kind: "user", userId },
    request,
  }));
  const response = handleRequest(
    new Request("https://test.local/automations/auto-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
  return { response, recorded };
}

function consentAudits(recorded: RecordedStatement[]) {
  return recorded
    .filter(
      (entry) =>
        entry.sql.includes("INSERT INTO authorization_audit_events") &&
        entry.args.includes("auth_home.consent_changed")
    )
    .map((entry) => JSON.parse(entry.args[entry.args.length - 1] as string));
}

describe("automation background consent", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
    vi.mocked(isAutomationExecutionAuthorized).mockResolvedValue(true);
  });

  it("clears the owner's consent when anyone else edits the automation, and audits who did", async () => {
    const { response, recorded } = put(EDITOR, { name: "Renamed" });
    expect((await response).status).toBe(200);
    expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith("auto-1", {
      name: "Renamed",
      background_consent_at: null,
    });
    expect(consentAudits(recorded)).toEqual([
      expect.objectContaining({
        by: EDITOR,
        from: sampleRow.background_consent_at,
        to: null,
        scope: "automation",
      }),
    ]);
  });

  it("leaves the consent alone when the owner edits, and restores it once withdrawn", async () => {
    const kept = put(OWNER, { name: "Renamed" });
    expect((await kept.response).status).toBe(200);
    expect(mockStore.bindAutomationUpdate).toHaveBeenLastCalledWith("auto-1", {
      name: "Renamed",
    });
    expect(consentAudits(kept.recorded)).toEqual([]);

    mockStore.getById.mockResolvedValue({ ...sampleRow, background_consent_at: null });
    const restored = put(OWNER, { name: "Again" });
    expect((await restored.response).status).toBe(200);
    expect(mockStore.bindAutomationUpdate).toHaveBeenLastCalledWith("auto-1", {
      name: "Again",
      background_consent_at: expect.any(Number),
    });
    expect(consentAudits(restored.recorded)).toEqual([
      expect.objectContaining({ by: OWNER, from: null, to: expect.any(Number) }),
    ]);
  });
});
