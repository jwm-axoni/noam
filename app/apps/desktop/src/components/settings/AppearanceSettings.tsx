// SPDX-License-Identifier: Apache-2.0

import { useState, type KeyboardEvent } from "react";
import {
  EDITOR_FONT_SIZE_MIN,
  EDITOR_FONT_SIZE_MAX,
  readHeadingColorMode,
  setHeadingColorMode,
  type HeadingColorMode,
} from "../../lib/prefs";
import { useStore } from "../../store";
import { MenuSelect } from "../MenuSelect";
import { ThemeToggle } from "../ThemeToggle";
import { SettingRow } from "./SettingRow";
import {
  getThemeAccent,
  getThemePreset,
  setThemeAccent,
  setThemePreset,
  THEME_ACCENTS,
  THEME_PRESETS,
  type ThemeAccent,
  type ThemePreset,
} from "../../lib/theme";

export function AppearanceSettings() {
  const fontSize = useStore((state) => state.editorFontSize);
  const [headingColor, setHeadingColor] = useState<HeadingColorMode>(() =>
    readHeadingColorMode(),
  );
  const [preset, setPreset] = useState<ThemePreset>(() => getThemePreset());
  const [accent, setAccent] = useState<ThemeAccent | null>(() => getThemeAccent());

  const moveRadio = <T extends string | null>(
    event: KeyboardEvent<HTMLButtonElement>,
    values: readonly T[],
    current: T,
    choose: (value: T) => void,
    attribute: string,
  ) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = values.indexOf(current);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? values.length - 1
          : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
              values.length) %
            values.length;
    const next = values[nextIndex];
    choose(next);
    const selector = `[${attribute}="${next ?? "default"}"]`;
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(selector)?.focus();
  };

  return (
    <>
      <SettingRow
        id="theme"
        label="Theme"
        description="Use a light, dark, or system appearance on this device."
      >
        <ThemeToggle />
      </SettingRow>
      <SettingRow
        id="theme-preset"
        label="Palette"
        description="Choose a colour palette independently from the light, dark, or system setting."
        className="theme-preset-setting"
      >
        <div className="theme-preset-grid" role="radiogroup" aria-label="Theme palette">
          {THEME_PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`theme-preset-card${preset === option.id ? " selected" : ""}`}
              role="radio"
              aria-checked={preset === option.id}
              tabIndex={preset === option.id ? 0 : -1}
              data-theme-preset-id={option.id}
              onClick={() => {
                setThemePreset(option.id);
                setPreset(option.id);
              }}
              onKeyDown={(event) =>
                moveRadio(
                  event,
                  THEME_PRESETS.map((item) => item.id),
                  preset,
                  (value) => {
                    setThemePreset(value);
                    setPreset(value);
                  },
                  "data-theme-preset-id",
                )
              }
            >
              <span className="theme-preset-preview" aria-hidden="true">
                {option.swatches.map((color) => (
                  <span key={color} style={{ backgroundColor: color }} />
                ))}
              </span>
              <span className="theme-preset-name">{option.label}</span>
              <span className="theme-preset-description">{option.description}</span>
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        id="heading-color"
        label="Heading colour"
        description="Use theme colours to distinguish note heading levels, or keep every heading plain."
      >
        <MenuSelect<HeadingColorMode>
          value={headingColor}
          options={[
            {
              value: "themed",
              label: "Themed",
              hint: "Distinct colours from the active theme",
            },
            {
              value: "plain",
              label: "Plain",
              hint: "Use the normal note text colour",
            },
          ]}
          onSelect={(mode) => {
            setHeadingColorMode(mode);
            setHeadingColor(mode);
          }}
          ariaLabel="Heading colour"
          triggerClassName="role-field-trigger"
        />
      </SettingRow>
      <SettingRow
        id="theme-accent"
        label="Accent"
        description="Override the palette accent without changing the palette or display mode."
        className="theme-accent-setting"
      >
        <div className="theme-accent-grid" role="radiogroup" aria-label="Theme accent">
          {[
            { id: null, label: "Palette", value: "linear-gradient(135deg, #7f73ff, #8a5a00)" },
            ...THEME_ACCENTS,
          ].map((option) => (
            <button
              key={option.id ?? "default"}
              type="button"
              className={`theme-accent-choice${accent === option.id ? " selected" : ""}`}
              role="radio"
              aria-checked={accent === option.id}
              aria-label={`${option.label} accent`}
              tabIndex={accent === option.id ? 0 : -1}
              data-theme-accent-id={option.id ?? "default"}
              onClick={() => {
                setThemeAccent(option.id);
                setAccent(option.id);
              }}
              onKeyDown={(event) =>
                moveRadio(
                  event,
                  [null, ...THEME_ACCENTS.map((item) => item.id)],
                  accent,
                  (value) => {
                    setThemeAccent(value);
                    setAccent(value);
                  },
                  "data-theme-accent-id",
                )
              }
            >
              <span className="theme-accent-swatch" style={{ background: option.value }} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        id="note-typography"
        label={<label htmlFor="settings-editor-font-size">Note font size</label>}
        description="Adjust note text size on this device."
        className="setting-row-stack"
      >
        <span className="range-field">
          <input id="settings-editor-font-size" className="range-input" type="range"
            min={EDITOR_FONT_SIZE_MIN} max={EDITOR_FONT_SIZE_MAX} step={1}
            value={fontSize} aria-label="Note font size" aria-valuetext={`${fontSize} pixels`}
            onChange={(event) => useStore.getState().setEditorFontSize(Number(event.target.value))} />
          <span className="range-value">{fontSize}px</span>
        </span>
        <p style={{ fontFamily: "var(--font-body)", fontSize: `${fontSize}px`, lineHeight: 1.6, margin: 0 }}>
          A place for your notes, ideas, and the connections between them.
        </p>
      </SettingRow>
    </>
  );
}
