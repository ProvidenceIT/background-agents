import { settingsProxy } from "@/lib/settings-proxy";

/** Every enrolled home as metadata (no volume names); the control plane requires auth_homes.read_all. */
export const { GET } = settingsProxy(() => "/auth-homes", "subscription homes");
