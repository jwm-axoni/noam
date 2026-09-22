// Account-level, device-local preferences that follow the app rather than any
// one vault: the user's activity status and the mention chime. Persisted in
// localStorage (device-local, like the theme). Profile fields (display name,
// avatar) are NOT here — those are server-backed via Better Auth so they follow
// the account across devices; see `ApiClient.updateUser`.

import type { ServerChoice } from "./auth/serverChoice";
import type { PropertiesMode } from "./editor/frontmatter";
import type { ViewMode } from "./editor/viewMode";
import type { TreeSort } from "./tree/sort";

export type ActivityStatus = "online" | "away" | "busy" | "invisible";

export const ACTIVITY_STATUSES: Array<{
  id: ActivityStatus;
  label: string;
  hint: string;
}> = [
  { id: "online", label: "Online", hint: "Active and available" },
  { id: "away", label: "Away", hint: "Not at the keyboard right now" },
  { id: "busy", label: "Busy", hint: "Please do not disturb" },
  { id: "invisible", label: "Invisible", hint: "Appear offline to teammates" },
];

const STATUS_KEY = "context.activityStatus";
const MENTION_SOUND_KEY = "context.mentionSound";

function isActivityStatus(v: unknown): v is ActivityStatus {
  return v === "online" || v === "away" || v === "busy" || v === "invisible";
}

export function readActivityStatus(): ActivityStatus {
  try {
    const v = localStorage.getItem(STATUS_KEY);
    return isActivityStatus(v) ? v : "online";
  } catch {
    return "online";
  }
}

export function writeActivityStatus(status: ActivityStatus): void {
  try {
    localStorage.setItem(STATUS_KEY, status);
  } catch {
    /* localStorage unavailable — status stays in-memory only */
  }
}

/** The mention chime is on by default; only an explicit opt-out disables it. */
export function readMentionSound(): boolean {
  try {
    return localStorage.getItem(MENTION_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeMentionSound(enabled: boolean): void {
  try {
    localStorage.setItem(MENTION_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    /* localStorage unavailable — preference stays in-memory only */
  }
}

// ---- Note heading colour ---------------------------------------------------

export type HeadingColorMode = "themed" | "plain";

const HEADING_COLOR_KEY = "context.headingColor";

/** Distinct theme colours are the default; only an explicit opt-out is plain. */
export function readHeadingColorMode(): HeadingColorMode {
  try {
    return localStorage.getItem(HEADING_COLOR_KEY) === "plain" ? "plain" : "themed";
  } catch {
    return "themed";
  }
}

function paintHeadingColor(mode: HeadingColorMode): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.headingColor = mode;
  }
}

/** Persist and apply the device-local heading palette. */
export function setHeadingColorMode(mode: HeadingColorMode): void {
  try {
    localStorage.setItem(HEADING_COLOR_KEY, mode);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
  paintHeadingColor(mode);
}

/** Paint the saved choice before React's first frame. */
export function initHeadingColor(): void {
  paintHeadingColor(readHeadingColorMode());
}

// ---- Accent theme -----------------------------------------------------------

/**
 * The colour world the chrome is painted in: the accent family, the surfaces
 * it sits on and everything derived from either (selection, links, focus,
 * heading inks, graph nodes). A fixed set, never a picker — each one is a
 * hand-tuned token block on `[data-accent]` in `styles/tokens.css`, measured
 * for AA contrast in light AND dark. Device-local like the theme.
 *
 * "ink" is the brand world (Paper & Ink) and the default; "violet" is the
 * original palette, kept as an option and pixel-identical to what it replaced.
 * The app icon and the in-app logo never follow this choice.
 */
export type AccentTheme = "ink" | "violet" | "sea" | "terracotta" | "moss";

export const DEFAULT_ACCENT_THEME: AccentTheme = "ink";

export const ACCENT_THEMES: ReadonlyArray<{
  id: AccentTheme;
  label: string;
  hint: string;
}> = [
  { id: "ink", label: "Ink", hint: "Charcoal and pencil on paper" },
  { id: "violet", label: "Violet", hint: "Violet on cool grey" },
  { id: "sea", label: "Sea", hint: "Teal on cool white" },
  { id: "terracotta", label: "Terracotta", hint: "Terracotta and ochre on sand" },
  { id: "moss", label: "Moss", hint: "Forest green on cream" },
];

const ACCENT_THEME_KEY = "context.accentTheme";

export function isAccentTheme(v: unknown): v is AccentTheme {
  return ACCENT_THEMES.some((t) => t.id === v);
}

/** An absent, corrupt or unreadable value is the brand world. */
export function readAccentTheme(): AccentTheme {
  try {
    const v = localStorage.getItem(ACCENT_THEME_KEY);
    return isAccentTheme(v) ? v : DEFAULT_ACCENT_THEME;
  } catch {
    return DEFAULT_ACCENT_THEME;
  }
}

/** Stamp `data-accent` next to `data-theme`; tokens.css does the rest. */
function paintAccentTheme(theme: AccentTheme): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.accent = theme;
  }
}

/** Persist and apply the device-local accent world. */
export function setAccentTheme(theme: AccentTheme): void {
  try {
    localStorage.setItem(ACCENT_THEME_KEY, theme);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
  paintAccentTheme(theme);
}

/** Paint the saved world before React's first frame, like the theme. */
export function initAccentTheme(): void {
  paintAccentTheme(readAccentTheme());
}

// ---- Which server this device's account lives on -----------------------------

const SERVER_CHOICE_KEY = "context.serverChoice";

/**
 * Whether this device has picked its Noam server — asked once, on the first
 * sign-in this device ever sees (see `lib/auth/serverChoice.ts`). Every user
 * self-hosts, so the only value written now is "custom"; the legacy "managed"
 * is still accepted when reading an older device's config.
 *
 * Device-local like the theme, and deliberately NOT the server URL itself: that
 * lives in the Rust app config, because the auth manager needs it before any
 * localStorage-backed UI exists. This only records whether the question has
 * been answered, so the step stops appearing once it has.
 *
 * An absent or corrupted value reads as `null` — "never asked" — which is the
 * safe direction: the worst case is asking a question again, never silently
 * signing someone up on the wrong server.
 */
export function readServerChoice(): ServerChoice | null {
  try {
    const v = localStorage.getItem(SERVER_CHOICE_KEY);
    return v === "managed" || v === "custom" ? v : null;
  } catch {
    return null;
  }
}

export function writeServerChoice(choice: ServerChoice): void {
  try {
    localStorage.setItem(SERVER_CHOICE_KEY, choice);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

// ---- Sidebar sort -----------------------------------------------------------

const TREE_SORT_KEY = "context.treeSort";

/**
 * How the sidebar arranges what the user hasn't arranged by hand. Device-level
 * rather than per-vault (unlike item order/colors, which describe one vault's
 * contents): this is a habit about how you read a sidebar, and having it flip
 * as you switch vaults would be its own surprise.
 *
 * Defaults to "recent" — a second brain is mostly read from the top, and the
 * note you want is nearly always one you touched lately.
 */
export function readTreeSort(): TreeSort {
  try {
    const v = localStorage.getItem(TREE_SORT_KEY);
    return v === "name" || v === "recent" ? v : "recent";
  } catch {
    return "recent";
  }
}

export function writeTreeSort(sort: TreeSort): void {
  try {
    localStorage.setItem(TREE_SORT_KEY, sort);
  } catch {
    /* localStorage unavailable — the sort stays in-memory only */
  }
}

// ---- Properties in document -------------------------------------------------

const PROPERTIES_MODE_KEY = "context.propertiesMode";

/**
 * How YAML frontmatter is drawn in the editor: as a Properties panel, as plain
 * source, or not at all. Device-local like the theme — it describes how the
 * editor draws, not what a vault contains, so it must not flip as you switch
 * vaults. Defaults to the panel, which is the point of the feature.
 */
export function readPropertiesMode(): PropertiesMode {
  try {
    const v = localStorage.getItem(PROPERTIES_MODE_KEY);
    return v === "visible" || v === "hidden" || v === "source" ? v : "visible";
  } catch {
    return "visible";
  }
}

export function writePropertiesMode(mode: PropertiesMode): void {
  try {
    localStorage.setItem(PROPERTIES_MODE_KEY, mode);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

export const PROPERTIES_MODES: ReadonlyArray<{
  id: PropertiesMode;
  label: string;
  hint: string;
}> = [
  { id: "visible", label: "Visible", hint: "Shown as a panel above the note" },
  { id: "hidden", label: "Hidden", hint: "Not shown; still in the file" },
  { id: "source", label: "Source", hint: "Shown as plain YAML" },
];

// ---- Per-note Properties collapse -----------------------------------------

const PROPERTIES_COLLAPSED_KEY = "context.propertiesCollapsed";

interface PropertiesCollapsedPrefs {
  version: 3;
  /** Paths awaiting a document identity, retained for upgrades and unopened notes. */
  vaults: Record<string, Record<string, true>>;
  docs: Record<string, Record<string, boolean>>;
}

function collapsedEntries(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, collapsed]) => collapsed === true),
  ) as Record<string, true>;
}

function documentCollapseEntries(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, collapsed]) => typeof collapsed === "boolean"),
  ) as Record<string, boolean>;
}

function emptyPropertiesCollapsedPrefs(): PropertiesCollapsedPrefs {
  return { version: 3, vaults: {}, docs: {} };
}

function readPropertiesCollapsedPrefs(vaultId: string): {
  prefs: PropertiesCollapsedPrefs;
  migrated: boolean;
} {
  const raw = localStorage.getItem(PROPERTIES_COLLAPSED_KEY);
  if (!raw) return { prefs: emptyPropertiesCollapsedPrefs(), migrated: false };

  const value: unknown = JSON.parse(raw);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (
      (record.version === 2 || record.version === 3) &&
      record.vaults &&
      typeof record.vaults === "object" &&
      !Array.isArray(record.vaults)
    ) {
      const vaults = Object.fromEntries(
        Object.entries(record.vaults).map(([id, entries]) => [
          id,
          collapsedEntries(entries),
        ]),
      );
      const docs =
        record.version === 3 && record.docs && typeof record.docs === "object" && !Array.isArray(record.docs)
          ? Object.fromEntries(Object.entries(record.docs).map(([id, entries]) => [
              id,
              documentCollapseEntries(entries),
            ]))
          : {};
      return { prefs: { version: 3, vaults, docs }, migrated: record.version === 2 };
    }

    // T5 stored one flat path map for the whole device. The first vault opened
    // after this upgrade is the only unambiguous owner, so move the entire map
    // into that vault once. Replacing the value atomically also prevents a
    // second vault from claiming the same legacy paths.
    return {
      prefs: {
        version: 3,
        vaults: { [propertiesCollapseVaultKey(vaultId)]: collapsedEntries(value) },
        docs: {},
      },
      migrated: true,
    };
  }

  return { prefs: emptyPropertiesCollapsedPrefs(), migrated: false };
}

function propertiesCollapseKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function propertiesCollapseVaultKey(vaultId: string): string {
  return vaultId.replace(/\\/g, "/");
}

/** Whether this note's Properties panel is folded on this device. */
export function readPropertiesCollapsed(vaultId: string, path: string, docId?: string): boolean {
  const vaultKey = propertiesCollapseVaultKey(vaultId);
  if (!vaultKey) return false;
  try {
    const { prefs, migrated } = readPropertiesCollapsedPrefs(vaultId);
    const key = propertiesCollapseKey(path);
    const legacy = prefs.vaults[vaultKey]?.[key] === true;
    if (docId && legacy) {
      const values = { ...(prefs.docs[vaultKey] ?? {}) };
      // An explicit expanded state is newer than any remaining path entry.
      if (!Object.prototype.hasOwnProperty.call(values, docId)) values[docId] = true;
      prefs.docs[vaultKey] = values;
      delete prefs.vaults[vaultKey][key];
      if (Object.keys(prefs.vaults[vaultKey]).length === 0) delete prefs.vaults[vaultKey];
    }
    if (migrated || (docId && legacy)) {
      localStorage.setItem(PROPERTIES_COLLAPSED_KEY, JSON.stringify(prefs));
    }
    return docId ? prefs.docs[vaultKey]?.[docId] === true : legacy;
  } catch {
    // Missing, denied or corrupt storage means every note starts expanded.
    return false;
  }
}

/** Remember one note's fold state without changing the global display mode. */
export function writePropertiesCollapsed(
  vaultId: string,
  path: string,
  collapsed: boolean,
  docId?: string,
): void {
  const vaultKey = propertiesCollapseVaultKey(vaultId);
  if (!vaultKey) return;
  try {
    const { prefs } = readPropertiesCollapsedPrefs(vaultId);
    const values = { ...(prefs.vaults[vaultKey] ?? {}) };
    const key = propertiesCollapseKey(path);
    if (docId) {
      prefs.docs[vaultKey] = { ...(prefs.docs[vaultKey] ?? {}), [docId]: collapsed };
      delete values[key];
    } else if (collapsed) values[key] = true;
    else delete values[key];
    if (Object.keys(values).length > 0) prefs.vaults[vaultKey] = values;
    else delete prefs.vaults[vaultKey];
    localStorage.setItem(
      PROPERTIES_COLLAPSED_KEY,
      JSON.stringify(prefs),
    );
  } catch {
    /* localStorage unavailable — the panel stays expanded next time */
  }
}

/** Follow confirmed file/folder moves for preferences not yet migrated to doc IDs. */
export function remapPropertiesCollapsed(vaultId: string, from: string, to: string): void {
  const vaultKey = propertiesCollapseVaultKey(vaultId);
  const source = propertiesCollapseKey(from);
  const destination = propertiesCollapseKey(to);
  if (!vaultKey || !source || source === destination) return;
  try {
    const { prefs, migrated } = readPropertiesCollapsedPrefs(vaultId);
    const values = { ...(prefs.vaults[vaultKey] ?? {}) };
    let changed = migrated;
    for (const path of Object.keys(values)) {
      if (path !== source && !path.startsWith(source + "/")) continue;
      delete values[path];
      values[destination + path.slice(source.length)] = true;
      changed = true;
    }
    if (!changed) return;
    if (Object.keys(values).length > 0) prefs.vaults[vaultKey] = values;
    else delete prefs.vaults[vaultKey];
    localStorage.setItem(PROPERTIES_COLLAPSED_KEY, JSON.stringify(prefs));
  } catch {
    // A device preference must never prevent a file move.
  }
}

// ---- Default Markdown view mode --------------------------------------------

const DEFAULT_VIEW_MODE_KEY = "context.defaultViewMode";

/**
 * The mode a note starts in when it has no session override. This is a
 * device-level drawing preference; individual note choices live only in the
 * store for as long as their tabs remain open.
 */
export function readDefaultViewMode(): ViewMode {
  try {
    const value = localStorage.getItem(DEFAULT_VIEW_MODE_KEY);
    return value === "live" || value === "source" || value === "reading"
      ? value
      : "live";
  } catch {
    return "live";
  }
}

export function writeDefaultViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(DEFAULT_VIEW_MODE_KEY, mode);
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

export const VIEW_MODE_OPTIONS: ReadonlyArray<{
  id: ViewMode;
  label: string;
  hint: string;
}> = [
  { id: "live", label: "Live Preview", hint: "Rendered Markdown while you edit" },
  { id: "source", label: "Raw", hint: "Literal Markdown with syntax highlighting" },
  { id: "reading", label: "Reading", hint: "Rendered and read-only" },
];

// ---- Editor layout ----------------------------------------------------------

const EDITOR_MEASURE_KEY = "context.editorMeasure";
/** The last non-full width, which the Wide toggle returns to. */
const EDITOR_NORMAL_MEASURE_KEY = "context.editorMeasureNormal";
/** Set once the old 88ch default has been moved to the current one. */
const EDITOR_MEASURE_DEFAULT_MIGRATED_KEY = "context.editorMeasureDefault72";
/** The key this replaced: a two-state "Readable line length" switch. Read once,
 *  to migrate a device that still has it, and never written again. */
const LEGACY_READABLE_LINE_LENGTH_KEY = "context.readableLineLength";
const LINE_NUMBERS_KEY = "context.lineNumbers";

/**
 * How wide the editor's prose column runs: a measure in `ch` — the unit
 * `--editor-measure` is already expressed in — or `"full"`, the whole pane
 * minus its gutters.
 */
export type EditorMeasure = number | "full";

/** 72ch (~640px at the document size) matches Obsidian Minimal's 40rem line
 *  width. The old 88ch default left almost no margin in a laptop-width pane. */
export const EDITOR_MEASURE_DEFAULT = 72;
/** The default this replaced, moved once by `migrateEditorMeasureDefault`. */
const EDITOR_MEASURE_OLD_DEFAULT = 88;
/** Below ~60ch prose starts to hyphenate badly; above ~120ch the measure has
 *  already stopped being readable and "full" is the honest choice. */
export const EDITOR_MEASURE_MIN = 60;
export const EDITOR_MEASURE_MAX = 120;
/** The slider's granularity. Four characters is the smallest step whose effect
 *  is actually visible as you drag. */
export const EDITOR_MEASURE_STEP = 4;

/** Snap to the step and clamp to the usable range. NaN — a corrupted stored
 *  value, or a garbage slider reading — falls back to the default rather than
 *  collapsing the column to nothing. ±Infinity clamps to the bounds like any
 *  other out-of-range number; a clamp that answered "88" to "as wide as
 *  possible" would be lying. */
export function clampEditorMeasure(ch: number): number {
  if (Number.isNaN(ch)) return EDITOR_MEASURE_DEFAULT;
  const snapped = Math.round(ch / EDITOR_MEASURE_STEP) * EDITOR_MEASURE_STEP;
  return Math.min(EDITOR_MEASURE_MAX, Math.max(EDITOR_MEASURE_MIN, snapped));
}

/**
 * The chosen column width. Device-local like the theme — it describes how the
 * editor draws, not what a vault contains.
 *
 * Migration: this replaced a two-state "Readable line length" switch. With no
 * value of its own the old key still decides — "off" meant the column filled
 * the window, which is exactly what `"full"` means now, and anything else meant
 * the readable measure, which is the default. The legacy key is never written
 * again, so the first drag of the slider settles it for good.
 */
export function readEditorMeasure(): EditorMeasure {
  try {
    const raw = localStorage.getItem(EDITOR_MEASURE_KEY);
    if (raw === null) {
      return localStorage.getItem(LEGACY_READABLE_LINE_LENGTH_KEY) === "off"
        ? "full"
        : EDITOR_MEASURE_DEFAULT;
    }
    if (raw === "full") return "full";
    // `Number("")` is 0 — finite, so it would survive the clamp as the MINIMUM
    // measure. An empty or blank value is a corrupted write, not a request for
    // the narrowest column.
    return raw.trim() === "" ? EDITOR_MEASURE_DEFAULT : clampEditorMeasure(Number(raw));
  } catch {
    return EDITOR_MEASURE_DEFAULT;
  }
}

/**
 * Move a device still on the old 88ch default to the current one. Runs once: a
 * width of 88 chosen after the migration is left alone.
 */
export function migrateEditorMeasureDefault(): void {
  try {
    if (localStorage.getItem(EDITOR_MEASURE_DEFAULT_MIGRATED_KEY) !== null) return;
    localStorage.setItem(EDITOR_MEASURE_DEFAULT_MIGRATED_KEY, "1");
    if (localStorage.getItem(EDITOR_MEASURE_KEY) === String(EDITOR_MEASURE_OLD_DEFAULT)) {
      localStorage.setItem(EDITOR_MEASURE_KEY, String(EDITOR_MEASURE_DEFAULT));
    }
  } catch {
    /* localStorage unavailable — nothing stored to migrate */
  }
}

/** The width the Wide toggle returns to: the last non-full one, else the default. */
export function readEditorNormalMeasure(): number {
  try {
    const raw = localStorage.getItem(EDITOR_NORMAL_MEASURE_KEY);
    return raw === null || raw.trim() === "" ? EDITOR_MEASURE_DEFAULT : clampEditorMeasure(Number(raw));
  } catch {
    return EDITOR_MEASURE_DEFAULT;
  }
}

export function writeEditorNormalMeasure(measure: number): void {
  try {
    localStorage.setItem(EDITOR_NORMAL_MEASURE_KEY, String(measure));
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

export function writeEditorMeasure(measure: EditorMeasure): void {
  try {
    localStorage.setItem(EDITOR_MEASURE_KEY, measure === "full" ? "full" : String(measure));
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

/**
 * Show the line-number gutter. OFF by default, unlike everything else here: the
 * gutter takes real width from the prose column, and a second brain is a place
 * you write prose, not a place you cite line 42.
 */
export function readLineNumbers(): boolean {
  try {
    return localStorage.getItem(LINE_NUMBERS_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeLineNumbers(on: boolean): void {
  try {
    localStorage.setItem(LINE_NUMBERS_KEY, on ? "on" : "off");
  } catch {
    /* localStorage unavailable — the choice stays in-memory only */
  }
}

// ---- Legacy sidebar width (one-time workspace-layout import) ----------------

const SIDEBAR_WIDTH_KEY = "context.sidebarWidth";

/** Historical defaults retained so old `context.sidebarWidth` values can be
 *  validated once by layout/persistence.ts. New writes use the layout key. */
export const SIDEBAR_WIDTH_DEFAULT = 264;
/** Bounds used by the retired sidebar preference. The workspace has its own
 *  current minimums in layout/geometry.ts. */
export const SIDEBAR_WIDTH_MIN = SIDEBAR_WIDTH_DEFAULT;
export const SIDEBAR_WIDTH_MAX = 560;

/** Validate an old stored width. Retained with its historical viewport fitting
 *  semantics for backward compatibility and its regression tests. */
export function clampSidebarWidth(px: number, viewport = 1200): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  // Always leave room for the editor, even when the window is narrower than the
  // nominal maximum.
  const max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, viewport - 320));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    // Import the preferred value, not the old hook's temporary viewport fit.
    // The new geometry layer fits it at render time without overwriting it.
    return clampSidebarWidth(Number(raw), Number.POSITIVE_INFINITY);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}
