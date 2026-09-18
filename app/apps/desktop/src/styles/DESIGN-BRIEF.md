# Noam — Design Overhaul Brief (Atomize PLUS inspiration)

Source of truth for the redesign. Inspiration: Atomize PLUS 3.3 design system
(atomizedesign.com) — a light-first, modern SaaS visual language.

## The look

- **Light-first.** Near-white layered canvas (`--bg-app`) with white surface cards.
  Full dark mode via a light/dark/system toggle (sidebar footer) that persists in
  localStorage and stamps `data-theme` on the root; a `prefers-color-scheme`
  fallback covers first paint. Tokens handle both — just use the variables.
- **Layered surfaces, not lines.** Prefer background contrast + soft shadows over borders.
  Hairline borders (`--border`) only where layering isn't enough.
- **Generous rounding.** Cards/panels `--radius-lg/xl`; buttons, chips, badges, search
  inputs are **pills** (`--radius-pill`). Nothing sharp-cornered.
- **Soft, diffuse shadows** (`--shadow-*`). Never harsh or dark.
- **Violet accent** (`--accent`) used sparingly: primary buttons, active states, selection,
  focus rings, links, live cursors. The gradient (`--accent-gradient`) only for hero/primary CTAs.
- **4pt grid.** All padding/margins/gaps from `--sp-*`.
- **Typography:** Open Sauce Two (body/UI, `--font-body`, bundled locally as woff2
  in `src/assets/fonts/` via `fonts.css`), Radio Canada Big (display headings,
  `--font-display`, weights 600–700, via `@fontsource/radio-canada-big`), JetBrains
  Mono (code, via `@fontsource/jetbrains-mono`). All offline — no runtime CDN.
- **Motion:** subtle. `--t-fast` hover transitions, `--t-med` panel/dialog entrances
  (fade + 4px rise). Nothing bouncy.

## Component language

- **Primary button:** pill, `--accent` fill (gradient for the single most important CTA),
  white text, hover `--accent-hover`, `--shadow-sm`.
- **Secondary button:** pill, `--bg-surface` fill, `--border`, `--text-primary`, hover `--bg-hover`.
- **Ghost/icon button:** transparent, hover `--bg-hover`, radius `--radius-sm`.
- **Inputs:** filled `--bg-subtle`, `--radius-md`, border transparent → `--border-strong` on
  hover → accent + `--focus-ring` on focus. Placeholder `--text-tertiary`.
- **Cards/floating panels:** `--bg-surface`, `--radius-lg`, `--shadow-md` (dialogs `--shadow-lg`).
- **Selected list item (tree, search results):** `--accent-soft` fill + `--text-primary`
  (NOT accent-on-dark), radius `--radius-sm`.
- **Badges/chips (tags, roles, sync state):** pill, soft semantic fills
  (`--accent-soft`, `--success-soft`, …) with matching strong text color.
- **Avatars:** circular, 24px, deterministic user color, white 2px ring when overlapping in a stack.

## Voice

Clean, calm, spacious. When in doubt: more whitespace, fewer borders, softer shadow,
rounder corner. This is a premium, focused writing tool — not a dense dashboard.

## Hard rules

1. Every color/spacing/radius/shadow comes from `tokens.css` variables. No hardcoded values.
2. Both themes must look intentional — check every surface in light AND dark.
3. Don't change component behavior/props/IPC — this is a reskin, not a refactor
   (small DOM/classname changes are fine).
4. All existing tests and builds must stay green.
