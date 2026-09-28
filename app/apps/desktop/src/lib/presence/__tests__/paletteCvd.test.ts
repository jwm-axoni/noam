// Guards the participant palette's design claims (docs/specs/07-participants-and-presence.md):
//
//   1. Colorblind-safe: every pair of palette colors stays apart under normal
//      vision AND under simulated protanopia, deuteranopia and tritanopia
//      (Machado, Oliveira & Fernandes 2009, severity 1.0), measured as CIEDE2000.
//      The floor below is Okabe-Ito's score on the same metric (10.87) with
//      headroom; the shipped set scores ~15.7.
//   2. "Red reads as error": no palette hue falls in the red-through-orange band
//      (OKLCH hue 350..75), so a participant can never be mistaken for the
//      `--danger` / `--warning` tokens.
//   3. Violet `#7f73ff` is reserved for Noam's own actions and is not in the set.
//   4. Every color is usable as a caret bar and a name flag: it clears 3:1 against
//      at least one theme surface, never drops below 1.8:1 against either, and
//      `textOn` finds a label color with ≥ 4.5:1 on top of it.
//
// If you change the palette, this test tells you what you broke.

import { describe, expect, it } from "vitest";
import { NOAM_VIOLET, PRESENCE_PALETTE, textOn } from "../color";

type Rgb = [number, number, number];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const hexToLinear = (hex: string): Rgb =>
  [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Rgb;

function linearToLab([r, g, b]: Rgb): Rgb {
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function oklchHue([r, g, b]: Rgb): number {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

function deltaE2000([L1, a1, b1]: Rgb, [L2, a2, b2]: Rgb): number {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const x = Math.atan2(b, a) * deg;
    return x < 0 ? x + 360 : x;
  };
  const h1p = hue(a1p, b1), h2p = hue(a2p, b2);
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = C1p * C2p === 0 ? h1p + h2p : (h1p + h2p) / 2;
  if (C1p * C2p !== 0 && Math.abs(h1p - h2p) > 180) hbp += hbp < 180 ? 180 : -180;
  const T =
    1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  const dLp = L2 - L1, dCp = C2p - C1p;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

/** Machado et al. 2009 dichromacy matrices (severity 1.0), applied in linear RGB. */
const CVD: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const simulate = (rgb: Rgb, M: number[][]): Rgb =>
  M.map((row) => clamp01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) as Rgb;

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: Rgb, b: Rgb) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const SURFACES = {
  white: hexToLinear("#ffffff"),
  cream: hexToLinear("#f8f3ea"),
  dark: hexToLinear("#2b2724"),
  ink: hexToLinear("#1e1b18"),
};

function minPairwise(sim?: number[][]): { value: number; pair: string } {
  let value = Infinity, pair = "";
  for (let i = 0; i < PRESENCE_PALETTE.length; i++) {
    for (let j = i + 1; j < PRESENCE_PALETTE.length; j++) {
      const a = hexToLinear(PRESENCE_PALETTE[i]), b = hexToLinear(PRESENCE_PALETTE[j]);
      const d = deltaE2000(
        linearToLab(sim ? simulate(a, sim) : a),
        linearToLab(sim ? simulate(b, sim) : b),
      );
      if (d < value) {
        value = d;
        pair = `${PRESENCE_PALETTE[i]}/${PRESENCE_PALETTE[j]}`;
      }
    }
  }
  return { value, pair };
}

// Okabe-Ito's minimum pairwise CIEDE2000 across the same four simulations is
// 10.87; the shipped palette must beat it with margin.
const MIN_DELTA_E = 13;

describe("participant palette: colorblind safety and the no-red rule", () => {
  it("has eight lowercase hex colors and no duplicates", () => {
    expect(PRESENCE_PALETTE).toHaveLength(8);
    for (const hex of PRESENCE_PALETTE) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(PRESENCE_PALETTE).size).toBe(8);
  });

  it("keeps every pair apart under normal vision", () => {
    const { value, pair } = minPairwise();
    expect(value, `closest pair ${pair}`).toBeGreaterThanOrEqual(MIN_DELTA_E);
  });

  for (const [name, M] of Object.entries(CVD)) {
    it(`keeps every pair apart under simulated ${name}opia`, () => {
      const { value, pair } = minPairwise(M);
      expect(value, `closest pair ${pair} under ${name}`).toBeGreaterThanOrEqual(MIN_DELTA_E);
    });
  }

  it("contains no red or orange hue (red reads as error)", () => {
    for (const hex of PRESENCE_PALETTE) {
      const h = oklchHue(hexToLinear(hex));
      const inRedBand = h >= 350 || h <= 75;
      expect(inRedBand, `${hex} has OKLCH hue ${h.toFixed(0)}`).toBe(false);
    }
  });

  it("never assigns Noam's reserved violet, and stays away from its hue", () => {
    expect(PRESENCE_PALETTE as readonly string[]).not.toContain(NOAM_VIOLET);
    const violetHue = oklchHue(hexToLinear(NOAM_VIOLET));
    for (const hex of PRESENCE_PALETTE) {
      const h = oklchHue(hexToLinear(hex));
      const dist = Math.abs(((h - violetHue + 540) % 360) - 180);
      expect(dist, `${hex} is within 20° of the reserved violet`).toBeGreaterThan(20);
    }
  });

  it("is visible as a 2px caret bar on light and dark surfaces", () => {
    for (const hex of PRESENCE_PALETTE) {
      const c = hexToLinear(hex);
      const light = Math.min(contrast(c, SURFACES.white), contrast(c, SURFACES.cream));
      const dark = Math.min(contrast(c, SURFACES.dark), contrast(c, SURFACES.ink));
      expect(Math.max(light, dark), `${hex} clears 3:1 on neither theme`).toBeGreaterThanOrEqual(3);
      expect(Math.min(light, dark), `${hex} is nearly invisible on one theme`).toBeGreaterThanOrEqual(1.8);
    }
  });

  it("gives every swatch a legible label color via textOn", () => {
    for (const hex of PRESENCE_PALETTE) {
      const label = textOn(hex);
      const ratio = contrast(hexToLinear(hex), hexToLinear(label));
      expect(ratio, `${hex} with ${label} text`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
