// Theme controller. The user cycles light → dark → system; the choice persists
// in localStorage. "system" follows the OS via prefers-color-scheme and updates
// live. We resolve the mode to a concrete theme and stamp `data-theme` on the
// root element so tokens.css only needs :root (light) + [data-theme="dark"].

export type ThemeMode = "light" | "dark" | "system";
export type ThemePreset =
  | "noam"
  | "paper-ink"
  | "sea"
  | "terracotta"
  | "moss"
  | "minimal"
  | "graphite"
  | "black";
export type ThemeAccent = "violet" | "blue" | "green" | "rose" | "amber";

export interface ThemePresetOption {
  id: ThemePreset;
  label: string;
  description: string;
  swatches: readonly [string, string, string];
}

export const THEME_PRESETS: readonly ThemePresetOption[] = [
  {
    id: "noam",
    label: "Noam",
    description: "Violet accents and softly layered surfaces.",
    swatches: ["#7f73ff", "#ffffff", "#ececf0"],
  },
  {
    id: "paper-ink",
    label: "Paper & Ink",
    description: "Warm paper, charcoal ink, and pencil-grey details.",
    swatches: ["#2b2724", "#fbf8f2", "#efe9de"],
  },
  {
    id: "sea",
    label: "Sea",
    description: "Cool blue-green ink on clean, quiet surfaces.",
    swatches: ["#0d747e", "#ffffff", "#e8eef0"],
  },
  {
    id: "terracotta",
    label: "Terracotta",
    description: "Terracotta and ochre on warm sand.",
    swatches: ["#b3432a", "#fbf5ec", "#f1e6d6"],
  },
  {
    id: "moss",
    label: "Moss",
    description: "Forest green ink on soft cream.",
    swatches: ["#2e5b3c", "#f8faf3", "#e9ede2"],
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Quiet white surfaces with a restrained blue accent.",
    swatches: ["#4f6f91", "#ffffff", "#f3f5f7"],
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Neutral grey surfaces with crisp monochrome type.",
    swatches: ["#646b73", "#eceeef", "#d9dcdf"],
  },
  {
    id: "black",
    label: "Black",
    description: "Near-black dark surfaces and a neutral light variant.",
    swatches: ["#9b9b9b", "#111111", "#000000"],
  },
];

export interface ThemeAccentOption {
  id: ThemeAccent;
  label: string;
  value: string;
}

export const THEME_ACCENTS: readonly ThemeAccentOption[] = [
  {
    id: "violet",
    label: "Violet",
    value: "#6a5cf5",
  },
  {
    id: "blue",
    label: "Blue",
    value: "#2563a8",
  },
  {
    id: "green",
    label: "Green",
    value: "#277a4e",
  },
  {
    id: "rose",
    label: "Rose",
    value: "#a83d68",
  },
  {
    id: "amber",
    label: "Amber",
    value: "#8a5a00",
  },
];

const STORAGE_KEY = "cbk-theme";
const PRESET_STORAGE_KEY = "noam-theme-preset";
const ACCENT_STORAGE_KEY = "noam-theme-accent";
const MODES: ThemeMode[] = ["light", "dark", "system"];
const LEGACY_PRESETS: Readonly<Record<string, ThemePreset>> = {
  ink: "paper-ink",
  violet: "noam",
  sea: "sea",
  terracotta: "terracotta",
  moss: "moss",
};

const mql = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Resolve a mode to the concrete theme that should be painted. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return mql()?.matches ? "dark" : "light";
  return mode;
}

/** Stamp the resolved theme onto <html> so the token overrides apply. */
function paint(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
  const preset = getThemePreset();
  document.documentElement.setAttribute("data-theme-preset", preset);
  // `data-accent` was the old full-palette axis. Leaving it on the root makes
  // partial values leak between two independently persisted systems.
  document.documentElement.removeAttribute("data-accent");
  const accent = getThemeAccent();
  if (accent) document.documentElement.setAttribute("data-theme-accent", accent);
  else document.documentElement.removeAttribute("data-theme-accent");
}

export function observeThemeChanges(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-preset", "data-theme-accent"],
  });
  return () => observer.disconnect();
}

/**
 * A saved preset wins. Otherwise derive the matching palette from the previous
 * `context.accentTheme` preference without rewriting it, so upgrades and
 * rollbacks both retain the person's choice.
 */
export function getThemePreset(): ThemePreset {
  const stored = localStorage.getItem(PRESET_STORAGE_KEY);
  if (THEME_PRESETS.some((preset) => preset.id === stored)) return stored as ThemePreset;
  return LEGACY_PRESETS[localStorage.getItem("context.accentTheme") ?? ""] ?? "paper-ink";
}

/** Persist a palette without changing light/dark/system. */
export function setThemePreset(preset: ThemePreset): void {
  localStorage.setItem(PRESET_STORAGE_KEY, preset);
  document.documentElement.setAttribute("data-theme-preset", preset);
  document.documentElement.removeAttribute("data-accent");
}

/** `null` means the selected palette supplies its own accent. */
export function getThemeAccent(): ThemeAccent | null {
  const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
  return THEME_ACCENTS.some((accent) => accent.id === stored)
    ? (stored as ThemeAccent)
    : null;
}

/** Override the palette accent without changing palette or display mode. */
export function setThemeAccent(accent: ThemeAccent | null): void {
  if (accent) {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    document.documentElement.setAttribute("data-theme-accent", accent);
  } else {
    localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-theme-accent");
  }
}

/** Persist + apply a mode. */
export function setThemeMode(mode: ThemeMode) {
  if (mode === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, mode);
  paint(mode);
}

/** Advance to the next mode in the cycle and apply it; returns the new mode. */
export function cycleThemeMode(): ThemeMode {
  const next = MODES[(MODES.indexOf(getThemeMode()) + 1) % MODES.length];
  setThemeMode(next);
  return next;
}

/**
 * Call once at startup: paint the stored mode and keep "system" in sync with the
 * OS. Returns a disposer (unused in practice — app lifetime === process).
 */
export function initTheme(): () => void {
  paint(getThemeMode());
  const m = mql();
  const onChange = () => {
    if (getThemeMode() === "system") paint("system");
  };
  m?.addEventListener?.("change", onChange);
  return () => m?.removeEventListener?.("change", onChange);
}
