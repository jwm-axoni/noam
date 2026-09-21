// Noam's self-contained Fan mark for server-rendered pages. The desktop source
// of truth is apps/desktop/src/assets/noam-mark.svg; keep the geometry in sync
// when the mark changes. See docs/BRANDING.md.

type FanColors = { back: string; front: string; gap: string };

const fanDataUri = (colors: FanColors, tile = false): string => {
  const tileSvg = tile
    ? `<rect width="64" height="64" rx="14" fill="#f2ecdf"/>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Noam</title>${tileSvg}<rect x="21" y="7" width="30" height="42" rx="8" transform="rotate(12 36 28)" fill="${colors.back}"/><rect x="11" y="16" width="30" height="42" rx="8" fill="${colors.front}" stroke="${colors.gap}" stroke-width="6" paint-order="stroke"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

export const BRAND_MARK_LIGHT_DATA_URI = fanDataUri(
  { back: "#a09585", front: "#2b2724", gap: "#f2f1f6" },
);

export const BRAND_MARK_DARK_DATA_URI = fanDataUri(
  { back: "#8a8074", front: "#ebe4d6", gap: "#14141a" },
);

/** Dark-card default used by the server's shared account and OAuth shell. */
export const BRAND_MARK_DATA_URI = BRAND_MARK_DARK_DATA_URI;

/** Paper-tile Fan mark for browser tabs in either system theme. */
export const GLYPH_FAVICON_DATA_URI = fanDataUri(
  { back: "#a09585", front: "#2b2724", gap: "#f2ecdf" },
  true,
);
