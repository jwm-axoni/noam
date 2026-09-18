import type { ReactNode } from "react";
import {
  SETTINGS_GROUPS,
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "./settingsRegistry";

function SettingsIcon({ name }: { name: SettingsSectionDefinition["icon"] }) {
  let content: ReactNode;
  switch (name) {
    case "sliders":
      content = <><path d="M4 21v-6M4 11V3M12 21v-8M12 9V3M20 21v-4M20 13V3" /><path d="M1 15h6M9 9h6M17 17h6" /></>;
      break;
    case "sun":
      content = <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>;
      break;
    case "layout":
      content = <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16M16 4v16" /></>;
      break;
    case "edit":
      content = <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></>;
      break;
    case "vault":
      content = <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>;
      break;
    case "transfer":
      content = <><path d="M12 3v10" /><path d="m8 9 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>;
      break;
    case "terminal":
      content = <><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>;
      break;
    case "history":
      content = <><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>;
      break;
    case "user":
      content = <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>;
      break;
    case "status":
      content = <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></>;
      break;
    case "bell":
      content = <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>;
      break;
    case "server":
      content = <><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01M6 18h.01" /></>;
      break;
    case "members":
      content = <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>;
      break;
    case "lock":
      content = <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>;
      break;
    case "card":
      content = <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>;
      break;
    case "refresh":
      content = <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v5h-5" /></>;
      break;
    case "info":
      content = <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>;
      break;
  }
  return (
    <svg className="settings-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {content}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="settings-nav-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function SettingsNav({
  sections,
  activeSection,
  lockedSections,
  query,
  onQueryChange,
  onSelect,
}: {
  sections: readonly SettingsSectionDefinition[];
  activeSection: SettingsSectionId;
  lockedSections: ReadonlySet<SettingsSectionId>;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (section: SettingsSectionId) => void;
}) {
  return (
    <aside className="settings-nav-pane">
      <div className="settings-search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </svg>
        <input
          className="settings-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
        />
      </div>
      <nav className="settings-nav" aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => {
          const groupSections = sections.filter((section) => section.group === group.id);
          if (groupSections.length === 0) return null;
          return (
            <div className="settings-nav-group" key={group.id}>
              <div className="settings-nav-group-label">{group.label}</div>
              {groupSections.map((section) => {
                const locked = lockedSections.has(section.id);
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={`settings-nav-item${activeSection === section.id && !query ? " active" : ""}${locked ? " locked" : ""}`}
                    aria-current={activeSection === section.id && !query ? "page" : undefined}
                    title={locked ? "Turn on sync to unlock" : undefined}
                    onClick={() => onSelect(section.id)}
                  >
                    <SettingsIcon name={section.icon} />
                    <span>{section.label}</span>
                    {locked && <LockIcon />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
