import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(() => "/repo-ownership", "repository ownership");
