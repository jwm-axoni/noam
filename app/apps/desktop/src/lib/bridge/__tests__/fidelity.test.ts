// @vitest-environment jsdom
// PR A — Markdown fidelity corpus (NEXT.md "Quality gates → Markdown fidelity").
//
// TESTS ONLY. No production code is touched here. The golden corpus lives in
// ./fixtures/fidelity/*.md — real files on disk, one per construct family —
// and every spec-mandated round-trip property is asserted against them:
//
//   - open-and-close without edit → zero file diff (no write at all)
//   - seed → serialize is byte-identical, through the bridge and directly
//   - an edit through the document model round-trips to the expected Markdown
//   - an external edit merges without clobbering concurrent local work
//   - CRDT convergence yields identical Markdown on every client
//   - rename/move keeps the stable note identity (doc_id, not path)
//
// A failing test here documents a real gap; it must NOT be "fixed" by editing
// production code in this PR.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { NoteBridge } from "../noteBridge";
import {
  FakeFs,
  FakePersistence,
  makeHarness,
  sha256Hex,
} from "./helpers";
import { ofmMarkdown } from "../../editor/ofm";
import { TASK_RE } from "../../editor/tasks";
import { findFrontmatter } from "../../editor/frontmatter";
import { parseFrontmatter } from "../../frontmatter/parse";
import { planSetValue } from "../../frontmatter/edit";
import type { BridgeIO } from "../types";
import { createEditorState } from "../../editor";
import type { ViewMode } from "../../editor/viewMode";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fidelity",
);

/** Every corpus file, sorted by name: [fileName, content]. */
function loadCorpus(): Array<[string, string]> {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => [f, readFileSync(join(FIXTURE_DIR, f), "utf8")]);
}

const CORPUS = loadCorpus();
const byName = (n: string): string => {
  const hit = CORPUS.find(([name]) => name === n);
  if (!hit) throw new Error(`missing fixture ${n}`);
  return hit[1];
};

/** The exact parser configuration the editor wires (editor/index.ts). */
function editorNodeNames(doc: string): { names: Set<string>; errors: number } {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM, ...ofmMarkdown] })],
  });
  const names = new Set<string>();
  let errors = 0;
  syntaxTree(state).iterate({
    enter: (n) => {
      names.add(n.name);
      if (n.name === "⚠") errors++;
    },
  });
  return { names, errors };
}

describe("fidelity corpus", () => {
  it("loads the full spec-mandated construct set", () => {
    const names = CORPUS.map(([n]) => n);
    expect(names).toEqual([
      "01-frontmatter-typed.md",
      "02-wikilinks.md",
      "03-heading-block-refs.md",
      "04-embeds.md",
      "05-tables.md",
      "06-callouts.md",
      "07-math.md",
      "08-diagrams-mermaid.md",
      "09-code-fences.md",
      "10-nested-lists.md",
      "11-tasks.md",
      "12-footnotes.md",
      "13-strikethrough-highlight.md",
      "14-html-comments.md",
      "15-unicode.md",
      "16-large-note.md",
      "17-kitchen-sink.md",
      "18-setext-tabs.md",
      "19-crlf.md",
      "20-bom.md",
    ]);
    for (const [name, content] of CORPUS) {
      expect(content.length, `${name} must not be empty`).toBeGreaterThan(0);
    }
    const large = byName("16-large-note.md");
    expect(large.length).toBeGreaterThan(1024 * 1024);
  });
});

describe("parse coverage — the editor's parser handles every fixture", () => {
  it("produces no error nodes for any corpus file", () => {
    for (const [name, content] of CORPUS) {
      const { errors } = editorNodeNames(content);
      expect(errors, `parse errors in ${name}`).toBe(0);
    }
  });

  it("recognizes each construct family with the expected node types", () => {
    const cases: Array<[string, string[]]> = [
      ["05-tables.md", ["Table", "TableHeader", "TableRow", "TableCell"]],
      ["06-callouts.md", ["Blockquote"]],
      ["09-code-fences.md", ["FencedCode", "CodeInfo"]],
      ["10-nested-lists.md", ["BulletList", "OrderedList", "ListItem"]],
      ["11-tasks.md", ["Task"]],
      ["13-strikethrough-highlight.md", ["Strikethrough", "Highlight"]],
      ["14-html-comments.md", ["CommentBlock", "OfmCommentBlock", "HTMLBlock"]],
      ["18-setext-tabs.md", ["SetextHeading1", "SetextHeading2", "BulletList", "OrderedList"]],
    ];
    for (const [file, expected] of cases) {
      const { names } = editorNodeNames(byName(file));
      for (const node of expected) {
        expect(names.has(node), `${file} should parse a ${node}`).toBe(true);
      }
    }
  });

  it("keeps footnote references as plain text (no Footnotes extension wired)", () => {
    // The editor deliberately wires only GFM + OFM today. Footnote syntax
    // must still round-trip byte-identically (asserted below); it is just not
    // parsed into footnote nodes. If a Footnotes extension is added later,
    // this test should start expecting Footnote nodes instead.
    const { names } = editorNodeNames(byName("12-footnotes.md"));
    expect(names.has("Footnote")).toBe(false);
  });
});

describe("Y.Text round-trip — seed → serialize is byte-identical", () => {
  it("round-trips every corpus file directly", () => {
    for (const [name, content] of CORPUS) {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, content);
      expect(text.toString(), `direct round-trip failed for ${name}`).toBe(content);
      expect(sha256Hex(text.toString())).toBe(sha256Hex(content));
      doc.destroy();
    }
  });

  it("round-trips through bridge open (seed) → serialize", async () => {
    for (const [name, content] of CORPUS) {
      const { io } = makeHarness({ [name]: content });
      const bridge = await NoteBridge.open(io, { docId: `doc-${name}`, path: name });
      expect(bridge.serialize(), `bridge seed round-trip failed for ${name}`).toBe(content);
      bridge.destroy();
    }
  });
});

describe("view-mode fidelity — every presentation keeps the exact buffer", () => {
  for (const mode of ["live", "source", "reading"] as const satisfies readonly ViewMode[]) {
    it(`${mode} keeps every corpus file byte-identical`, () => {
      for (const [name, content] of CORPUS) {
        const state = createEditorState({
          doc: content,
          getTitles: () => [],
          onNavigate: () => {},
          viewMode: { mode, compartment: new Compartment() },
        });
        const roundTrip = state.doc.toString();
        expect(roundTrip, `${mode} changed ${name}`).toBe(content);
        expect(sha256Hex(roundTrip)).toBe(sha256Hex(content));
      }
    });
  }

  it("keeps CodeMirror and Y.Text offset-identical through every CRLF transaction path", () => {
    const initial = "one\r\ntwo";
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, initial);
    const undoManager = new Y.UndoManager(ytext);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: createEditorState({
        doc: initial,
        collab: true,
        getTitles: () => [],
        onNavigate: () => {},
        viewMode: { mode: "source", compartment: new Compartment() },
        extraExtensions: [yCollab(ytext, null, { undoManager })],
      }),
      parent,
    });
    const expectSynced = (expected: string) => {
      expect(view.state.doc.toString()).toBe(expected);
      expect(ytext.toString()).toBe(expected);
      expect(view.state.doc.length).toBe(ytext.length);
    };

    expectSynced(initial);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    expectSynced("");
    undoManager.undo();
    expectSynced(initial);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    expectSynced("one\r\ntwo!");

    ydoc.transact(() => ytext.insert(0, "remote\r\n"), "remote");
    expectSynced("remote\r\none\r\ntwo!");
    view.dispatch({ changes: { from: "remote\r\n".length, insert: ">" } });
    expectSynced("remote\r\n>one\r\ntwo!");

    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, "disk\r\ntext");
    }, "disk-ingest");
    expectSynced("disk\r\ntext");
    view.dispatch({ changes: { from: 6, insert: "!" } });
    expectSynced("disk\r\n!text");

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\r\npasted" },
      userEvent: "input.paste",
    });
    expectSynced("disk\r\n!text\r\npasted");
    view.dispatch({ changes: { from: view.state.doc.length - 1, insert: "?" } });
    expectSynced("disk\r\n!text\r\npaste?d");

    view.destroy();
    ydoc.destroy();
  });
});

describe("open-and-close without edit — zero file diff", () => {
  it("writes nothing and leaves the file byte-identical for every corpus file", async () => {
    vi.useFakeTimers();
    try {
      for (const [name, content] of CORPUS) {
        const { io, fs } = makeHarness({ [name]: content });
        const bridge = await NoteBridge.open(io, { docId: `doc-${name}`, path: name });
        // Settle any debounce timers the open may have armed.
        await vi.advanceTimersByTimeAsync(1000);
        expect(fs.writeCount, `unexpected write for ${name}`).toBe(0);
        expect(fs.get(name), `file changed for ${name}`).toBe(content);
        bridge.destroy();
        // Destroy must not flush a phantom write either.
        await vi.advanceTimersByTimeAsync(1000);
        expect(fs.writeCount, `write on destroy for ${name}`).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("egests a trivially-touched doc back byte-identically", async () => {
    for (const [name, content] of CORPUS) {
      if (content.length === 0) continue;
      const { io, fs } = makeHarness({ [name]: content });
      const bridge = await NoteBridge.open(io, { docId: `doc-${name}`, path: name });
      bridge.edit((t) => {
        // Delete+reinsert the last char: forces an egest without changing bytes.
        const s = t.toString();
        t.delete(s.length - 1, 1);
        t.insert(s.length - 1, s.slice(-1));
      });
      await bridge.flushEgest();
      expect(fs.get(name), `egest round-trip failed for ${name}`).toBe(content);
      bridge.destroy();
    }
  });
});

describe("live-preview edit round-trip", () => {
  it("toggling a task checkbox yields the exact expected Markdown", () => {
    const src = byName("11-tasks.md");
    const state = EditorState.create({
      doc: src,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM, ...ofmMarkdown] })],
    });
    const line = state.doc.line(3); // "- [ ] an open task"
    const m = TASK_RE.exec(line.text);
    expect(m, "TASK_RE must match the fixture's task line").not.toBeNull();
    // Toggle: replace "[ ]" with "[x]", the same span a checkbox widget edits.
    const markStart = line.from + m!.index + m![0].indexOf("[");
    const tr = state.update({
      changes: { from: markStart + 1, to: markStart + 2, insert: "x" },
    });
    const next = tr.state.doc.toString();
    expect(next).toBe(src.replace("- [ ] an open task", "- [x] an open task"));
    // And back again — the toggle is symmetric.
    const state2 = tr.state;
    const line2 = state2.doc.line(3);
    const m2 = TASK_RE.exec(line2.text)!;
    const ms2 = line2.from + m2.index + m2[0].indexOf("[");
    const back = state2.update({
      changes: { from: ms2 + 1, to: ms2 + 2, insert: " " },
    }).state.doc.toString();
    expect(back).toBe(src);
  });

  it("a frontmatter property edit replaces only that value's span", () => {
    const src = byName("01-frontmatter-typed.md");
    const doc = Text.of(src.split("\n"));
    const fm = findFrontmatter(doc);
    expect(fm, "fixture must have frontmatter").not.toBeNull();
    const parsed = parseFrontmatter(doc, fm!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const status = parsed.entries.find((e) => e.key === "status");
    expect(status, "status property must parse").toBeDefined();
    const changes = planSetValue(status!, { kind: "text", value: "published" });
    expect(changes).toHaveLength(1);
    const [c] = changes;
    const next = src.slice(0, c.from) + c.insert + src.slice(c.to);
    expect(next).toBe(src.replace("status: draft", "status: published"));
    // Everything else — including the typed values below — is untouched.
    expect(next).toContain("priority: 1");
    expect(next).toContain("tags: [planning, q4, \"multi word tag\"]");
  });
});

describe("external edit merge — no clobbering of concurrent work", () => {
  it("merges a local edit and an external edit to different regions", async () => {
    vi.useFakeTimers();
    try {
      const name = "17-kitchen-sink.md";
      const content = byName(name);
      const { io, fs } = makeHarness({ [name]: content });
      const bridge = await NoteBridge.open(io, { docId: "doc-kitchen", path: name });

      // Local edit near the top (retitle).
      bridge.edit((t) => {
        const i = t.toString().indexOf("Kitchen sink");
        t.delete(i, "Kitchen sink".length);
        t.insert(i, "Kitchen sink (edited locally)");
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(fs.get(name)).toBe(bridge.serialize());

      // External edit near the bottom (append a line), on the flushed file.
      const onDisk = fs.get(name)!;
      fs.externalWrite(name, onDisk + "\nAppended externally.\n");
      bridge.ingest();
      await vi.advanceTimersByTimeAsync(150);

      const converged = bridge.serialize();
      expect(converged).toContain("Kitchen sink (edited locally)");
      expect(converged).toContain("Appended externally.");
      // CRDT and file agree — nothing was clobbered.
      expect(converged).toBe(fs.get(name));
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CRDT convergence — identical Markdown on every client", () => {
  it("two replicas with concurrent edits converge to the same bytes", () => {
    const content = byName("17-kitchen-sink.md");
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    try {
      const textA = docA.getText("content");
      const textB = docB.getText("content");
      textA.insert(0, content);
      // Baseline sync: both replicas start from the same state.
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

      // Concurrent edits to different regions, before any sync.
      textA.insert(0, "<!-- replica A header -->\n");
      textB.insert(textB.length, "\n<!-- replica B footer -->\n");

      // Exchange deltas both ways.
      const svB = Y.encodeStateVector(docB);
      const svA = Y.encodeStateVector(docA);
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, svB));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, svA));

      const a = textA.toString();
      const b = textB.toString();
      expect(a).toBe(b);
      expect(a).toContain("<!-- replica A header -->");
      expect(a).toContain("<!-- replica B footer -->");
      expect(a).toContain("Kitchen sink");
    } finally {
      docA.destroy();
      docB.destroy();
    }
  });

  it("converges the ~1MB note without loss", () => {
    const content = byName("16-large-note.md");
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    try {
      const textA = docA.getText("content");
      const textB = docB.getText("content");
      // Split the seed: A takes the first half, B the second, then they sync.
      // (Both halves inserted concurrently at disjoint ranges.)
      const half = Math.floor(content.length / 2);
      textA.insert(0, content.slice(0, half));
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
      textB.insert(textB.length, content.slice(half));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
      // One more concurrent touch on each side.
      textA.insert(0, "A");
      textB.insert(textB.length, "B");
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
      const a = textA.toString();
      expect(a).toBe(textB.toString());
      expect(a).toContain(content.slice(0, 100));
      expect(a).toContain(content.slice(-100));
    } finally {
      docA.destroy();
      docB.destroy();
    }
  });
});

describe("note identity across rename/move", () => {
  /** Two bridges, same docId, different paths, one shared persistence store. */
  function twoPathHarness(first: string, second: string, content: string): {
    io1: BridgeIO; io2: BridgeIO; fs1: FakeFs; fs2: FakeFs;
  } {
    const fs1 = new FakeFs({ [first]: content });
    const fs2 = new FakeFs({ [second]: content });
    const persistence = new FakePersistence();
    const mk = (fs: FakeFs): BridgeIO => ({
      readFile: (p) => fs.readFile(p),
      writeFileAtomic: (p, c) => fs.writeFileAtomic(p, c),
      sha256: sha256Hex,
      persistence,
      onError: () => {},
    });
    return { io1: mk(fs1), io2: mk(fs2), fs1, fs2 };
  }

  it("keeps the same doc_id — a rename does not fork the note's CRDT state", async () => {
    const name = "17-kitchen-sink.md";
    const content = byName(name);
    const { io1, io2, fs2 } = twoPathHarness("notes/a.md", "notes/b.md", content);

    const before = await NoteBridge.open(io1, { docId: "doc-stable", path: "notes/a.md" });
    before.edit((t) => t.insert(t.toString().length, "\nEdit before rename.\n"));
    await before.flushEgest();
    const expected = before.serialize();
    before.destroy();

    // The file "moves" to notes/b.md carrying the edited bytes (what a rename
    // does on disk); the doc_id is unchanged.
    fs2.externalWrite("notes/b.md", expected);
    const after = await NoteBridge.open(io2, { docId: "doc-stable", path: "notes/b.md" });
    expect(after.serialize()).toBe(expected);
    expect(after.docId).toBe("doc-stable");
    after.destroy();
  });
});

describe.skip("rename/move link propagation (pending — no implementation yet)", () => {
  // NEXT.md requires: "Rename and move preserve links and stable note
  // identity." The identity half is tested above. The link-rewriting half
  // has no production implementation to test against yet — titlePlan.ts
  // plans the rename itself, but nothing rewrites wikilinks in other notes.
  // Un-skip when that implementation lands; it must then assert that every
  // [[Old]] / [[Old#H]] / [[Old#^b]] reference in the corpus-style fixtures
  // is rewritten with an explicit preview.
  it.todo("rewrites [[Old Name]] links when the target note is renamed");
});
