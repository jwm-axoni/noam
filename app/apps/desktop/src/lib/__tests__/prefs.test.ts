// The Content width preference, and in particular its MIGRATION — the one part
// of that change that can silently hand an existing user the wrong layout.
//
// `prefs` reads `localStorage` at call time, never at import time, so a plain
// object stub on `globalThis` is enough in the node environment.
import { afterEach, describe, expect, it } from "vitest";
import {
  clampEditorMeasure,
  EDITOR_MEASURE_DEFAULT,
  EDITOR_MEASURE_MAX,
  EDITOR_MEASURE_MIN,
  ACCENT_THEMES,
  DEFAULT_ACCENT_THEME,
  readAccentTheme,
  readHeadingColorMode,
  readDefaultViewMode,
  migrateEditorMeasureDefault,
  readEditorMeasure,
  readEditorNormalMeasure,
  readPropertiesCollapsed,
  remapPropertiesCollapsed,
  setAccentTheme,
  setHeadingColorMode,
  writeDefaultViewMode,
  writeEditorMeasure,
  writeEditorNormalMeasure,
  writePropertiesCollapsed,
} from "../prefs";

const NEW_KEY = "context.editorMeasure";
const LEGACY_KEY = "context.readableLineLength";
const VIEW_MODE_KEY = "context.defaultViewMode";
const HEADING_COLOR_KEY = "context.headingColor";
const ACCENT_THEME_KEY = "context.accentTheme";
const PROPERTIES_COLLAPSED_KEY = "context.propertiesCollapsed";

/** The two methods `prefs` uses, over a plain map. */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

/** A device with storage denied: every access throws. */
function stubThrowingStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("localStorage is not available");
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("default view mode", () => {
  it("defaults to Live Preview and accepts every explicit mode", () => {
    stubStorage();
    expect(readDefaultViewMode()).toBe("live");
    for (const mode of ["live", "source", "reading"] as const) {
      writeDefaultViewMode(mode);
      expect(readDefaultViewMode()).toBe(mode);
    }
  });

  it("falls back to Live Preview for corrupt or unavailable storage", () => {
    stubStorage({ [VIEW_MODE_KEY]: "preview-ish" });
    expect(readDefaultViewMode()).toBe("live");
    stubThrowingStorage();
    expect(readDefaultViewMode()).toBe("live");
    expect(() => writeDefaultViewMode("reading")).not.toThrow();
  });
});

describe("accent theme", () => {
  it("defaults to the brand world and round-trips every option", () => {
    const store = stubStorage();
    expect(DEFAULT_ACCENT_THEME).toBe("ink");
    expect(readAccentTheme()).toBe("ink");
    for (const theme of ACCENT_THEMES) {
      setAccentTheme(theme.id);
      expect(store.get(ACCENT_THEME_KEY)).toBe(theme.id);
      expect(readAccentTheme()).toBe(theme.id);
    }
  });

  it("stamps data-accent on the root when a document exists", () => {
    stubStorage();
    const dataset: Record<string, string> = {};
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset } },
    });
    try {
      setAccentTheme("sea");
      expect(dataset.accent).toBe("sea");
    } finally {
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("falls back to the brand world for corrupt or unavailable storage", () => {
    stubStorage({ [ACCENT_THEME_KEY]: "purple" });
    expect(readAccentTheme()).toBe("ink");
    stubThrowingStorage();
    expect(readAccentTheme()).toBe("ink");
    expect(() => setAccentTheme("moss")).not.toThrow();
  });
});

describe("heading colour", () => {
  it("defaults to themed and round-trips both choices", () => {
    const store = stubStorage();
    expect(readHeadingColorMode()).toBe("themed");

    setHeadingColorMode("plain");
    expect(store.get(HEADING_COLOR_KEY)).toBe("plain");
    expect(readHeadingColorMode()).toBe("plain");

    setHeadingColorMode("themed");
    expect(store.get(HEADING_COLOR_KEY)).toBe("themed");
    expect(readHeadingColorMode()).toBe("themed");
  });

  it("falls back to themed for corrupt or unavailable storage", () => {
    stubStorage({ [HEADING_COLOR_KEY]: "rainbow" });
    expect(readHeadingColorMode()).toBe("themed");
    stubThrowingStorage();
    expect(readHeadingColorMode()).toBe("themed");
    expect(() => setHeadingColorMode("plain")).not.toThrow();
  });
});

describe("per-note Properties collapse", () => {
  it("keeps the same relative note path independent across vaults and reloads", () => {
    const store = stubStorage();
    expect(readPropertiesCollapsed("vault-a", "Notes/One.md")).toBe(false);

    writePropertiesCollapsed("vault-a", "Notes/One.md", true);
    stubStorage(Object.fromEntries(store));
    expect(readPropertiesCollapsed("vault-b", "Notes/One.md")).toBe(false);
    expect(readPropertiesCollapsed("vault-a", "notes/one.md")).toBe(true);
    expect(readPropertiesCollapsed("vault-a", "Notes/Two.md")).toBe(false);

    writePropertiesCollapsed("vault-a", "Notes/One.md", false);
    expect(readPropertiesCollapsed("vault-a", "Notes/One.md")).toBe(false);
  });

  it("migrates the legacy flat map into the current vault only", () => {
    const store = stubStorage({
      [PROPERTIES_COLLAPSED_KEY]: JSON.stringify({ "notes/one.md": true }),
    });

    expect(readPropertiesCollapsed("vault-a", "Notes/One.md")).toBe(true);
    expect(readPropertiesCollapsed("vault-b", "Notes/One.md")).toBe(false);
    expect(JSON.parse(store.get(PROPERTIES_COLLAPSED_KEY)!)).toEqual({
      version: 3,
      vaults: { "vault-a": { "notes/one.md": true } },
      docs: {},
    });
  });

  it("keeps document state through note and ancestor renames, reloads, and path reuse", () => {
    const store = stubStorage();
    writePropertiesCollapsed("vault-a", "Notes/One.md", true, "doc-1");
    expect(readPropertiesCollapsed("vault-a", "Notes/Renamed.md", "doc-1")).toBe(true);
    stubStorage(Object.fromEntries(store));
    expect(readPropertiesCollapsed("vault-a", "Moved/Renamed.md", "doc-1")).toBe(true);
    expect(readPropertiesCollapsed("vault-b", "Moved/Renamed.md", "doc-1")).toBe(false);
    expect(readPropertiesCollapsed("vault-a", "Notes/One.md", "doc-2")).toBe(false);
    expect(JSON.parse(store.get(PROPERTIES_COLLAPSED_KEY)!).vaults).toEqual({});
  });

  it.each(["flat", "v2"])("remaps unopened %s path entries before migrating them once", (format) => {
    const paths = { "notes/one.md": true, "notes/sub/two.md": true, "notes-other/three.md": true };
    const store = stubStorage({
      [PROPERTIES_COLLAPSED_KEY]: JSON.stringify(format === "flat" ? paths : {
        version: 2, vaults: { "vault-a": paths, "vault-b": { "notes/one.md": true } },
      }),
    });
    remapPropertiesCollapsed("vault-a", "Notes/One.md", "Notes/Renamed.md");
    remapPropertiesCollapsed("vault-a", "Notes", "Moved");
    const saved = JSON.parse(store.get(PROPERTIES_COLLAPSED_KEY)!);
    expect(saved.vaults["vault-a"]).toEqual({
      "moved/renamed.md": true, "moved/sub/two.md": true, "notes-other/three.md": true,
    });
    if (format === "v2") expect(saved.vaults["vault-b"]).toEqual({ "notes/one.md": true });
    const reloaded = stubStorage(Object.fromEntries(store));
    expect(readPropertiesCollapsed("vault-a", "Moved/Renamed.md", "doc-1")).toBe(true);
    expect(readPropertiesCollapsed("vault-a", "Moved/Sub/Two.md", "doc-2")).toBe(true);
    expect(readPropertiesCollapsed("vault-b", "Moved/Renamed.md", "doc-1")).toBe(false);
    expect(JSON.parse(reloaded.get(PROPERTIES_COLLAPSED_KEY)!).vaults["vault-a"]).toEqual({
      "notes-other/three.md": true,
    });
    writePropertiesCollapsed("vault-a", "Moved/Renamed.md", false, "doc-1");
    expect(readPropertiesCollapsed("vault-a", "Moved/Renamed.md", "doc-1")).toBe(false);
  });

  it("discards a stale path entry without overwriting a newer expanded document state", () => {
    const store = stubStorage({
      [PROPERTIES_COLLAPSED_KEY]: JSON.stringify({
        version: 3,
        vaults: { "vault-a": { "old/one.md": true } },
        docs: { "vault-a": { "doc-1": false } },
      }),
    });
    remapPropertiesCollapsed("vault-a", "Old", "New");
    expect(readPropertiesCollapsed("vault-a", "New/One.md", "doc-1")).toBe(false);
    expect(JSON.parse(store.get(PROPERTIES_COLLAPSED_KEY)!)).toEqual({
      version: 3, vaults: {}, docs: { "vault-a": { "doc-1": false } },
    });
  });

  it("consumes a legacy entry on an explicit write and never restores it after reload", () => {
    const store = stubStorage({
      [PROPERTIES_COLLAPSED_KEY]: JSON.stringify({ "notes/one.md": true }),
    });
    writePropertiesCollapsed("vault-a", "Notes/One.md", false, "doc-1");
    stubStorage(Object.fromEntries(store));
    expect(readPropertiesCollapsed("vault-a", "Renamed.md", "doc-1")).toBe(false);
    expect(readPropertiesCollapsed("vault-b", "Notes/One.md", "doc-1")).toBe(false);
    expect(JSON.parse(store.get(PROPERTIES_COLLAPSED_KEY)!).vaults).toEqual({});
  });

  it("falls back to expanded for corrupt or unavailable storage", () => {
    stubStorage({ [PROPERTIES_COLLAPSED_KEY]: "not json" });
    expect(readPropertiesCollapsed("vault-a", "Notes/One.md")).toBe(false);
    expect(() =>
      writePropertiesCollapsed("vault-a", "Notes/One.md", true),
    ).not.toThrow();

    stubThrowingStorage();
    expect(readPropertiesCollapsed("vault-a", "Notes/One.md")).toBe(false);
    expect(() =>
      writePropertiesCollapsed("vault-a", "Notes/One.md", true),
    ).not.toThrow();
  });
});

describe("readEditorMeasure — migration from the old switch", () => {
  it("reads the old off switch as full width", () => {
    stubStorage({ [LEGACY_KEY]: "off" });
    expect(readEditorMeasure()).toBe("full");
  });

  it("reads every other legacy value as the readable measure", () => {
    for (const legacy of ["on", "", "true", "yes"]) {
      stubStorage({ [LEGACY_KEY]: legacy });
      expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    }
  });

  it("defaults on a device that has never had either key", () => {
    stubStorage();
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
  });

  it("ignores the legacy key entirely once the new one exists", () => {
    // The migration must not un-set a choice the user has since made.
    stubStorage({ [LEGACY_KEY]: "off", [NEW_KEY]: "72" });
    expect(readEditorMeasure()).toBe(72);
    stubStorage({ [LEGACY_KEY]: "on", [NEW_KEY]: "full" });
    expect(readEditorMeasure()).toBe("full");
  });
});

describe("migrateEditorMeasureDefault", () => {
  it("moves a device still on the old 88ch default to the new one, once", () => {
    const store = stubStorage({ [NEW_KEY]: "88" });
    migrateEditorMeasureDefault();
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    // A later deliberate 88 survives: the migration has already run.
    writeEditorMeasure(88);
    migrateEditorMeasureDefault();
    expect(readEditorMeasure()).toBe(88);
    expect(store.get(NEW_KEY)).toBe("88");
  });

  it("leaves any other stored width alone", () => {
    for (const raw of ["full", "100", "60"]) {
      stubStorage({ [NEW_KEY]: raw });
      migrateEditorMeasureDefault();
      expect(String(readEditorMeasure())).toBe(raw);
    }
  });
});

describe("the normal width the Wide toggle returns to", () => {
  it("defaults to the readable measure", () => {
    stubStorage();
    expect(readEditorNormalMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
  });

  it("remembers the last non-full width", () => {
    stubStorage();
    writeEditorNormalMeasure(100);
    expect(readEditorNormalMeasure()).toBe(100);
  });
});

describe("readEditorMeasure — stored values", () => {
  it("round-trips both shapes through the writer", () => {
    const store = stubStorage();
    writeEditorMeasure("full");
    expect(readEditorMeasure()).toBe("full");
    writeEditorMeasure(88);
    // The bare number, not "88ch": the `ch` belongs to the CSS, not the store.
    expect(store.get(NEW_KEY)).toBe("88");
    expect(readEditorMeasure()).toBe(88);
  });

  it("never writes the legacy key again", () => {
    const store = stubStorage({ [LEGACY_KEY]: "off" });
    writeEditorMeasure(100);
    expect(store.get(LEGACY_KEY)).toBe("off");
    expect(readEditorMeasure()).toBe(100);
  });

  it("treats a blank or unreadable stored value as corruption, not as a request", () => {
    for (const raw of ["", "   ", "abc"]) {
      stubStorage({ [NEW_KEY]: raw });
      expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    }
  });

  it("clamps a stored value from outside the range", () => {
    stubStorage({ [NEW_KEY]: "9000" });
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_MAX);
    stubStorage({ [NEW_KEY]: "4" });
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_MIN);
  });

  it("falls back to the default when storage itself throws", () => {
    stubThrowingStorage();
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    // …and a write on such a device is a no-op rather than a crash.
    expect(() => writeEditorMeasure("full")).not.toThrow();
  });
});

describe("clampEditorMeasure", () => {
  it("snaps to the step and pins to the range", () => {
    expect(clampEditorMeasure(59)).toBe(60);
    expect(clampEditorMeasure(61)).toBe(60);
    expect(clampEditorMeasure(122)).toBe(EDITOR_MEASURE_MAX);
    expect(clampEditorMeasure(-5)).toBe(EDITOR_MEASURE_MIN);
  });

  it("answers NaN with the default, and the infinities with the bounds", () => {
    expect(clampEditorMeasure(Number.NaN)).toBe(EDITOR_MEASURE_DEFAULT);
    expect(clampEditorMeasure(Number.POSITIVE_INFINITY)).toBe(EDITOR_MEASURE_MAX);
    expect(clampEditorMeasure(Number.NEGATIVE_INFINITY)).toBe(EDITOR_MEASURE_MIN);
  });
});
