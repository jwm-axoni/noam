import type { PropEntry } from "../frontmatter/parse";

export const PRESENTATION_VERSION = 1;

export const PRESENTATION_KEYS = {
  version: "noam_presentation_version",
  icon: "noam_icon",
  iconColor: "noam_icon_color",
  cover: "noam_cover",
  coverSource: "noam_cover_source",
  coverX: "noam_cover_x",
  coverY: "noam_cover_y",
  coverHeight: "noam_cover_height",
  coverAlt: "noam_cover_alt",
} as const;

export const FOLDER_PRESENTATION_FILE = "_noam-folder.md";
export const FOLDER_PRESENTATION_KIND = "folder-presentation";

export const ICON_COLOR_IDS = [
  "violet",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "slate",
] as const;

export type IconColorId = (typeof ICON_COLOR_IDS)[number];

export type PresentationIcon =
  | { kind: "lucide"; id: string }
  | { kind: "emoji"; value: string }
  | { kind: "asset"; path: string };

export interface NotePresentation {
  version: number;
  icon: PresentationIcon | null;
  iconColor: IconColorId | null;
  cover: string | null;
  /** Private retained source for later re-crops; never rendered directly. */
  coverSource: string | null;
  coverX: number;
  coverY: number;
  coverHeight: number;
  coverAlt: string;
}

export const DEFAULT_COVER_HEIGHT = 220;
export const MIN_COVER_HEIGHT = 120;
export const MAX_COVER_HEIGHT = 420;

export const COVER_PRESETS = [
  { id: "linen", label: "Linen" },
  { id: "graphite", label: "Graphite" },
  { id: "moss", label: "Moss" },
  { id: "dusk", label: "Dusk" },
] as const;
const COVER_PRESET_IDS = new Set<string>(COVER_PRESETS.map((preset) => preset.id));

export const DEFAULT_PRESENTATION: NotePresentation = {
  version: PRESENTATION_VERSION,
  icon: null,
  iconColor: null,
  cover: null,
  coverSource: null,
  coverX: 50,
  coverY: 50,
  coverHeight: DEFAULT_COVER_HEIGHT,
  coverAlt: "",
};

const LUCIDE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parsePresentationIcon(raw: unknown): PresentationIcon | null {
  if (typeof raw !== "string") return null;
  if (raw.startsWith("lucide:")) {
    const id = raw.slice(7);
    return LUCIDE_ID.test(id) ? { kind: "lucide", id } : null;
  }
  if (raw.startsWith("emoji:")) {
    const value = raw.slice(6).trim();
    return value ? { kind: "emoji", value } : null;
  }
  if (raw.startsWith("asset:")) {
    const path = raw.slice(6);
    return safeAttachmentPath(path) ? { kind: "asset", path } : null;
  }
  return null;
}

export function serializePresentationIcon(icon: PresentationIcon): string {
  if (icon.kind === "lucide") return `lucide:${icon.id}`;
  if (icon.kind === "emoji") return `emoji:${icon.value}`;
  return `asset:${icon.path}`;
}

export function safeAttachmentPath(path: string): boolean {
  if (!path.startsWith("attachments/") || /[\\\0\u0001-\u001f\u007f]/.test(path)) {
    return false;
  }
  const segments = path.split("/");
  return !segments.some(
    (segment) =>
      segment === "" || segment === "." || segment === ".." || segment.startsWith("."),
  );
}

function scalar(entries: readonly PropEntry[], key: string): string | number | boolean | null {
  const value = entries.find((entry) => entry.key === key)?.value;
  if (!value || value.kind === "list") return null;
  return value.value;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function presentationFromEntries(entries: readonly PropEntry[]): NotePresentation {
  const iconColor = scalar(entries, PRESENTATION_KEYS.iconColor);
  const cover = scalar(entries, PRESENTATION_KEYS.cover);
  const coverSource = scalar(entries, PRESENTATION_KEYS.coverSource);
  const coverText = typeof cover === "string" ? cover : null;
  return {
    version: finiteNumber(
      scalar(entries, PRESENTATION_KEYS.version),
      PRESENTATION_VERSION,
      1,
      PRESENTATION_VERSION,
    ),
    icon: parsePresentationIcon(scalar(entries, PRESENTATION_KEYS.icon)),
    iconColor:
      typeof iconColor === "string" &&
      ICON_COLOR_IDS.includes(iconColor as IconColorId)
        ? (iconColor as IconColorId)
        : null,
    cover:
      coverText &&
      (safeAttachmentPath(coverText) ||
        (coverText.startsWith("preset:") && COVER_PRESET_IDS.has(coverText.slice(7))))
        ? coverText
        : null,
    coverSource:
      typeof coverSource === "string" && safeAttachmentPath(coverSource)
        ? coverSource
        : null,
    coverX: finiteNumber(scalar(entries, PRESENTATION_KEYS.coverX), 50, 0, 100),
    coverY: finiteNumber(scalar(entries, PRESENTATION_KEYS.coverY), 50, 0, 100),
    coverHeight: finiteNumber(
      scalar(entries, PRESENTATION_KEYS.coverHeight),
      DEFAULT_COVER_HEIGHT,
      MIN_COVER_HEIGHT,
      MAX_COVER_HEIGHT,
    ),
    coverAlt:
      typeof scalar(entries, PRESENTATION_KEYS.coverAlt) === "string"
        ? String(scalar(entries, PRESENTATION_KEYS.coverAlt))
        : "",
  };
}

export interface IndexedPresentation {
  path: string;
  icon?: string | null;
  iconColor?: string | null;
  kind?: string | null;
  cover?: string | null;
}

export function iconFromIndexed(meta: IndexedPresentation | undefined): PresentationIcon | null {
  return parsePresentationIcon(meta?.icon);
}

export function folderPresentationPath(folderPath: string): string {
  return folderPath ? `${folderPath}/${FOLDER_PRESENTATION_FILE}` : FOLDER_PRESENTATION_FILE;
}

export function folderPathForCompanion(path: string): string | null {
  if (path === FOLDER_PRESENTATION_FILE) return "";
  const suffix = `/${FOLDER_PRESENTATION_FILE}`;
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null;
}
