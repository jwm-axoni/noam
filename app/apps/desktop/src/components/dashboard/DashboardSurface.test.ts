// @vitest-environment jsdom
//
// Routing + views, end to end over the production query path (`queryNotes` →
// the mocked `query_knowledge` command, `list_note_cards`, `resolve_wikilink`):
//
//   A DASHBOARD NOTE OPENS AS A DASHBOARD — detected from the FRONTMATTER only
//   — and the toggle hands it back to the text, remembered per path.
//   EVERY VIEW RUNS ON ITS OWN: cards, table, empty, "Show more", a header
//   re-sort, and a failing view that leaves its neighbour alone.
//   LIVE: a watcher batch re-runs the views.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChanged, LocalKnowledgeQuery, NoteCardRow } from "../../lib/ipc";

const DASHBOARD = (...blocks: string[]) =>
  ["---", "noam_kind: dashboard", "---", "", ...blocks.flatMap((b) => ["```noam-view", b, "```", ""])].join("\n");

const entry = (id: string, name: string, modified = 1_700_000_000_000) => ({
  kind: "noteEntry" as const,
  noteId: id,
  path: `Notes/${name}.md`,
  name,
  created: null,
  createdSource: null,
  modified,
});

type Query = Extract<LocalKnowledgeQuery, { kind: "notes" }>;

const mocks = vi.hoisted(() => ({
  text: "",
  onOpen: vi.fn(),
  listeners: [] as Array<(changes: FileChanged[]) => void>,
  /** Answers one `query_knowledge` page. */
  query: vi.fn(),
  cards: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../../lib/tasks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  taskNoteText: async () => mocks.text,
}));
vi.mock("../../lib/editor/activeView", () => ({
  getActiveNoteRevision: () => 0,
  subscribeActiveNote: () => () => {},
}));
vi.mock("../../lib/ipc", () => ({
  onFilesChanged: async (cb: (changes: FileChanged[]) => void) => {
    mocks.listeners.push(cb);
    return () => {
      mocks.listeners = mocks.listeners.filter((l) => l !== cb);
    };
  },
  // The knowledge catalog note: absent, so the seeded defaults apply.
  readNote: async () => {
    throw new Error("missing");
  },
  queryKnowledge: (query: LocalKnowledgeQuery, page: { limit?: number; cursor?: string | null }) =>
    mocks.query(query, page),
  listNoteCards: (ids: string[]) => mocks.cards(ids),
  resolveWikilink: (name: string) => mocks.resolve(name),
}));

import { DashboardSurface } from "./DashboardSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function settle(done: () => boolean) {
  for (let i = 0; i < 60 && !done(); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(path = "Dash.md") {
  await act(async () => {
    root.render(
      createElement(DashboardSurface, {
        path,
        onOpenNote: mocks.onOpen,
        children: createElement("div", { className: "editor-stand-in" }, "editor"),
      }),
    );
  });
  await settle(() => host.querySelector(".dashboard-view, .editor-stand-in") !== null);
}

const views = () => [...host.querySelectorAll<HTMLElement>(".dashboard-view")];
const settled = () =>
  views().length > 0 && views().every((v) => v.querySelector(".dashboard-loading") === null);

/** `where` of a query as `key=value` strings, to route fake answers. */
const whereOf = (query: Query) => (query.where ?? []).map((w) => `${w.propertyId}=${String(w.value)}`);

beforeEach(() => {
  localStorage.clear();
  mocks.listeners = [];
  mocks.onOpen.mockReset();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async () => ({
    items: [entry("a", "Alpha"), entry("b", "Beta")],
    nextCursor: null,
    generation: 1,
  }));
  mocks.cards.mockReset();
  mocks.cards.mockImplementation(async (ids: string[]): Promise<NoteCardRow[]> =>
    ids.map((id) => ({
      docId: id,
      path: `Notes/${id}.md`,
      name: id,
      excerpt: `Excerpt of ${id}`,
      firstImage: null,
      empty: false,
      properties: [{ propertyId: "type", text: id === "a" ? "zeta" : "alpha" }],
      relationships: [],
    })),
  );
  mocks.resolve.mockReset();
  mocks.resolve.mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("DashboardSurface routing", () => {
  it("opens a noam_kind: dashboard note as a dashboard, and the toggle goes back to the text", async () => {
    mocks.text = DASHBOARD("title: Recent");
    await render("Boards/Home.md");
    await settle(settled);
    expect(host.querySelector(".editor-stand-in")).toBeNull();
    expect(views()).toHaveLength(1);

    const text = [...host.querySelectorAll<HTMLButtonElement>(".surface-tab")].find((b) => b.textContent === "Text")!;
    await act(async () => text.click());
    expect(host.querySelector(".editor-stand-in")).not.toBeNull();
    expect(host.querySelector(".dashboard-host")).toBeNull();
    // Remembered per path…
    expect(localStorage.getItem("noam:dashboard-view:Boards/Home.md")).toBe("text");

    // …so reopening the same note honours it, and another dashboard does not.
    act(() => root.unmount());
    root = createRoot(host);
    await render("Boards/Home.md");
    expect(host.querySelector(".editor-stand-in")).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await render("Boards/Other.md");
    await settle(settled);
    expect(host.querySelector(".dashboard-host")).not.toBeNull();
  });

  it("the words in the body do not make a dashboard", async () => {
    mocks.text = "# Notes\n\nnoam_kind: dashboard\n\n```noam-view\ntitle: x\n```\n";
    await render();
    expect(host.querySelector(".editor-stand-in")).not.toBeNull();
    expect(host.querySelector(".surface-tab")).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("says so when a dashboard has no views", async () => {
    mocks.text = DASHBOARD();
    await render();
    await settle(() => host.querySelector(".dashboard-empty") !== null);
    expect(host.querySelector(".dashboard-empty")?.textContent).toContain("no views yet");
  });
});

describe("dashboard views", () => {
  it("renders cards from index data, and a click opens the note", async () => {
    mocks.text = DASHBOARD("title: Recent\nview: cards");
    await render();
    await settle(settled);
    const cards = [...host.querySelectorAll<HTMLButtonElement>(".gallery-card")];
    expect(cards.map((c) => c.querySelector(".gallery-card-title")?.textContent)).toEqual(["Alpha", "Beta"]);
    expect(cards[0]!.querySelector(".gallery-excerpt")?.textContent).toBe("Excerpt of a");
    expect(mocks.cards).toHaveBeenCalledWith(["a", "b"]);
    await act(async () => cards[1]!.click());
    expect(mocks.onOpen).toHaveBeenCalledWith("Notes/Beta.md");
  });

  it("renders a table; a header click re-sorts in memory and never rewrites the note", async () => {
    mocks.text = DASHBOARD("view: table\ncolumns: type, modified");
    await render();
    await settle(settled);
    const names = () => [...host.querySelectorAll(".dashboard-row td:first-child")].map((td) => td.textContent);
    const headers = [...host.querySelectorAll<HTMLButtonElement>(".dashboard-th")];
    expect(headers.map((h) => h.textContent)).toEqual(["Name", "Type", "Modified"]);
    expect(names()).toEqual(["Alpha", "Beta"]);
    const typeCells = () => [...host.querySelectorAll(".dashboard-row td:nth-child(2)")].map((td) => td.textContent);
    expect(typeCells()).toEqual(["zeta", "alpha"]);
    const queries = mocks.query.mock.calls.length;

    await act(async () => headers[1]!.click());
    expect(names()).toEqual(["Beta", "Alpha"]);
    await act(async () => headers[1]!.click());
    expect(names()).toEqual(["Alpha", "Beta"]);
    // In memory: no second query, and the note text was never touched.
    expect(mocks.query.mock.calls.length).toBe(queries);

    const link = host.querySelector<HTMLButtonElement>(".dashboard-row .dashboard-link")!;
    await act(async () => link.click());
    expect(mocks.onOpen).toHaveBeenCalledWith("Notes/Alpha.md");
    // Dates show relative, with the full date as a tooltip.
    expect(host.querySelector(".dashboard-row td:nth-child(3) span")?.getAttribute("title")).toBeTruthy();
  });

  it('says "No notes match" for an empty result', async () => {
    mocks.query.mockResolvedValue({ items: [], nextCursor: null, generation: 1 });
    mocks.text = DASHBOARD("where: type = nothing");
    await render();
    await settle(settled);
    expect(host.querySelector(".dashboard-no-match")?.textContent).toBe("No notes match");
  });

  it('"Show more" follows the cursor', async () => {
    mocks.query.mockImplementation(async (_query: Query, page: { cursor?: string | null }) =>
      page.cursor === "c1"
        ? { items: [entry("c", "Gamma")], nextCursor: null, generation: 1 }
        : { items: [entry("a", "Alpha"), entry("b", "Beta")], nextCursor: "c1", generation: 1 },
    );
    mocks.text = DASHBOARD("limit: 2");
    await render();
    await settle(settled);
    expect(host.querySelector(".dashboard-count")?.textContent).toBe("Showing 2 of 3+");
    await act(async () => host.querySelector<HTMLButtonElement>(".dashboard-more")!.click());
    await settle(() => host.querySelectorAll(".gallery-card").length === 3);
    expect(host.querySelectorAll(".gallery-card")).toHaveLength(3);
    expect(mocks.query.mock.calls[mocks.query.mock.calls.length - 1]![1]).toMatchObject({ cursor: "c1", limit: 2 });
    expect(host.querySelector(".dashboard-more")).toBeNull();
  });

  it("one failing view never blanks another", async () => {
    mocks.query.mockImplementation(async (query: Query) => {
      if (whereOf(query).includes("type=broken")) throw new Error("temporarily_unavailable: index busy");
      return { items: [entry("a", "Alpha")], nextCursor: null, generation: 1 };
    });
    mocks.text = DASHBOARD("title: Broken\nwhere: type = broken", "title: Fine\nwidth: half");
    await render();
    await settle(() => host.querySelector(".dashboard-error") !== null && host.querySelector(".gallery-card") !== null);
    const [broken, fine] = views();
    expect(broken!.querySelector(".dashboard-error")?.textContent).toContain("index busy");
    expect(fine!.querySelectorAll(".gallery-card")).toHaveLength(1);
    expect(fine!.classList.contains("is-half")).toBe(true);
  });

  it("a blocked view shows its issue and never queries; its neighbour still runs", async () => {
    mocks.text = DASHBOARD("title: Bad\nwhere: type != meeting", "title: Good");
    await render();
    await settle(settled);
    const [bad, good] = views();
    expect(bad!.querySelector(".dashboard-issue")?.textContent).toContain('"not equal"');
    expect(bad!.querySelector(".dashboard-blocked")).not.toBeNull();
    expect(good!.querySelectorAll(".gallery-card")).toHaveLength(2);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("resolves a relationship link through the index and traverses to it", async () => {
    mocks.resolve.mockResolvedValue({ id: "paul", path: "People/Paul.md" });
    mocks.text = DASHBOARD("where: people has [[Paul]]");
    await render();
    await settle(settled);
    expect(mocks.resolve).toHaveBeenCalledWith("Paul");
    expect(mocks.query.mock.calls[0]![0]).toMatchObject({
      kind: "notes",
      traverse: { fromDocId: "paul", relationshipIds: ["people"], direction: "incoming", maxDepth: 1 },
    });
  });

  it("re-runs every view on a watcher batch (debounced)", async () => {
    mocks.text = DASHBOARD("title: One", "title: Two");
    await render();
    await settle(settled);
    const before = mocks.query.mock.calls.length;
    expect(before).toBe(2);
    await act(async () => {
      for (const listener of mocks.listeners) listener([{ path: "Elsewhere/New.md", kind: "modified" }]);
      for (const listener of mocks.listeners) listener([{ path: "Elsewhere/New2.md", kind: "modified" }]);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle(() => mocks.query.mock.calls.length >= before + 2);
    // Two batches inside the debounce window → ONE re-run of each view.
    expect(mocks.query.mock.calls.length).toBe(before + 2);
  });

  it("renders note values as text, never as markup", async () => {
    mocks.query.mockResolvedValue({
      items: [entry("x", "<img src=x onerror=alert(1)>")],
      nextCursor: null,
      generation: 1,
    });
    mocks.cards.mockResolvedValue([
      {
        docId: "x",
        path: "Notes/x.md",
        name: "x",
        excerpt: "<script>alert(1)</script>",
        firstImage: null,
        empty: false,
        properties: [],
        relationships: [],
      },
    ]);
    mocks.text = DASHBOARD("title: <b>bold</b>");
    await render();
    await settle(settled);
    expect(host.querySelector("script, img, b")).toBeNull();
    expect(host.querySelector(".gallery-excerpt")?.textContent).toBe("<script>alert(1)</script>");
    expect(host.querySelector(".dashboard-view-title")?.textContent).toBe("<b>bold</b>");
  });
});
