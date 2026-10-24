import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy<{ owner: string; name: string }>(
  ({ owner, name }) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/ownership`,
  "repository ownership"
);
