import { describe, expect, it } from "vitest";
import {
  publicNoteAssetReferences,
  publicNoteReferencesAsset,
  redactPrivateCoverSources,
  renderPresentation,
} from "../src/render/presentation.js";

const opts = { assetUrl: (path: string) => `/p/token/a/${path}` };
const note = (body: string) => `---\nnoam_presentation_version: 1\n${body}\n---\nText`;

describe("public note presentation", () => {
  it("renders one emoji without changing the title", () => {
    expect(renderPresentation(note('noam_icon: "emoji:🌿"'), opts)).toEqual({
      iconHtml: '<span class="note-icon" aria-hidden="true">🌿</span>', coverHtml: "",
    });
  });

  it("renders bundled Lucide icons without resolving an asset", () => {
    let assetCalls = 0;
    const result = renderPresentation(
      note("noam_icon: lucide:house\nnoam_icon_color: violet"),
      { assetUrl: () => { assetCalls++; return null; } },
    );
    expect(result.iconHtml).toContain('<svg class="note-icon note-icon-lucide icon-color-violet"');
    expect(result.iconHtml).toContain('viewBox="0 0 24 24"');
    expect(result.iconHtml).toContain("<path");
    expect(result.iconHtml).not.toMatch(/(?:script|style|href|foreignObject|\son\w+=|https?:)/i);
    expect(assetCalls).toBe(0);
  });

  it("supports picker aliases and rejects unbundled or malformed Lucide ids", () => {
    expect(renderPresentation(note("noam_icon: lucide:home"), opts).iconHtml).toContain("<svg");
    for (const id of ["not-a-real-icon", "../house", "house-onclick", `house${"x".repeat(100)}`]) {
      expect(renderPresentation(note(`noam_icon: lucide:${id}`), opts).iconHtml).toBe("");
    }
  });

  it("accepts only the portable icon color palette", () => {
    for (const color of ["violet", "blue", "teal", "green", "amber", "orange", "rose", "slate"]) {
      expect(renderPresentation(
        note(`noam_icon: lucide:house\nnoam_icon_color: ${color}`),
        opts,
      ).iconHtml).toContain(`icon-color-${color}`);
    }
    const invalid = renderPresentation(
      note("noam_icon: lucide:house\nnoam_icon_color: red; background:url(https://example.com)"),
      opts,
    ).iconHtml;
    expect(invalid).toContain('class="note-icon note-icon-lucide"');
    expect(invalid).not.toContain("background");
    expect(invalid).not.toContain("example.com");
  });

  it("renders uploaded icons and covers through the scoped resolver", () => {
    const result = renderPresentation(note([
      'noam_icon: "asset:attachments/icon.png"',
      'noam_cover: attachments/cover.webp',
      'noam_cover_x: 20', 'noam_cover_y: 75', 'noam_cover_height: 300',
      'noam_cover_alt: "A quiet garden"',
    ].join('\n')), opts);
    expect(result.iconHtml).toContain('src="/p/token/a/attachments/icon.png"');
    expect(result.coverHtml).toContain('object-position:20% 75%;height:300px');
    expect(result.coverHtml).toContain('alt="A quiet garden"');
  });

  it("keeps a retained cover source private even when its path appears elsewhere", () => {
    const source = "attachments/noam/covers/source.jpg";
    const markdown = note(`noam_cover: attachments/preview.png\nnoam_cover_source: ${source}`);
    expect(publicNoteReferencesAsset(markdown, source)).toBe(false);
    expect(publicNoteReferencesAsset(`${markdown}\n![](${source})`, source)).toBe(false);
    expect(publicNoteReferencesAsset(`${markdown}\n${source}-thumbnail`, source)).toBe(false);
    const ambiguous = markdown.replace(
      `noam_cover_source: ${source}`,
      `noam_cover_source: ${source}\nnoam_cover_source: attachments/other.jpg`,
    );
    expect(publicNoteReferencesAsset(`${ambiguous}\n![](${source})`, source)).toBe(false);
  });

  it("authorizes only exact rendered image references", () => {
    const path = "attachments/photo.png";
    expect(publicNoteReferencesAsset(`![](${path})`, path)).toBe(true);
    expect(publicNoteReferencesAsset(path, path)).toBe(false);
    expect(publicNoteReferencesAsset(`![](${path}.bak)`, path)).toBe(false);
    expect(publicNoteReferencesAsset(`\`${`![](${path})`}\``, path)).toBe(false);
  });

  it("redacts raw and encoded retained-source paths from public body text", () => {
    const source = "attachments/noam/covers/Family #1? 50% 🌿.jpg";
    const encodedPath = source.split("/").map(encodeURIComponent).join("/");
    const markdown = note(`noam_cover_source: "${source}"`) +
      `\n${source}\n![](${encodedPath})`;
    const redacted = redactPrivateCoverSources(markdown);
    expect(redacted).not.toContain(source);
    expect(redacted).not.toContain(encodedPath);
    expect(publicNoteAssetReferences(markdown)).not.toContain(source);
    expect(publicNoteAssetReferences(markdown)).not.toContain(encodedPath);
  });

  it("supports CRLF, quotes and comments without interpreting nested YAML", () => {
    const result = renderPresentation(note("noam_icon: 'emoji:🌿' # comment").replace(/\n/g, '\r\n'), opts);
    expect(result.iconHtml).toContain('🌿');
    expect(renderPresentation(note("noam_icon: &icon emoji:🌿"), opts).iconHtml).toBe('');
    expect(renderPresentation(note("noam_icon:\n  value: emoji:🌿"), opts).iconHtml).toBe('');
  });

  it("escapes descriptive text and limits numeric CSS", () => {
    const result = renderPresentation(note([
      'noam_cover: attachments/cover.png',
      `noam_cover_alt: '" onerror="alert(1)'`,
      'noam_cover_x: 1000', 'noam_cover_y: -20', 'noam_cover_height: 9000',
    ].join('\n')), opts);
    expect(result.coverHtml).toContain('alt="&#34; onerror=&#34;alert(1)"');
    expect(result.coverHtml).toContain('object-position:100% 0%;height:420px');
    expect(result.coverHtml).not.toContain('" onerror=');
  });

  it("refuses external URLs, traversal, active images and ambiguous versions", () => {
    for (const path of ['https://example.com/x.png', 'attachments/../secret.png', 'attachments/a.svg', '/tmp/a.png', 'preset:unknown']) {
      const result = renderPresentation(note(`noam_cover: ${path}\nnoam_icon: asset:${path}`), opts);
      expect(result).toEqual({ iconHtml: '', coverHtml: '' });
    }
    for (const body of [
      note('noam_icon: emoji:🌿\nnoam_icon: emoji:🔥'),
      note('noam_icon: emoji:🌿').replace('version: 1', 'version: 99'),
      note('noam_icon: emoji:🌿').replace('version: 1', 'version: 1\nnoam_presentation_version: 1'),
    ]) expect(renderPresentation(body, opts).iconHtml).toBe('');
  });

  it("honors the asset resolver refusing access", () => {
    const result = renderPresentation(note('noam_cover: attachments/a.png\nnoam_icon: asset:attachments/i.png'), { assetUrl: () => null });
    expect(result).toEqual({ iconHtml: '', coverHtml: '' });
  });

  it("renders only bundled cover presets without requesting an asset", () => {
    for (const preset of ['linen', 'graphite', 'moss', 'dusk']) {
      const result = renderPresentation(note(`noam_cover: preset:${preset}`), { assetUrl: () => { throw new Error('Preset must stay offline'); } });
      expect(result.coverHtml).toContain(`note-cover-${preset}`);
      expect(result.coverHtml).not.toContain('src=');
    }
  });
});
