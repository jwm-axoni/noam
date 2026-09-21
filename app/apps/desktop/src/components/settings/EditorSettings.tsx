// SPDX-License-Identifier: Apache-2.0

import type { PropertiesMode } from "../../lib/editor/frontmatter";
import type { ViewMode } from "../../lib/editor/viewMode";
import {
  EDITOR_MEASURE_SLIDER_MAX,
  EDITOR_MEASURE_SLIDER_MIN,
  EDITOR_MEASURE_STEP,
  measureLabel,
  measureToSlider,
  sliderToMeasure,
} from "../../lib/editorMeasure";
import { PROPERTIES_MODES, VIEW_MODE_OPTIONS } from "../../lib/prefs";
import { useStore } from "../../store";
import { ContentWidthPreview } from "../ContentWidthPreview";
import { MenuSelect } from "../MenuSelect";
import { Switch } from "../Switch";
import { SettingRow } from "./SettingRow";

export function EditorSettings() {
  const propertiesMode = useStore((state) => state.propertiesMode);
  const defaultViewMode = useStore((state) => state.defaultViewMode);
  const editorMeasure = useStore((state) => state.editorMeasure);
  const lineNumbers = useStore((state) => state.lineNumbers);

  return (
    <>
      <SettingRow
        id="content-width"
        className="setting-row-stack"
        label={<label htmlFor="settings-content-width">Content width</label>}
        description="How wide note text runs before it wraps. Drag to the end for the full pane."
      >
        <span className="range-field">
          <input
            id="settings-content-width"
            className="range-input"
            type="range"
            min={EDITOR_MEASURE_SLIDER_MIN}
            max={EDITOR_MEASURE_SLIDER_MAX}
            step={EDITOR_MEASURE_STEP}
            value={measureToSlider(editorMeasure)}
            aria-label="Content width"
            aria-valuetext={measureLabel(editorMeasure)}
            onChange={(event) =>
              useStore
                .getState()
                .setEditorMeasure(sliderToMeasure(Number(event.target.value)))
            }
          />
          <span className="range-value">{measureLabel(editorMeasure)}</span>
        </span>
        <ContentWidthPreview measure={editorMeasure} />
      </SettingRow>

      <SettingRow
        id="line-numbers"
        label="Line numbers"
        description="Show a line-number gutter in the editor."
      >
        <Switch
          checked={lineNumbers}
          ariaLabel="Line numbers"
          onChange={(next) => useStore.getState().setLineNumbers(next)}
        />
      </SettingRow>

      <SettingRow
        id="default-view-mode"
        label="Default view mode"
        description="How Markdown notes open when they have no session override."
      >
        <MenuSelect<ViewMode>
          value={defaultViewMode}
          options={VIEW_MODE_OPTIONS.map((mode) => ({
            value: mode.id,
            label: mode.label,
            hint: mode.hint,
          }))}
          onSelect={(mode) => useStore.getState().setDefaultViewMode(mode)}
          ariaLabel="Default view mode"
          triggerClassName="role-field-trigger"
        />
      </SettingRow>

      <SettingRow
        id="properties-display"
        label="Properties in document"
        description="How a note's YAML frontmatter is shown at the top of the note."
      >
        <MenuSelect<PropertiesMode>
          value={propertiesMode}
          options={PROPERTIES_MODES.map((mode) => ({
            value: mode.id,
            label: mode.label,
            hint: mode.hint,
          }))}
          onSelect={(mode) => useStore.getState().setPropertiesMode(mode)}
          ariaLabel="Properties in document"
          triggerClassName="role-field-trigger"
        />
      </SettingRow>
    </>
  );
}
