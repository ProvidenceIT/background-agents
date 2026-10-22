import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy(
  ({ id }: { id: string }) => `/sessions/${encodeURIComponent(id)}/fork/handoff`,
  "fork handoff"
);
