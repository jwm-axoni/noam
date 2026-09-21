// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccountSettingsSection,
  type AccountSettingsSectionId,
} from "../AccountSettings";
import { SettingsModal } from "../SettingsModal";
import {
  VaultSettingsSection,
  type VaultSettingsSectionId,
} from "../VaultSettingsDialog";
import { useLocalVaults } from "../useVaultLists";
import { useStore } from "../../store";
import { AppearanceSettings } from "./AppearanceSettings";
import { EditorSettings } from "./EditorSettings";
import { InterfaceSettings } from "./InterfaceSettings";
import { SettingsNav } from "./SettingsNav";
import { SettingsSection } from "./SettingsSection";
import {
  availableSettingsSections,
  requestedSettingsSection,
  resolveSettingsSection,
  searchSettings,
  type SettingsSectionId,
} from "./settingsRegistry";
import { settingsSearchFocusTarget } from "./focusContainment";
import "../../styles/settings.css";

const SYNC_LOCKED_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  "members",
  "access",
  "mcp",
  "versioning",
]);

function eventSection(event: Event): unknown {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  if (detail && typeof detail === "object" && "section" in detail) {
    return (detail as { section?: unknown }).section;
  }
  return detail;
}

export function SettingsDialog({
  onClose,
  onRequestSignIn,
  initialSection,
}: {
  onClose: () => void;
  onRequestSignIn?: () => void;
  initialSection?: SettingsSectionId | string;
}) {
  const session = useStore((state) => state.session);
  const organizations = useStore((state) => state.organizations);
  const members = useStore((state) => state.members);
  const billingConfig = useStore((state) => state.billingConfig);
  const syncEnabled = useStore((state) => state.syncEnabled);
  const vault = useStore((state) => state.vault);
  const localVaults = useLocalVaults();
  const activeOrg =
    organizations.find((organization) => organization.id === session?.activeOrganizationId) ??
    null;
  const isSynced = syncEnabled && activeOrg != null;
  const myMember = members.find((member) => member.userId === session?.user.id);
  const canManage = myMember?.role === "owner" || myMember?.role === "admin";
  const sections = useMemo(
    () =>
      availableSettingsSections({
        hasSession: session != null,
        hasVault: vault != null,
        hasKnownVaults: localVaults.length > 0,
        billingEnabled: billingConfig?.enabled === true,
      }),
    [session, vault, localVaults.length, billingConfig?.enabled],
  );
  const sectionKey = sections.map((section) => section.id).join(":");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    resolveSettingsSection(initialSection, sections),
  );
  const pendingSectionRef = useRef<SettingsSectionId | null>((() => {
    const requested = requestedSettingsSection(initialSection);
    return requested && !sections.some((section) => section.id === requested)
      ? requested
      : null;
  })());
  const [query, setQuery] = useState("");
  const [pendingFocus, setPendingFocus] = useState<{
    section: SettingsSectionId;
    settingId: string | null;
  } | null>(null);

  useEffect(() => {
    const requested = requestedSettingsSection(initialSection);
    pendingSectionRef.current =
      requested && !sections.some((section) => section.id === requested)
        ? requested
        : null;
    setActiveSection(resolveSettingsSection(initialSection, sections));
  }, [initialSection]);

  useEffect(() => {
    const pending = pendingSectionRef.current;
    if (pending && sections.some((section) => section.id === pending)) {
      pendingSectionRef.current = null;
      setActiveSection(pending);
      return;
    }
    setActiveSection((current) =>
      sections.some((section) => section.id === current)
        ? current
        : resolveSettingsSection(initialSection, sections),
    );
  }, [sectionKey, sections, initialSection]);

  useEffect(() => {
    const onDeepLink = (event: Event) => {
      const detail = eventSection(event);
      const requested = requestedSettingsSection(detail);
      pendingSectionRef.current =
        requested && !sections.some((section) => section.id === requested)
          ? requested
          : null;
      setQuery("");
      setActiveSection(resolveSettingsSection(detail, sections));
    };
    window.addEventListener("noam:open-settings", onDeepLink);
    return () => window.removeEventListener("noam:open-settings", onDeepLink);
  }, [sections]);

  useEffect(() => {
    if (!pendingFocus || query || pendingFocus.section !== activeSection) return;
    const section = document.querySelector<HTMLElement>(
      `[data-settings-section="${activeSection}"]`,
    );
    if (!section) return;
    const target = settingsSearchFocusTarget(section, pendingFocus.settingId);
    target?.scrollTarget.scrollIntoView?.({ block: "center" });
    target?.focusTarget.focus({ preventScroll: true });
    setPendingFocus(null);
  }, [activeSection, pendingFocus, query]);

  const searchableSections = useMemo(
    () =>
      sections.map((section) => {
        let settings = section.settings;
        if (!isSynced && SYNC_LOCKED_SECTIONS.has(section.id)) settings = [];
        if (!isSynced && section.id === "general") {
          settings = settings.filter((setting) => setting.id !== "freeze-root");
        }
        if (!session && section.id === "about") {
          settings = settings.filter((setting) => setting.id !== "sign-out");
        }
        return settings === section.settings ? section : { ...section, settings };
      }),
    [sections, isSynced, session],
  );
  const searchResults = useMemo(
    () => searchSettings(query, searchableSections),
    [query, searchableSections],
  );
  const activeDefinition =
    sections.find((section) => section.id === activeSection) ?? sections[0];
  const lockedSections = useMemo(
    () =>
      new Set(
        isSynced
          ? []
          : sections
              .filter((section) => SYNC_LOCKED_SECTIONS.has(section.id))
              .map((section) => section.id),
      ),
    [isSynced, sections],
  );

  const selectSection = (section: SettingsSectionId) => {
    pendingSectionRef.current = null;
    setQuery("");
    setActiveSection(section);
    setPendingFocus(null);
  };

  const renderSection = () => {
    switch (activeSection) {
      case "appearance":
        return <AppearanceSettings />;
      case "interface":
        return <InterfaceSettings />;
      case "editor":
        return <EditorSettings />;
      case "profile":
      case "status":
      case "notifications":
      case "connection":
      case "about":
        return (
          <AccountSettingsSection
            section={activeSection as AccountSettingsSectionId}
            onClose={onClose}
          />
        );
      default:
        return (
          <VaultSettingsSection
            section={activeSection as VaultSettingsSectionId}
            isSynced={isSynced}
            canManage={canManage}
            activeOrgName={activeOrg?.name ?? null}
            onRequestSignIn={onRequestSignIn}
            onNavigate={selectSection}
          />
        );
    }
  };

  return (
    <SettingsModal label={`Settings — ${vault?.name ?? "Noam"}`} onClose={onClose}>
      <header className="settings-page-header">
        <div className="settings-title">
          <h1>Settings — {vault?.name ?? "Noam"}</h1>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close settings"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>

      <div className="settings-body">
        <SettingsNav
          sections={sections}
          activeSection={activeSection}
          lockedSections={lockedSections}
          query={query}
          onQueryChange={setQuery}
          onSelect={selectSection}
        />

        {query.trim() ? (
          <section className="settings-content settings-search-results" aria-label="Search results">
            <div className="settings-search-heading">
              <h2 className="settings-section-title">Search results</h2>
              <button type="button" className="link-btn" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
            {searchResults.length > 0 ? (
              <div className="settings-result-list">
                {searchResults.map((result) => (
                  <button
                    key={`${result.sectionId}:${result.settingId ?? "section"}`}
                    type="button"
                    className="settings-result"
                    onClick={() => {
                      pendingSectionRef.current = null;
                      setActiveSection(result.sectionId);
                      setPendingFocus({
                        section: result.sectionId,
                        settingId: result.settingId,
                      });
                      setQuery("");
                    }}
                  >
                    <span className="settings-result-section">{result.sectionLabel}</span>
                    <strong>{result.label}</strong>
                    <span>{result.description}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="settings-search-empty">
                <p>No settings match “{query.trim()}”.</p>
                <button type="button" className="secondary sm" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </div>
            )}
          </section>
        ) : activeDefinition ? (
          <SettingsSection id={activeDefinition.id} title={activeDefinition.label}>
            {renderSection()}
          </SettingsSection>
        ) : null}
      </div>
    </SettingsModal>
  );
}
