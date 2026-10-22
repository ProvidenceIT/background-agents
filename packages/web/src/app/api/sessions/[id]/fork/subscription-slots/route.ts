import { settingsProxy } from "@/lib/settings-proxy";

function subscriptionSlotsPath({ id }: { id: string }, request: Request) {
  const harness = new URL(request.url).searchParams.get("harness");
  const query = harness === null ? "" : `?${new URLSearchParams({ harness })}`;
  return `/sessions/${encodeURIComponent(id)}/fork/subscription-slots${query}`;
}

export const { GET } = settingsProxy(subscriptionSlotsPath, "fork subscription slots");
