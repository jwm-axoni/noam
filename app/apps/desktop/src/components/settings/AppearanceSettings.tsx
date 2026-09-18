import { ThemeToggle } from "../ThemeToggle";
import { SettingRow } from "./SettingRow";

export function AppearanceSettings() {
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
        id="note-typography"
        label="Note typography"
        description="Noam uses its bundled reading typeface for note text, so notes remain available offline."
      >
        <span className="setting-static-value">Open Sauce Two</span>
      </SettingRow>
    </>
  );
}
