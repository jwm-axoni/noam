import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS_FILE,
  AGENTS_MD,
  CLAUDE_FILE,
  CLAUDE_MD,
  answerGuide,
  dismissGuideForever,
  isGuideAnswered,
  isGuideDismissed,
  planAgentGuide,
  resetGuideSession,
  writeAgentGuide,
} from "./agentGuide";

const base = { agentsExists: false, claudeExists: false, rootFrozen: false, dismissed: false };

describe("planAgentGuide", () => {
  it("offers both files in a vault that has neither", () => {
    expect(planAgentGuide(base)).toEqual({
      offer: true,
      files: [AGENTS_FILE, CLAUDE_FILE],
      claudeLeftAlone: false,
    });
  });

  it("never offers to create a CLAUDE.md the user already has", () => {
    const plan = planAgentGuide({ ...base, claudeExists: true });
    expect(plan.files).toEqual([AGENTS_FILE]);
    expect(plan.claudeLeftAlone).toBe(true);
  });

  it("stays quiet when AGENTS.md exists, the root is frozen, or the user answered", () => {
    expect(planAgentGuide({ ...base, agentsExists: true }).offer).toBe(false);
    expect(planAgentGuide({ ...base, rootFrozen: true }).offer).toBe(false);
    expect(planAgentGuide({ ...base, dismissed: true }).offer).toBe(false);
  });
});

describe("writeAgentGuide", () => {
  it("writes create-only and reports only what it created", async () => {
    const onDisk = new Map<string, string>([[CLAUDE_FILE, "mine"]]);
    const write = vi.fn(async (path: string, content: string) => {
      if (onDisk.has(path)) return false;
      onDisk.set(path, content);
      return true;
    });
    const created = await writeAgentGuide([AGENTS_FILE, CLAUDE_FILE], 7, write);
    expect(created).toEqual([AGENTS_FILE]);
    expect(onDisk.get(CLAUDE_FILE)).toBe("mine");
    expect(onDisk.get(AGENTS_FILE)).toBe(AGENTS_MD);
    expect(write).toHaveBeenCalledWith(AGENTS_FILE, AGENTS_MD, 7);
  });

  it("ignores a file name it has no content for", async () => {
    const write = vi.fn(async () => true);
    expect(await writeAgentGuide(["notes.md"], 1, write)).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("the guide's content", () => {
  it("tells agents to keep out of .context/", () => {
    expect(AGENTS_MD).toContain("Never touch `.context/`");
  });

  it("makes Claude Code import AGENTS.md", () => {
    expect(CLAUDE_MD).toContain("@AGENTS.md");
  });
});

describe("answers", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    resetGuideSession();
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("'Not now' lasts for the session only", () => {
    answerGuide("/v/a");
    expect(isGuideAnswered("/v/a")).toBe(true);
    expect(isGuideDismissed("/v/a")).toBe(false);
    resetGuideSession();
    expect(isGuideAnswered("/v/a")).toBe(false);
  });

  it("'Don't ask again' persists per vault", () => {
    dismissGuideForever("/v/a");
    expect(isGuideDismissed("/v/a")).toBe(true);
    expect(isGuideDismissed("/v/b")).toBe(false);
  });

  it("treats unusable storage as not dismissed", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(isGuideDismissed("/v/a")).toBe(false);
    expect(() => dismissGuideForever("/v/a")).not.toThrow();
  });
});
