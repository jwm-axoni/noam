// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import {
  ACCENT_THEMES,
  readAccentTheme,
  setAccentTheme,
  type AccentTheme,
} from "../../lib/prefs";

/**
 * Appearance → Accent. Native radios (arrow keys, one tab stop, announced as a
 * group) behind a visual tile per world. Each tile's swatch carries its own
 * `data-accent`, so the same `[data-accent]` token blocks that paint the app
 * paint the preview — every world shows its true surface + accent in the
 * current light/dark theme without a second copy of the values.
 */
export function AccentPicker() {
  const [accent, setAccent] = useState<AccentTheme>(() => readAccentTheme());
  const name = useId();

  return (
    <fieldset className="accent-picker">
      <legend className="visually-hidden">Accent</legend>
      {ACCENT_THEMES.map((theme) => {
        const checked = theme.id === accent;
        return (
          <label
            key={theme.id}
            className={`accent-option${checked ? " on" : ""}`}
            title={theme.hint}
          >
            <input
              type="radio"
              name={name}
              value={theme.id}
              checked={checked}
              onChange={() => {
                setAccentTheme(theme.id);
                setAccent(theme.id);
              }}
              aria-describedby={`${name}-${theme.id}-hint`}
            />
            <span className="accent-option-body">
              <span className="accent-option-swatch" data-accent={theme.id} aria-hidden="true">
                <span className="accent-option-dot" />
              </span>
              <span className="accent-option-label">{theme.label}</span>
            </span>
            <span id={`${name}-${theme.id}-hint`} className="visually-hidden">
              {theme.hint}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
