// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { SettingsSectionId } from "./settingsRegistry";

export function SettingsSection({
  id,
  title,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="settings-content"
      aria-labelledby={`settings-section-${id}`}
      data-settings-section={id}
    >
      <h2 id={`settings-section-${id}`} className="settings-section-title" tabIndex={-1}>
        {title}
      </h2>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
