import { describe, expect, it } from "vitest";
import {
  availableSettingsSections,
  requestedSettingsSection,
  resolveSettingsSection,
  searchSettings,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
} from "./settingsRegistry";

describe("settings registry", () => {
  it("maps every section to the normative navigation group", () => {
    const mapping = Object.fromEntries(
      SETTINGS_GROUPS.map((group) => [
        group.label,
        SETTINGS_SECTIONS.filter((section) => section.group === group.id).map(
          (section) => section.label,
        ),
      ]),
    );

    expect(mapping).toEqual({
      Options: ["General", "Appearance", "Interface", "Editor"],
      Vault: ["Vaults", "Import / Export", "MCP", "Versioning"],
      Account: ["Profile", "Activity status", "Notifications", "Connection"],
      Team: ["Members", "Access", "Billing"],
      Application: ["Updates", "About"],
    });
  });

  it("keeps local device preferences available without a session", () => {
    const sections = availableSettingsSections({
      hasSession: false,
      hasVault: true,
      hasKnownVaults: true,
      billingEnabled: false,
    }).map((section) => section.id);

    expect(sections).toEqual(expect.arrayContaining(["appearance", "interface", "editor"]));
    expect(sections).not.toContain("profile");
    expect(sections).not.toContain("billing");
  });
});

describe("settings search", () => {
  it("indexes labels, descriptions, and keywords and ranks direct labels first", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      sectionId: "appearance",
      settingId: "theme",
    });
    expect(searchSettings("wide note text")[0]).toMatchObject({
      sectionId: "editor",
      settingId: "content-width",
    });
    expect(searchSettings("yaml frontmatter")[0]).toMatchObject({
      sectionId: "editor",
      settingId: "properties-display",
    });
    expect(searchSettings("subscription")[0]).toMatchObject({ sectionId: "billing" });
    expect(searchSettings("token")[0]).toMatchObject({
      sectionId: "mcp",
      settingId: "mcp-tokens",
    });
    expect(searchSettings("join code")[0]).toMatchObject({
      sectionId: "members",
      settingId: "join-code",
    });
    expect(searchSettings("endpoint url")[0]).toMatchObject({
      sectionId: "mcp",
      settingId: "mcp-endpoint",
    });
    expect(searchSettings("avatar image url")[0]).toMatchObject({
      sectionId: "profile",
      settingId: "avatar",
    });
  });

  it("returns no results for blank or unrelated searches", () => {
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("quasar-flux-capacitor")).toEqual([]);
    expect(searchSettings("editor quasar")).toEqual([]);
  });
});

describe("settings deep links", () => {
  it("selects explicit sections and compatibility aliases", () => {
    expect(requestedSettingsSection(" EDITOR ")).toBe("editor");
    expect(requestedSettingsSection("activity-status")).toBe("status");
    expect(requestedSettingsSection("unknown")).toBeNull();
    expect(resolveSettingsSection("editor")).toBe("editor");
    expect(resolveSettingsSection("activity-status")).toBe("status");
    expect(resolveSettingsSection("theme")).toBe("appearance");
  });

  it("falls back to the first safe visible section", () => {
    const signedOut = availableSettingsSections({
      hasSession: false,
      hasVault: true,
      hasKnownVaults: true,
      billingEnabled: false,
    });
    expect(resolveSettingsSection("profile", signedOut)).toBe("general");
    expect(resolveSettingsSection("unknown", signedOut)).toBe("general");
  });
});
