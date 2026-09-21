// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export function SettingRow({
  id,
  label,
  description,
  children,
  className = "",
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`setting-row${className ? ` ${className}` : ""}`}
      data-setting-id={id}
      tabIndex={-1}
    >
      <div className="setting-row-copy">
        <div className="setting-row-label">{label}</div>
        {description && <div className="setting-row-description">{description}</div>}
      </div>
      {children && <div className="setting-row-control">{children}</div>}
    </div>
  );
}
