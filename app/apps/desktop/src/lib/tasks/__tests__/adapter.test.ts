// The write path, with IPC, the store and the active-note registry mocked.
// What is under test is the ROUTING: which text a task is resolved against,
// which write path it takes, and — the one that matters most — that a stale
// revision never reaches a write.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const ipcMock = vi.hoisted(() => ({
  readNote: vi.fn<(path: string, epoch?: unknown) => Promise<string>>(),
  writeNote: vi.fn<(path: string, content: string, epoch?: unknown) => Promise<void>>(),
  writeNoteIfUnchanged:
    vi.fn<
      (path: string, expected: string, content: string, epoch?: unknown) =>
        Promise<{ ok: boolean; currentSha256: string }>
    >(),
  getNoteMeta: vi.fn<(path: string, epoch?: unknown) => Promise<{ id: string } | null>>(),
}));

const storeState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const activeNote = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../../ipc", () => ipcMock);
vi.mock("../../../store", () => ({ useStore: { getState: () => storeState.current } }));
vi.mock("../../editor/activeView", () => ({
  getActiveNote: () => activeNote.value,
  insertIntoActiveNote: vi.fn(() => true),
}));
vi.mock("../../locks", () => ({
  lockScopesByPath: () => new Map<string, string>(Object.entries(storeState.current.lockMap ?? {})),
  effectiveLockForPath: (map: Map<string, string>, path: string) => map.get(path) ?? null,
}));

const { applyTaskEdit, editTask, resolveTask } = await import("../adapter");
const { planSetStatus } = await import("../edit");
const { parseTasks } = await import("../parse");

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const NOTE = [
  "# Today",
  "- [ ] Buy milk 📅 2026-03-09",
  "- [ ] Stamped ^t-k3x9f2a0b1",
  "- [ ] Twin",
  "- [ ] Twin",
].join("\n");

function fakeView(text: string, readOnly = false) {
  const dispatched: Array<Array<{ from: number; to: number; insert: string }>> = [];
  const view = {
    state: { doc: { toString: () => text, length: text.length }, readOnly },
    dispatch: (tr: { changes: Array<{ from: number; to: number; insert: string }> }) => {
      dispatched.push(tr.changes);
      let next = text;
      for (const change of [...tr.changes].reverse()) {
        next = next.slice(0, change.from) + change.insert + next.slice(change.to);
      }
      text = next;
      view.state.doc.toString = () => text;
      view.state.doc.length = text.length;
    },
  };
  return { view, dispatched, current: () => text };
}

const ref = (index: number, over = {}) => {
  const task = parseTasks(NOTE, "doc-1", "Today.md")[index]!;
  return { path: task.path, docId: task.docId, id: task.id, line: task.line, sourceText: task.sourceText, ...over };
};

beforeEach(() => {
  vi.clearAllMocks();
  activeNote.value = null;
  storeState.current = { syncEnabled: false, vault: { epoch: 7 } };
  ipcMock.readNote.mockResolvedValue(NOTE);
  ipcMock.getNoteMeta.mockResolvedValue({ id: "doc-1" });
  ipcMock.writeNote.mockResolvedValue(undefined);
  ipcMock.writeNoteIfUnchanged.mockResolvedValue({ ok: true, currentSha256: "" });
});

describe("resolveTask", () => {
  it("reads a closed note from disk and recomputes the span", async () => {
    const result = await resolveTask(ref(0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(NOTE.slice(result.resolved.from, result.resolved.to)).toBe(result.resolved.sourceText);
    expect(result.resolved.task.due).toBe("2026-03-09");
    expect(result.resolved.revision).toBe(sha(NOTE));
    expect(ipcMock.readNote).toHaveBeenCalledWith("Today.md", 7);
  });

  it("prefers live text over the file when the note is open", async () => {
    const live = NOTE.replace("- [ ] Buy milk 📅 2026-03-09", "- [ ] Buy oat milk 📅 2026-03-09 ^t-aaaaaaaaaa");
    activeNote.value = { path: "Today.md", editorView: fakeView(live).view };
    const result = await resolveTask(ref(1)); // by id, line hint is wrong
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.sourceText).toBe("- [ ] Stamped ^t-k3x9f2a0b1");
    expect(live.slice(result.resolved.from, result.resolved.to)).toBe(result.resolved.sourceText);
    expect(result.resolved.revision).toBe(sha(live));
    expect(ipcMock.readNote).not.toHaveBeenCalled();
  });

  it("finds a task by id after its text changed and it moved", async () => {
    const moved = ["- [x] Stamped, edited, moved ⏫ ^t-k3x9f2a0b1", "# Today", "- [ ] Buy milk"].join("\n");
    ipcMock.readNote.mockResolvedValue(moved);
    const result = await resolveTask(ref(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.from).toBe(0);
    expect(result.resolved.task.status).toBe("done");
    expect(result.resolved.task.priority).toBe("highest");
  });

  it("refuses two lines that answer to the same id", async () => {
    ipcMock.readNote.mockResolvedValue(`${NOTE}\n- [ ] Copy ^t-k3x9f2a0b1`);
    const result = await resolveTask(ref(1));
    expect(result).toMatchObject({ ok: false, kind: "ambiguous-target", matches: 2 });
  });

  it("refuses two identical un-stamped lines rather than picking one", async () => {
    const result = await resolveTask(ref(3));
    expect(result).toMatchObject({ ok: false, kind: "ambiguous-target", matches: 2 });
  });

  it("reports a missing line and a missing note", async () => {
    ipcMock.readNote.mockResolvedValue("# Today\n");
    expect(await resolveTask(ref(0))).toMatchObject({ ok: false, kind: "missing-target" });
    ipcMock.readNote.mockRejectedValue(new Error("gone"));
    expect(await resolveTask(ref(0))).toMatchObject({ ok: false, kind: "missing-target" });
  });

  it("reports a line that is no longer a task as stale", async () => {
    ipcMock.readNote.mockResolvedValue("Buy milk, now just prose ^t-k3x9f2a0b1\n");
    expect(await resolveTask(ref(1))).toMatchObject({ ok: false, kind: "stale-target" });
  });

  it("refuses to resolve at all in a read-only note", async () => {
    // The sync verdict belongs to the OPEN note only (workflows/adapter.ts).
    storeState.current = {
      syncEnabled: true,
      syncStatus: "read-only",
      openNote: { path: "Today.md" },
      vault: { epoch: 7 },
    };
    expect(await resolveTask(ref(0))).toMatchObject({ ok: false, kind: "read-only" });
    storeState.current = {
      syncEnabled: true,
      syncStatus: "synced",
      lockMap: { "Today.md": "locked" },
      vault: { epoch: 7 },
    };
    expect(await resolveTask(ref(0))).toMatchObject({ ok: false, kind: "read-only" });
    expect(ipcMock.readNote).not.toHaveBeenCalled();
  });
});

describe("applyTaskEdit", () => {
  const resolveFirst = async () => {
    const result = await resolveTask(ref(0));
    if (!result.ok) throw new Error(result.message);
    return result.resolved;
  };

  it("writes an open note as ONE transaction through the live view", async () => {
    const live = fakeView(NOTE);
    activeNote.value = { path: "Today.md", editorView: live.view };
    const resolved = await resolveFirst();
    const changes = [
      ...planSetStatus(resolved.task, "done"),
      { from: resolved.to, to: resolved.to, insert: " ^t-0000000001" },
    ];
    const result = await applyTaskEdit(resolved, changes);
    expect(result).toEqual({ ok: true, revision: sha(live.current()) });
    expect(live.dispatched).toHaveLength(1);
    expect(live.dispatched[0]).toHaveLength(2);
    expect(live.current().split("\n")[1]).toBe("- [x] Buy milk 📅 2026-03-09 ^t-0000000001");
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });

  it("writes a closed note through the guarded note-write path", async () => {
    const resolved = await resolveFirst();
    const result = await applyTaskEdit(resolved, planSetStatus(resolved.task, "done"));
    expect(result.ok).toBe(true);
    // The conditional write, never the plain one: compare-then-write in two
    // calls is a window an external writer fits into.
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
    const [path, expected, content, epoch] = ipcMock.writeNoteIfUnchanged.mock.calls[0]!;
    expect(path).toBe("Today.md");
    expect(expected).toBe(resolved.revision);
    expect(epoch).toBe(7);
    expect(content.split("\n")[1]).toBe("- [x] Buy milk 📅 2026-03-09");
    expect(content.slice(0, resolved.from)).toBe(NOTE.slice(0, resolved.from));
  });

  it("a write Rust refused is stale, and is never retried", async () => {
    const resolved = await resolveFirst();
    ipcMock.writeNoteIfUnchanged.mockResolvedValue({ ok: false, currentSha256: sha("theirs\n") });
    const result = await applyTaskEdit(resolved, planSetStatus(resolved.task, "done"));
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(ipcMock.writeNoteIfUnchanged).toHaveBeenCalledTimes(1);
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });

  it("stale revision ⇒ no write, open note", async () => {
    const live = fakeView(NOTE);
    activeNote.value = { path: "Today.md", editorView: live.view };
    const resolved = await resolveFirst();
    live.view.dispatch({ changes: [{ from: 0, to: 0, insert: "someone else typed\n" }] });
    const before = live.current();
    const result = await applyTaskEdit(resolved, planSetStatus(resolved.task, "done"));
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(live.current()).toBe(before);
    expect(live.dispatched).toHaveLength(1); // only the "other" edit
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });

  it("stale revision ⇒ no write, closed note", async () => {
    const resolved = await resolveFirst();
    ipcMock.readNote.mockResolvedValue(`someone else typed\n${NOTE}`);
    const result = await applyTaskEdit(resolved, planSetStatus(resolved.task, "done"));
    expect(result).toMatchObject({ ok: false, kind: "stale-target" });
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
    expect(ipcMock.writeNoteIfUnchanged).not.toHaveBeenCalled();
  });

  it("never writes to a read-only note, even with a fresh revision", async () => {
    const resolved = await resolveFirst();
    storeState.current = { syncEnabled: true, syncStatus: "read-only", openNote: { path: "Today.md" }, vault: { epoch: 7 } };
    expect(await applyTaskEdit(resolved, planSetStatus(resolved.task, "done"))).toMatchObject({
      ok: false,
      kind: "read-only",
    });
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });

  it("never writes through a read-only editor view", async () => {
    const live = fakeView(NOTE, true);
    const resolved = await resolveFirst();
    activeNote.value = { path: "Today.md", editorView: live.view };
    expect(await applyTaskEdit(resolved, planSetStatus(resolved.task, "done"))).toMatchObject({
      ok: false,
      kind: "read-only",
    });
    expect(live.dispatched).toHaveLength(0);
  });

  it("does nothing at all for an empty plan", async () => {
    const resolved = await resolveFirst();
    expect(await applyTaskEdit(resolved, [])).toEqual({ ok: true, revision: resolved.revision });
    expect(ipcMock.writeNote).not.toHaveBeenCalled();
  });
});

describe("editTask", () => {
  it("resolves against live text and passes the LIVE task to the planner", async () => {
    const live = NOTE.replace("- [ ] Stamped ^t-k3x9f2a0b1", "- [ ] Stamped 📅 2026-04-01 ^t-k3x9f2a0b1");
    const view = fakeView(live);
    activeNote.value = { path: "Today.md", editorView: view.view };
    const seen: Array<string | null> = [];
    const result = await editTask(ref(1), (resolved) => {
      seen.push(resolved.task.due);
      return planSetStatus(resolved.task, "done");
    });
    expect(result.ok).toBe(true);
    // The planner never saw the indexed line: the date was added by somebody
    // else after this task was indexed.
    expect(seen).toEqual(["2026-04-01"]);
    expect(view.current().split("\n")[2]).toBe("- [x] Stamped 📅 2026-04-01 ^t-k3x9f2a0b1");
  });

  it("cannot re-find an un-stamped line that was edited — which is why the first edit stamps one", async () => {
    ipcMock.readNote.mockResolvedValue(NOTE.replace("Buy milk", "Buy oat milk"));
    expect(await editTask(ref(0), () => [])).toMatchObject({ ok: false, kind: "missing-target" });
  });

  it("passes a resolution failure straight through", async () => {
    ipcMock.readNote.mockResolvedValue("# Today\n");
    expect(await editTask(ref(0), () => [])).toMatchObject({ ok: false, kind: "missing-target" });
  });
});
