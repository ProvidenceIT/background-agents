import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/me/auth-home/lease", "Codex seat");
