import { relAssetPath, renderNoteHtml, type RenderOptions } from "./note-html.js";
import { renderLucideIcon } from "./lucide-icon.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function frontmatterLines(markdown: string): string[] | null {
  const lines = markdown.slice(0, 64 * 1024).replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  return end < 0 ? null : lines.slice(1, end);
}

function scalar(raw: string): string | null {
  if (raw.startsWith('"')) {
    const token = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw)?.[1];
    if (!token) return null;
    try { return JSON.parse(token) as string; } catch { return null; }
  }
  if (raw.startsWith("'")) {
    const token = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(raw)?.[1];
    return token === undefined ? null : token.replace(/''/g, "'");
  }
  const value = raw.replace(/\s+#.*$/, "").trim();
  return /^[|>&*!\[{]/.test(value) ? null : value;
}

/** Read only flat presentation scalars. This never rewrites source YAML. */
function fields(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = frontmatterLines(markdown);
  if (!lines) return result;
  for (const line of lines) {
    const match = /^(noam_[a-z_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    // Conflicting declarations are ambiguous, so render no presentation.
    if (result.has(key)) return new Map();
    const value = scalar(raw);
    if (value == null) return new Map();
    result.set(key, value);
  }
  return result.get("noam_presentation_version") === "1" ? result : new Map();
}

function asset(value: string | undefined, opts: RenderOptions): string | null {
  if (!value || !value.startsWith("attachments/")) return null;
  const path = relAssetPath(value);
  // Public images must be passive. SVG uploads need a rasterized preview.
  if (!path || !/\.(?:png|jpe?g|webp|gif|avif)$/i.test(path)) return null;
  return opts.assetUrl(path);
}

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value || !/^-?\d+(?:\.\d+)?$/.test(value)) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function privateCoverSources(markdown: string): string[] {
  return (frontmatterLines(markdown) ?? []).flatMap((line) => {
    const match = /^noam_cover_source:\s*(.*)$/.exec(line);
    const value = match ? scalar(match[1]) : null;
    return value == null ? [] : [value];
  });
}

/** Remove retained-source paths before rendering a public note body. */
export function redactPrivateCoverSources(markdown: string): string {
  let redacted = markdown;
  for (const source of privateCoverSources(markdown)) {
    if (!source) continue;
    redacted = redacted.replaceAll(source, "[private cover source]");
    const encodedPath = source.split("/").map(encodeURIComponent).join("/");
    for (const encoded of [encodeURI(source), encodeURIComponent(source), encodedPath]) {
      const escaped = encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      redacted = redacted.replace(new RegExp(escaped, "gi"), "[private cover source]");
    }
  }
  return redacted;
}

/** Exact passive image paths the public page is allowed to request. */
export function publicNoteAssetReferences(markdown: string): ReadonlySet<string> {
  const references = new Set<string>();
  const collect = { assetUrl: (path: string) => { references.add(path); return null; } };
  const values = fields(markdown);
  const icon = values.get("noam_icon") ?? "";
  if (icon.startsWith("asset:")) asset(icon.slice(6), collect);
  asset(values.get("noam_cover"), collect);
  renderNoteHtml(redactPrivateCoverSources(markdown), collect);
  return references;
}

/** A retained cover source is private, even if its path also appears in prose. */
export function publicNoteReferencesAsset(markdown: string, path: string): boolean {
  if (privateCoverSources(markdown).includes(path)) return false;
  return publicNoteAssetReferences(markdown).has(path);
}

/** Public presentation never loads third-party URLs or grants another note. */
export function renderPresentation(markdown: string, opts: RenderOptions): { iconHtml: string; coverHtml: string } {
  const values = fields(markdown);
  let iconHtml = "";
  const icon = values.get("noam_icon") ?? "";
  if (icon.startsWith("emoji:")) {
    const emoji = icon.slice(6);
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)];
    if (emoji.length <= 64 && segments.length === 1 && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(emoji)) {
      iconHtml = `<span class="note-icon" aria-hidden="true">${escapeHtml(emoji)}</span>`;
    }
  } else if (icon.startsWith("lucide:")) {
    iconHtml = renderLucideIcon(icon.slice(7), values.get("noam_icon_color")) ?? "";
  } else if (icon.startsWith("asset:")) {
    const url = asset(icon.slice(6), opts);
    if (url) iconHtml = `<img class="note-icon" src="${escapeHtml(url)}" alt="" />`;
  }

  const x = bounded(values.get("noam_cover_x"), 50, 0, 100);
  const y = bounded(values.get("noam_cover_y"), 50, 0, 100);
  const height = bounded(values.get("noam_cover_height"), 220, 120, 420);
  const alt = escapeHtml((values.get("noam_cover_alt") ?? "").slice(0, 1000));
  const preset = /^preset:(linen|graphite|moss|dusk)$/.exec(values.get("noam_cover") ?? "")?.[1];
  if (preset) {
    return { iconHtml, coverHtml: `<div class="note-cover note-cover-${preset}" role="img" aria-label="${alt || `${preset} cover`}" style="height:${height}px"></div>` };
  }
  const cover = asset(values.get("noam_cover"), opts);
  if (!cover) return { iconHtml, coverHtml: "" };
  const coverHtml = `<img class="note-cover" src="${escapeHtml(cover)}" alt="${alt}" style="object-position:${x}% ${y}%;height:${height}px" />`;
  return { iconHtml, coverHtml };
}
