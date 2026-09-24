// The editor's prose column, in the three shapes the app needs it: the stored
// preference (a measure in `ch`, or "full"), the slider position that sets it,
// and the CSS custom property the whole editor follows. One module so those
// three can never disagree — and so the geometry the Settings preview draws is
// the same arithmetic the browser performs, not a second guess at it.

import type { CSSProperties } from "react";
import {
  clampEditorMeasure,
  clampEditorFontSize,
  EDITOR_FONT_SIZE_DEFAULT,
  EDITOR_MEASURE_MAX,
  EDITOR_MEASURE_MIN,
  EDITOR_MEASURE_STEP,
  type EditorMeasure,
} from "./prefs";

/** The widest share of the pane the column may take, however wide the measure:
 *  Obsidian Minimal's `maxWidth: 88%`. Must match `--editor-pad-x` in tokens.css. */
export const EDITOR_MAX_FRACTION = 0.88;
export const EDITOR_WIDE_MEASURE = 90;

/** The slider starts at the narrowest real measure. */
export const EDITOR_MEASURE_SLIDER_MIN = EDITOR_MEASURE_MIN;
/** The final slider stop selects the bounded Wide preset, stored as "full"
 *  for compatibility with existing preferences. */
export const EDITOR_MEASURE_SLIDER_MAX = EDITOR_MEASURE_MAX + EDITOR_MEASURE_STEP;
/** The pref's own step, re-exported so one import wires the whole control. */
export { EDITOR_MEASURE_STEP } from "./prefs";

/** Slider position → preference. The top stop is tested FIRST, so anything at
 *  or past it — `Infinity` included — selects Wide; everything else goes
 *  through the clamp, which snaps to the step, pins `-Infinity` to the narrowest
 *  measure and answers NaN with the default. */
export function sliderToMeasure(pos: number): EditorMeasure {
  if (pos >= EDITOR_MEASURE_SLIDER_MAX) return "full";
  return clampEditorMeasure(pos);
}

/** Preference → slider position. */
export function measureToSlider(measure: EditorMeasure): number {
  return measure === "full" ? EDITOR_MEASURE_SLIDER_MAX : clampEditorMeasure(measure);
}

/** The readout beside the slider, and the slider's own `aria-valuetext`. */
export function measureLabel(measure: EditorMeasure): string {
  return measure === "full" ? "Wide" : `${measure} characters`;
}

/** A style object rather than a class: the value is a number the user picked,
 *  so there is no class to name. Setting the token on `.editor-column` is the
 *  whole implementation — `--editor-pad-x` and its eleven consumers (the
 *  `.cm-line` inset, the block widgets, the rules, the loading skeleton) follow
 *  it with no JavaScript at all. */
type MeasureStyle = CSSProperties & Record<"--editor-measure" | "--type-document-size", string>;

export function editorMeasureStyle(measure: EditorMeasure, fontSize = EDITOR_FONT_SIZE_DEFAULT): MeasureStyle {
  return {
    "--editor-measure": `${measure === "full" ? EDITOR_WIDE_MEASURE : measure}ch`,
    "--type-document-size": `${clampEditorFontSize(fontSize)}px`,
  };
}

export interface PreviewColumnInput {
  /** The real editor pane's width, in CSS px. */
  paneWidth: number;
  /** `--editor-gutter`: the minimum breathing room at each edge. */
  gutterPx: number;
  /** The chosen measure converted to px (one `ch` measured in the editor's own
   *  font), or "full". */
  measurePx: number | "full";
  /** The width the miniature is drawn at. */
  previewWidth: number;
}

export interface PreviewColumn {
  /** The column's width inside the miniature. */
  columnPx: number;
  /** The air at each side of it; `2 × inset + column === previewWidth`. */
  insetPx: number;
}

/**
 * The Settings preview's geometry, to scale.
 *
 * The column is capped by its chosen measure, the minimum gutters, and 88% of
 * the pane. The component converts Wide to 90ch in pixels before calling this
 * helper. The legacy "full" input means the pane cap without a measure cap.
 * Scale the resulting column by `preview / pane` to draw the miniature.
 */
export function computePreviewColumn(input: PreviewColumnInput): PreviewColumn {
  const { gutterPx, measurePx, previewWidth } = input;
  // A preview opened with no editor mounted has no pane to scale against; draw
  // it at 1:1 rather than dividing by zero.
  const pane = input.paneWidth > 0 ? input.paneWidth : previewWidth;
  // Mirrors `--editor-pad-x`: the gutters, and the 88% cap on the column.
  const widest = Math.max(0, Math.min(pane - 2 * Math.max(0, gutterPx), pane * EDITOR_MAX_FRACTION));
  const real = measurePx === "full" ? widest : Math.max(0, Math.min(measurePx, widest));
  const scale = pane > 0 ? previewWidth / pane : 1;
  const columnPx = Math.max(0, Math.min(previewWidth, real * scale));
  return { columnPx, insetPx: Math.max(0, (previewWidth - columnPx) / 2) };
}
