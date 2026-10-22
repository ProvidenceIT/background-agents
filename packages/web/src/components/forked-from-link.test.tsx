// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkedFromLink } from "./forked-from-link";

function renderLink(sourceSessionId: string | null) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ForkedFromLink sourceSessionId={sourceSessionId} />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ForkedFromLink", () => {
  it("renders nothing for a session that is not a fork", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderLink(null);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("links to the source session by its title", async () => {
    const fetchMock = vi.fn(async () => Response.json({ session: { title: "Refactor billing" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderLink("session-1");

    const link = await screen.findByRole("link", { name: "Refactor billing" });
    expect(link).toHaveAttribute("href", "/session/session-1");
    expect(link.parentElement).toHaveTextContent("Forked from Refactor billing");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1", expect.anything());
  });

  it("keeps the link when the source cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Forbidden" }, { status: 403 }))
    );
    renderLink("session-1");

    expect(screen.getByRole("link", { name: "the original session" })).toHaveAttribute(
      "href",
      "/session/session-1"
    );
  });
});
