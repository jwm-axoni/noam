// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectDocumentIdentity: vi.fn(),
  getNoteMeta: vi.fn(),
  queryKnowledge: vi.fn(),
  readNote: vi.fn(),
  searchNotes: vi.fn(),
}));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  return {
    ...actual,
    inspectDocumentIdentity: mocks.inspectDocumentIdentity,
    getNoteMeta: mocks.getNoteMeta,
    queryKnowledge: mocks.queryKnowledge,
    readNote: mocks.readNote,
    searchNotes: mocks.searchNotes,
  };
});

import {
  notifyActiveNoteChanged,
  setActiveNote,
} from "../lib/editor/activeView";
import { bindActiveNote } from "../lib/editor/activeNoteBinding";
import type {
  LocalKnowledgeItem,
  LocalKnowledgePage,
  LocalKnowledgeQuery,
  NoteMeta,
} from "../lib/ipc";
import { resetKnowledgeCatalog } from "../lib/knowledge/catalogStore";
import { useStore } from "../store";
import { formatModified, PropertiesDockPanel } from "./PropertiesDockPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const panelProps = {
  instanceId: "panel:properties",
  vaultKey: "vault-a",
  vaultEpoch: 1,
  activeNotePath: "Notes/Project.md",
  visible: true,
  compact: true,
  onOpenNote: vi.fn(),
  onRequestClose: () => {},
};

const CATALOG = `---
noam_kind: knowledge-schema
noam_knowledge_version: 1
---

\`\`\`json
${JSON.stringify({
  version: 1,
  properties: [
    { id: "status", key: "status", name: "Status", type: { kind: "text", cardinality: "one" } },
    { id: "priority", key: "priority", name: "Priority", type: { kind: "text", cardinality: "one" } },
  ],
  labels: [],
  relationships: [
    { id: "works-with", name: "Works with", inverseName: "Worked with by", cardinality: "many" },
  ],
})}
\`\`\``;

const meta = (path: string, id = `local-${path}`): NoteMeta => ({
  id,
  path,
  title: path,
  mtime: 1_786_000_000,
  sha256: "abc",
  frontmatter: null,
  type: "project",
  kind: "note",
  tags: ["work"],
});

const page = (items: LocalKnowledgeItem[], nextCursor: string | null = null): LocalKnowledgePage => ({
  items,
  nextCursor,
  generation: 4,
});

const backlink = (
  index: number,
): Extract<LocalKnowledgeItem, { kind: "backlink" }> => ({
  kind: "backlink",
  backlinkId: index,
  sourceNoteId: `source-${index}`,
  sourcePath: `Notes/Source ${index}.md`,
  sourceTitle: `Source ${index}`,
  linkText: "Project",
});

const relationship = (
  overrides: Partial<Extract<LocalKnowledgeItem, { kind: "relationship" }>> = {},
): Extract<LocalKnowledgeItem, { kind: "relationship" }> => ({
  kind: "relationship",
  edgeId: "edge-1",
  relationshipId: "works-with",
  sourceNoteId: "note-project",
  sourcePath: "Notes/Project.md",
  targetDocumentId: "portable-target",
  targetNoteId: "note-target",
  targetPath: "People/Ada.md",
  resolution: "resolved",
  ordinal: 0,
  ...overrides,
});

const state = (path = "Notes/Project.md"): Extract<LocalKnowledgeItem, { kind: "indexState" }> => ({
  kind: "indexState",
  noteId: `local-${path}`,
  path,
  portableDocumentId: "portable-project",
  identityStatus: "portable",
  sourceRevision: "source-1",
  indexRevision: "source-1",
  indexStatus: "ready",
  generation: 4,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("PropertiesDockPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let editorHost: HTMLDivElement;
  let view: EditorView;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const renderActive = async (props = panelProps, path = props.activeNotePath!) => {
    await act(async () => {
      setActiveNote(bindActiveNote(view, path));
      root.render(createElement(PropertiesDockPanel, props));
    });
  };

  beforeEach(() => {
    resetKnowledgeCatalog();
    panelProps.onOpenNote.mockReset();
    mocks.inspectDocumentIdentity.mockReset().mockResolvedValue({
      documentId: "portable-target",
      sourceRevision: "target-revision",
      sourceFileIdentity: "target-file",
      insertionRequired: false,
    });
    mocks.getNoteMeta.mockReset().mockImplementation(async (path: string) => meta(path));
    mocks.readNote.mockReset().mockResolvedValue(CATALOG);
    mocks.queryKnowledge.mockReset().mockImplementation(async (query: LocalKnowledgeQuery) =>
      query.kind === "indexState" ? page([state()]) : page([]),
    );
    mocks.searchNotes.mockReset().mockResolvedValue([]);
    useStore.setState({
      vault: { path: "/vault-a", name: "vault-a", epoch: 1 },
      backlinks: [],
      syncEnabled: false,
      syncStatus: "offline",
      docIdByPath: {},
      openVersionPanel: vi.fn(async () => {}),
    });
    host = document.createElement("div");
    editorHost = document.createElement("div");
    document.body.append(host, editorHost);
    root = createRoot(host);
    view = new EditorView({
      state: EditorState.create({ doc: "---\nstatus: draft\n---\nBody" }),
      parent: editorHost,
    });
  });

  afterEach(async () => {
    setActiveNote(null);
    await act(async () => root.unmount());
    resetKnowledgeCatalog();
    view.destroy();
    host.remove();
    editorHost.remove();
  });

  it("shows an empty state until the matching live Markdown editor is active", async () => {
    await act(async () => root.render(createElement(PropertiesDockPanel, panelProps)));
    expect(host.textContent).toContain("Open a Markdown note");

    await act(async () => setActiveNote(bindActiveNote(view, "Notes/Other.md")));
    expect(host.textContent).toContain("Open a Markdown note");
    expect(mocks.queryKnowledge).not.toHaveBeenCalled();
  });

  it("keeps the live Properties editor usable while indexed details load", async () => {
    const pending = deferred<NoteMeta | null>();
    mocks.getNoteMeta.mockReturnValueOnce(pending.promise);
    await renderActive();

    expect(host.querySelectorAll(".prop-row")).toHaveLength(1);
    expect(host.textContent).toContain("Loading note details...");
    await act(async () => host.querySelector<HTMLButtonElement>(".prop-add")!.click());
    expect(view.state.doc.toString()).toContain("priority:");

    pending.resolve(meta("Notes/Project.md"));
    await flush();
    expect(host.textContent).toContain("Ready");
  });

  it("drops a slower prior note response after the active note changes", async () => {
    const oldNote = deferred<NoteMeta | null>();
    mocks.getNoteMeta.mockImplementation((path: string) =>
      path === "Notes/Old.md" ? oldNote.promise : Promise.resolve(meta(path)),
    );
    mocks.queryKnowledge.mockImplementation(async (query: LocalKnowledgeQuery) => {
      if (query.kind === "indexState") return page([state("Notes/New.md")]);
      if (query.kind === "relationships" && query.direction === "outgoing") {
        return page([relationship({ targetPath: "Notes/New target.md" })]);
      }
      return page([]);
    });

    const oldProps = { ...panelProps, activeNotePath: "Notes/Old.md" };
    await renderActive(oldProps);
    const newProps = { ...panelProps, activeNotePath: "Notes/New.md" };
    await renderActive(newProps);
    await flush();
    expect(host.textContent).toContain("New target");

    oldNote.resolve(meta("Notes/Old.md"));
    await flush();
    expect(host.textContent).toContain("New target");
    expect(host.textContent).not.toContain("Old.md");
  });

  it("renders catalog names, resolution failures, info, backlinks, and resolved navigation", async () => {
    const outgoing = [
      relationship(),
      relationship({
        edgeId: "edge-missing",
        targetDocumentId: "portable-missing",
        targetNoteId: null,
        targetPath: null,
        resolution: "missing_reference",
      }),
      relationship({
        edgeId: "edge-duplicate",
        targetDocumentId: "portable-duplicate",
        targetNoteId: null,
        targetPath: null,
        resolution: "duplicate_document_identity",
      }),
    ];
    const incoming = [relationship({
      edgeId: "edge-incoming",
      sourceNoteId: "note-brief",
      sourcePath: "Notes/Brief.md",
      targetDocumentId: "portable-project",
      targetNoteId: "note-project",
      targetPath: "Notes/Project.md",
    })];
    mocks.queryKnowledge.mockImplementation(async (query: LocalKnowledgeQuery) => {
      if (query.kind === "indexState") return page([state()]);
      if (query.kind === "relationships") {
        return page(query.direction === "outgoing" ? outgoing : incoming);
      }
      if (query.kind === "backlinks") return page([{
        kind: "backlink",
        backlinkId: 1,
        sourceNoteId: "source-1",
        sourcePath: "Notes/Source.md",
        sourceTitle: "Source",
        linkText: "Project",
      }]);
      return page([]);
    });

    await renderActive();
    await flush();

    expect(host.textContent).toContain("Works with");
    expect(host.textContent).toContain("Worked with by");
    expect(host.textContent).toContain("Missing note");
    expect(host.textContent).toContain("Duplicate identity");
    expect(host.textContent).toContain("portable-project");
    expect(host.textContent).toContain("Ready");
    expect(host.textContent).toContain("Notes/Project.md");
    expect(host.textContent).not.toContain("1970");
    expect(host.querySelector('[title="portable-missing"]')?.closest("button")).toBeNull();
    expect(host.querySelector('[data-edge-id="edge-1"]')).toMatchObject({
      dataset: expect.objectContaining({
        relationshipId: "works-with",
        targetDocumentId: "portable-target",
        resolution: "resolved",
        resolvedPath: "People/Ada.md",
      }),
    });

    await act(async () => host.querySelector<HTMLButtonElement>('[title="People/Ada.md"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Notes/Brief.md"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Notes/Source.md"]')!.click());
    expect(panelProps.onOpenNote.mock.calls.map(([path]) => path)).toEqual([
      "People/Ada.md",
      "Notes/Brief.md",
      "Notes/Source.md",
    ]);
  });

  it("links the existing Noam version provider and reports unavailable history honestly", async () => {
    await renderActive();
    await flush();
    expect(host.textContent).toContain("Unavailable");
    expect(host.textContent).toContain("No version history is available for this note.");
    expect(host.textContent).not.toContain("Local history");
    expect([...host.querySelectorAll("button")].some(
      (button) => button.textContent === "Open version history",
    )).toBe(false);

    await act(async () => useStore.setState({
      syncEnabled: true,
      syncStatus: "synced",
      docIdByPath: { "Notes/Project.md": "server-project" },
    }));
    expect(host.textContent).toContain("Noam version history");
    expect(host.textContent).toContain("Synced");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Open version history",
    )!.click());
    expect(useStore.getState().openVersionPanel).toHaveBeenCalledWith("server-project");
  });

  it("pages beyond 50 relationships and backlinks with honest loaded counts", async () => {
    const firstRelationships = Array.from({ length: 50 }, (_, index) => relationship({
      edgeId: `edge-${index}`,
      ordinal: index,
      targetDocumentId: `portable-${index}`,
      targetNoteId: `target-${index}`,
      targetPath: `Notes/Target ${index}.md`,
    }));
    const firstBacklinks = Array.from({ length: 50 }, (_, index) => backlink(index));
    mocks.queryKnowledge.mockImplementation(async (
      query: LocalKnowledgeQuery,
      request?: { cursor?: string | null },
    ) => {
      if (query.kind === "indexState") return page([state()]);
      if (query.kind === "relationships" && query.direction === "incoming") return page([]);
      if (query.kind === "relationships") {
        return request?.cursor
          ? page([relationship({
              edgeId: "edge-50",
              ordinal: 50,
              targetDocumentId: "portable-50",
              targetNoteId: "target-50",
              targetPath: "Notes/Target 50.md",
            })])
          : page(firstRelationships, "relationships-page-2");
      }
      if (query.kind === "backlinks") {
        return request?.cursor ? page([backlink(50)]) : page(firstBacklinks, "backlinks-page-2");
      }
      return page([]);
    });

    await renderActive();
    await flush();
    expect(host.textContent).toContain("Outgoing50+");
    expect(host.textContent).toContain("Backlinks50+");

    await act(async () => host.querySelector<HTMLButtonElement>(
      ".properties-inspector-group .properties-inspector-load-more",
    )!.click());
    await flush();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(
      ".properties-inspector-load-more",
    )].find((button) => button.textContent === "Load more backlinks")!.click());
    await flush();

    expect(host.textContent).toContain("Outgoing51");
    expect(host.textContent).toContain("Backlinks51");
    expect(host.querySelector('[data-edge-id="edge-50"]')).not.toBeNull();
    expect(host.querySelector('[title="Notes/Source 50.md"]')).not.toBeNull();
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "relationships", direction: "outgoing" }),
      { limit: 50, cursor: "relationships-page-2" },
    );
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      { kind: "backlinks", noteId: "local-Notes/Project.md" },
      { limit: 50, cursor: "backlinks-page-2" },
    );
  });

  it("reloads a section from its first page when its cursor expires", async () => {
    let firstPageRequests = 0;
    mocks.queryKnowledge.mockImplementation(async (
      query: LocalKnowledgeQuery,
      request?: { cursor?: string | null },
    ) => {
      if (query.kind === "indexState") return page([state()]);
      if (query.kind !== "relationships" || query.direction === "incoming") return page([]);
      if (request?.cursor === "expired-page") {
        throw new Error("cursor_expired: knowledge index changed");
      }
      if (request?.cursor === "fresh-page") {
        return page([relationship({
          edgeId: "fresh-2",
          targetPath: "Notes/Fresh target 2.md",
        })]);
      }
      firstPageRequests += 1;
      return firstPageRequests === 1
        ? page([relationship({ edgeId: "old", targetPath: "Notes/Old target.md" })], "expired-page")
        : page([relationship({ edgeId: "fresh-1", targetPath: "Notes/Fresh target 1.md" })], "fresh-page");
    });

    await renderActive();
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>(
      ".properties-inspector-group .properties-inspector-load-more",
    )!.click());
    await flush();

    expect(host.textContent).toContain("Fresh target 1");
    expect(host.textContent).not.toContain("Old target");
    expect(host.textContent).not.toContain("cursor_expired");
    expect(host.textContent).toContain("Outgoing1+");
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "relationships", direction: "outgoing" }),
      { limit: 50 },
    );

    await act(async () => host.querySelector<HTMLButtonElement>(
      ".properties-inspector-group .properties-inspector-load-more",
    )!.click());
    await flush();

    expect(host.textContent).toContain("Fresh target 2");
    expect(host.textContent).toContain("Outgoing2");
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "relationships", direction: "outgoing" }),
      { limit: 50, cursor: "fresh-page" },
    );
  });

  it("drops a recovered first page after the inspector context changes", async () => {
    const staleRecovery = deferred<LocalKnowledgePage>();
    let oldFirstPageRequests = 0;
    mocks.getNoteMeta.mockImplementation(async (path: string, epoch?: number) =>
      meta(path, `note-${epoch}`),
    );
    mocks.queryKnowledge.mockImplementation(async (
      query: LocalKnowledgeQuery,
      request?: { cursor?: string | null },
    ) => {
      if (query.kind === "indexState") return page([state()]);
      if (query.kind !== "relationships" || query.direction === "incoming") return page([]);
      if (query.noteId === "note-2") {
        return page([relationship({ edgeId: "new", targetPath: "Notes/New target.md" })]);
      }
      if (request?.cursor === "expired-page") {
        throw new Error("cursor_expired: knowledge index changed");
      }
      oldFirstPageRequests += 1;
      return oldFirstPageRequests === 1
        ? page([relationship({ edgeId: "old", targetPath: "Notes/Old target.md" })], "expired-page")
        : staleRecovery.promise;
    });

    await renderActive();
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>(
      ".properties-inspector-group .properties-inspector-load-more",
    )!.click());
    await flush();

    await act(async () => {
      useStore.setState({ vault: { path: "/vault-b", name: "vault-b", epoch: 2 } });
      root.render(createElement(PropertiesDockPanel, { ...panelProps, vaultKey: "vault-b", vaultEpoch: 2 }));
    });
    await flush();
    expect(host.textContent).toContain("New target");

    staleRecovery.resolve(page([
      relationship({ edgeId: "stale-recovery", targetPath: "Notes/Stale recovery.md" }),
    ]));
    await flush();

    expect(host.textContent).toContain("New target");
    expect(host.textContent).not.toContain("Stale recovery");
  });

  it("drops a load-more response from an older vault generation at the same path", async () => {
    const stalePage = deferred<LocalKnowledgePage>();
    mocks.getNoteMeta.mockImplementation(async (path: string, epoch?: number) =>
      meta(path, `note-${epoch}`),
    );
    mocks.queryKnowledge.mockImplementation(async (
      query: LocalKnowledgeQuery,
      request?: { cursor?: string | null },
    ) => {
      if (request?.cursor === "old-page") return stalePage.promise;
      if (query.kind === "indexState") return page([state()]);
      if (query.kind === "relationships" && query.direction === "outgoing") {
        return query.noteId === "note-1"
          ? page([relationship({ edgeId: "old", targetPath: "Notes/Old target.md" })], "old-page")
          : page([relationship({ edgeId: "new", targetPath: "Notes/New target.md" })]);
      }
      return page([]);
    });

    await renderActive();
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>(
      ".properties-inspector-group .properties-inspector-load-more",
    )!.click());

    await act(async () => {
      useStore.setState({ vault: { path: "/vault-b", name: "vault-b", epoch: 2 } });
      root.render(createElement(PropertiesDockPanel, { ...panelProps, vaultKey: "vault-b", vaultEpoch: 2 }));
    });
    await flush();
    expect(host.textContent).toContain("New target");

    stalePage.resolve(page([relationship({ edgeId: "stale", targetPath: "Notes/Stale target.md" })]));
    await flush();
    expect(host.textContent).toContain("New target");
    expect(host.textContent).not.toContain("Stale target");
  });

  it("shows the initial query failure in both indexed sections", async () => {
    mocks.getNoteMeta.mockRejectedValue(new Error("Index unavailable"));
    await renderActive();
    await flush();

    expect(host.textContent?.match(/Index unavailable/g)).toHaveLength(2);
    expect(host.textContent).not.toContain("Loading backlinks...");
  });

  it("formats the documented Unix-seconds modified time", () => {
    const seconds = 1_786_000_000;
    expect(formatModified(seconds)).toBe(new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(seconds * 1_000)));
  });

  it("refreshes the shared Properties projection after a live editor transaction", async () => {
    await renderActive();
    expect(host.querySelectorAll(".prop-row")).toHaveLength(1);

    await act(async () => host.querySelector<HTMLButtonElement>(".prop-add")!.click());
    await act(async () => notifyActiveNoteChanged());
    expect(host.querySelectorAll(".prop-row")).toHaveLength(2);
  });

  it("adds a named relationship through the target identity guard and live editor", async () => {
    view.destroy();
    view = new EditorView({
      state: EditorState.create({
        doc: "---\nstatus: draft\nnoam_document_id: portable-project\n---\nBody",
      }),
      parent: editorHost,
    });
    mocks.searchNotes.mockResolvedValue([{
      id: "note-ada",
      path: "People/Ada.md",
      title: "Ada",
      snippet: "",
    }]);
    mocks.getNoteMeta.mockImplementation(async (path: string) =>
      path === "People/Ada.md" ? meta(path, "local-ada") : meta(path),
    );
    await renderActive();
    await flush();

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".properties-relationship-add")!.click();
    });
    const input = host.querySelector<HTMLInputElement>('[aria-label="Find a note to relate"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Ada");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 190));
    });
    await flush();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[title="People/Ada.md"]')!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await flush();

    expect(mocks.inspectDocumentIdentity).toHaveBeenCalledWith(
      "People/Ada.md",
      "local-ada",
      null,
      "abc",
      1,
    );
    expect(view.state.doc.toString()).toContain(
      'noam_relationships: ["works-with:portable-target"]',
    );
    expect(view.state.doc.toString()).toContain("noam_document_id: portable-project");
  });

  it("removes an outgoing edge using its portable stored value", async () => {
    view.destroy();
    view = new EditorView({
      state: EditorState.create({
        doc: [
          "---",
          "noam_document_id: portable-project",
          "noam_relationships:",
          "  - works-with:portable-target",
          "---",
          "Body",
        ].join("\n"),
      }),
      parent: editorHost,
    });
    mocks.queryKnowledge.mockImplementation(async (query: LocalKnowledgeQuery) => {
      if (query.kind === "indexState") return page([state()]);
      if (query.kind === "relationships" && query.direction === "outgoing") {
        return page([relationship({ edgeId: "works-with:portable-target" })]);
      }
      return page([]);
    });
    await renderActive();
    await flush();

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Remove Works with relationship to Ada"]',
      )!.click();
    });

    expect(view.state.doc.toString()).not.toContain("works-with:portable-target");
    expect(view.state.doc.toString()).toContain("noam_document_id: portable-project");
  });
});
