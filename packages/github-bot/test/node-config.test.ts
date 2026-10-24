import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/node/config";

const complete = {
  CONTROL_PLANE_URL: "http://open-inspect-control-plane:8787/",
  SERVICE_AUTH_SECRET_GITHUB_BOT: "placeholder-service-secret",
  GITHUB_WEBHOOK_SECRET: "placeholder-webhook-secret",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "placeholder-private-key",
  GITHUB_APP_INSTALLATION_ID: "67890",
  GITHUB_BOT_USERNAME: "sf-bot[bot]",
};

describe("loadConfig", () => {
  it("reads the fixed names, applies the defaults and denies every repository", () => {
    expect(loadConfig(complete)).toEqual({
      host: "0.0.0.0",
      port: 3200,
      stateDir: "/state",
      controlPlaneUrl: "http://open-inspect-control-plane:8787",
      logLevel: "info",
      vars: {
        DEPLOYMENT_NAME: "open-inspect",
        DEFAULT_MODEL,
        GITHUB_BOT_USERNAME: "sf-bot[bot]",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "placeholder-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_WEBHOOK_SECRET: "placeholder-webhook-secret",
        SERVICE_AUTH_SECRET: "placeholder-service-secret",
        SF_GITHUB_REPO_ALLOWLIST: "",
        LOG_LEVEL: undefined,
      },
    });
  });

  it("passes the allowlist, port, state dir and app name through", () => {
    const config = loadConfig({
      ...complete,
      SF_GITHUB_REPO_ALLOWLIST: "ProvidenceIT/playground, ProvidenceIT/sf",
      GITHUB_BOT_PORT: "8080",
      GITHUB_BOT_STATE_DIR: "/data",
      APP_NAME: "Software Factory",
      LOG_LEVEL: "debug",
    });

    expect(config.port).toBe(8080);
    expect(config.stateDir).toBe("/data");
    expect(config.logLevel).toBe("debug");
    expect(config.vars.SF_GITHUB_REPO_ALLOWLIST).toBe("ProvidenceIT/playground, ProvidenceIT/sf");
    expect(config.vars.APP_NAME).toBe("Software Factory");
  });

  it("names missing variables without echoing any value", () => {
    const { GITHUB_WEBHOOK_SECRET: _secret, ...withoutSecret } = complete;
    expect(() => loadConfig({ ...withoutSecret, SERVICE_AUTH_SECRET_GITHUB_BOT: "  " })).toThrow(
      new ConfigError([
        "SERVICE_AUTH_SECRET_GITHUB_BOT is required",
        "GITHUB_WEBHOOK_SECRET is required",
      ])
    );
  });

  it("rejects a control-plane URL with a path, which would break request signing", () => {
    expect(() =>
      loadConfig({ ...complete, CONTROL_PLANE_URL: "https://sf.example.test/api" })
    ).toThrow(
      new ConfigError(["CONTROL_PLANE_URL must be an absolute http(s) origin with no path"])
    );
  });

  it("rejects an allowlist entry that is not owner/name", () => {
    expect(() =>
      loadConfig({ ...complete, SF_GITHUB_REPO_ALLOWLIST: "acme/widgets,widgets,a/b/c" })
    ).toThrow(
      new ConfigError(["SF_GITHUB_REPO_ALLOWLIST entries must be owner/name: widgets, a/b/c"])
    );
  });

  it("rejects an unknown default model", () => {
    expect(() => loadConfig({ ...complete, DEFAULT_MODEL: "nope/none" })).toThrow(
      new ConfigError(['DEFAULT_MODEL "nope/none" is not a known model id'])
    );
  });
});
