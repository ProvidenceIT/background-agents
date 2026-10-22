"use client";

import Link from "next/link";
import useSWR from "swr";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

async function fetchSessionTitle(path: BrowserApiPath): Promise<string | null> {
  const response = await browserApiFetch(path);
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !("session" in body)) return null;
  const { session } = body;
  if (!session || typeof session !== "object" || !("title" in session)) return null;
  return typeof session.title === "string" && session.title ? session.title : null;
}

/** "Forked from <source title>" for a fork; the title stays generic when the source is unreadable. */
export function ForkedFromLink({
  sourceSessionId,
}: {
  sourceSessionId: string | null | undefined;
}) {
  const path: BrowserApiPath | null = sourceSessionId
    ? `/api/sessions/${encodeURIComponent(sourceSessionId)}`
    : null;
  const { data: title } = useSWR(path, fetchSessionTitle, { revalidateOnFocus: false });
  if (!sourceSessionId) return null;

  return (
    <p className="border-b border-border-muted px-4 py-1.5 text-xs text-muted-foreground">
      Forked from{" "}
      <Link
        href={`/session/${encodeURIComponent(sourceSessionId)}`}
        className="text-accent underline-offset-2 hover:underline"
      >
        {title ?? "the original session"}
      </Link>
    </p>
  );
}
