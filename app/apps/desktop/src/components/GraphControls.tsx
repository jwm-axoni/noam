// Minimalistic settings panel for the Graph View. Pure controlled component:
// it holds no physics or canvas state — it only renders inputs bound to the
// shared GraphSettings shape and emits partial patches upward. All visual
// styling lives in graph.css (plus the app-wide `.range-input` / `.range-value`
// in App.css); this file just emits the agreed class names.

import type { GraphSettings, ColorMode } from "../lib/graph/graphSettings";
import { SETTING_RANGES } from "../lib/graph/graphSettings";
import type { LegendEntry } from "../lib/graph/graphColor";

export interface GraphControlsProps {
  idPrefix: string;
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings>) => void;
  onReset: () => void;
  legend: LegendEntry[];
  hasCurrentNote: boolean;
}

/** Numeric settings that get a labeled range slider, with friendly labels. */
type SliderKey = keyof typeof SETTING_RANGES;

const SLIDER_LABELS: Record<SliderKey, string> = {
  charge: "Repulsion",
  linkDistance: "Link distance",
  linkStrength: "Link force",
  gravity: "Gravity",
  nodeSize: "Node size",
  edgeThickness: "Edge width",
  labelScale: "Labels",
  minDegree: "Min links",
};

const COLOR_MODES: { mode: ColorMode; label: string }[] = [
  { mode: "type", label: "Type" },
  { mode: "folder", label: "Folder" },
  { mode: "degree", label: "Degree" },
  { mode: "uniform", label: "Uniform" },
];

/** Round a slider value for display: integers stay whole, fractional steps
 *  keep just enough precision to read cleanly (e.g. 0.3, 1.2). */
function formatValue(key: SliderKey, value: number): string {
  const step = SETTING_RANGES[key].step;
  if (Number.isInteger(step)) return String(Math.round(value));
  // step < 1 → show 1–2 decimals depending on granularity.
  const decimals = step < 0.05 ? 2 : step < 0.1 ? 2 : 1;
  return value.toFixed(decimals);
}

export function GraphControls(props: GraphControlsProps): React.JSX.Element {
  const { idPrefix, settings, onChange, onReset, legend, hasCurrentNote } = props;

  // One slider row: friendly label, native range input, live numeric readout.
  const slider = (key: SliderKey) => {
    const range = SETTING_RANGES[key];
    const value = settings[key] as number;
    const inputId = `${idPrefix}-${key}`;
    return (
      <div className="graph-control-row" key={key}>
        <label htmlFor={inputId}>{SLIDER_LABELS[key]}</label>
        <input
          id={inputId}
          className="range-input"
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          onChange={(e) => onChange({ [key]: Number(e.target.value) })}
        />
        <span className="range-value">{formatValue(key, value)}</span>
      </div>
    );
  };

  return (
    <div className="graph-controls">
      <div className="graph-control-group">
        <div className="graph-control-group-title">Scope</div>
        <div
          className="graph-seg graph-scope-seg"
          role="group"
          aria-label="Graph scope"
        >
          <button
            type="button"
            className={"graph-seg-btn" + (settings.scope === "global" ? " is-active" : "")}
            aria-pressed={settings.scope === "global"}
            onClick={() => onChange({ scope: "global" })}
          >
            Vault
          </button>
          <button
            type="button"
            className={"graph-seg-btn" + (settings.scope === "local" ? " is-active" : "")}
            aria-pressed={settings.scope === "local"}
            disabled={!hasCurrentNote}
            title={
              hasCurrentNote
                ? "Show the current note and its links"
                : "Open a note to use this scope"
            }
            onClick={() => onChange({ scope: "local" })}
          >
            Current note
          </button>
        </div>
        {!hasCurrentNote && (
          <div className="graph-control-hint">Open a note to use Current note.</div>
        )}
        {settings.scope === "local" && hasCurrentNote && (
          <div className="graph-control-row">
            <label>Depth</label>
            <div className="graph-seg" role="group" aria-label="Local graph depth">
              {[1, 2].map((depth) => (
                <button
                  key={depth}
                  type="button"
                  className={
                    "graph-seg-btn" + (settings.localDepth === depth ? " is-active" : "")
                  }
                  aria-pressed={settings.localDepth === depth}
                  onClick={() => onChange({ localDepth: depth })}
                >
                  {depth}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Forces</div>
        {slider("charge")}
        {slider("linkDistance")}
        {slider("linkStrength")}
        {slider("gravity")}
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Appearance</div>
        {slider("nodeSize")}
        {slider("edgeThickness")}
        {slider("labelScale")}
        <div className="graph-control-row">
          <label>Color by</label>
          <div className="graph-seg" role="group" aria-label="Color mode">
            {COLOR_MODES.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                className={
                  "graph-seg-btn" + (settings.colorMode === mode ? " is-active" : "")
                }
                aria-pressed={settings.colorMode === mode}
                onClick={() => onChange({ colorMode: mode as ColorMode })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Filter</div>
        <div className="graph-control-row">
          <input
            type="text"
            className="graph-control-search"
            placeholder="Filter by title…"
            value={settings.search}
            onChange={(e) => onChange({ search: e.target.value })}
          />
        </div>
        {slider("minDegree")}
        <div className="graph-control-row">
          <label htmlFor={`${idPrefix}-hideOrphans`}>Hide unlinked</label>
          <input
            id={`${idPrefix}-hideOrphans`}
            type="checkbox"
            checked={settings.hideOrphans}
            onChange={(e) => onChange({ hideOrphans: e.target.checked })}
          />
        </div>
      </div>

      {legend.length > 0 && (
        <div className="graph-control-group">
          <div className="graph-control-group-title">Legend</div>
          <div className="graph-legend">
            {legend.map((entry) => (
              <div className="graph-legend-row" key={entry.label}>
                <span
                  className="graph-legend-dot"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
                <span className="graph-legend-count">{entry.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="graph-control-footer">
        <button type="button" className="graph-control-reset" onClick={onReset}>
          Reset graph appearance
        </button>
      </div>
    </div>
  );
}
