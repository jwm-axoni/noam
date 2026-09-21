// SPDX-License-Identifier: Apache-2.0

export const SETTINGS_GROUP_IDS = [
  "options",
  "vault",
  "account",
  "team",
  "application",
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

export const SETTINGS_SECTION_IDS = [
  "general",
  "appearance",
  "interface",
  "editor",
  "vaults",
  "import-export",
  "mcp",
  "versioning",
  "profile",
  "status",
  "notifications",
  "connection",
  "members",
  "access",
  "billing",
  "updates",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingSearchEntry {
  id: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
}

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  group: SettingsGroupId;
  label: string;
  icon:
    | "sliders"
    | "sun"
    | "layout"
    | "edit"
    | "vault"
    | "transfer"
    | "terminal"
    | "history"
    | "user"
    | "status"
    | "bell"
    | "server"
    | "members"
    | "lock"
    | "card"
    | "refresh"
    | "info";
  settings: readonly SettingSearchEntry[];
}

export interface SettingsGroupDefinition {
  id: SettingsGroupId;
  label: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroupDefinition[] = [
  { id: "options", label: "Options" },
  { id: "vault", label: "Vault" },
  { id: "account", label: "Account" },
  { id: "team", label: "Team" },
  { id: "application", label: "Application" },
];

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: "general",
    group: "options",
    label: "General",
    icon: "sliders",
    settings: [
      { id: "vault-name", label: "Vault name", description: "The name and folder of this vault." },
      { id: "vault-sync", label: "Vault sync", description: "Turn sync on or inspect its current state." },
      { id: "freeze-root", label: "Freeze vault root", description: "Protect items at the vault root." },
    ],
  },
  {
    id: "appearance",
    group: "options",
    label: "Appearance",
    icon: "sun",
    settings: [
      {
        id: "theme",
        label: "Theme",
        description: "Use a light, dark, or system appearance on this device.",
        keywords: ["color scheme", "light mode", "dark mode"],
      },
      {
        id: "accent",
        label: "Accent",
        description: "Choose the colour world for controls, selection and links.",
        keywords: ["colour", "color", "brand", "palette", "ink", "violet", "sea", "terracotta", "moss"],
      },
      {
        id: "heading-color",
        label: "Heading colour",
        description: "Choose themed or plain colours for note headings.",
        keywords: ["markdown", "header", "heading color"],
      },
      {
        id: "note-typography",
        label: "Note typography",
        description: "Typography used to read and edit notes.",
        keywords: ["font", "text"],
      },
    ],
  },
  {
    id: "interface",
    group: "options",
    label: "Interface",
    icon: "layout",
    settings: [
      { id: "left-dock", label: "Left dock", description: "Show or hide the left workspace dock." },
      { id: "right-dock", label: "Right dock", description: "Show or hide the right workspace dock." },
      {
        id: "workspace-layout",
        label: "Workspace layout",
        description: "Reset saved panel positions and dock sizes.",
        keywords: ["reset", "panels", "saved layout"],
      },
      {
        id: "item-colors",
        label: "Folder and note colors",
        description: "Color-code folders and notes in the file tree.",
        keywords: ["sidebar", "swatches"],
      },
    ],
  },
  {
    id: "editor",
    group: "options",
    label: "Editor",
    icon: "edit",
    settings: [
      {
        id: "content-width",
        label: "Content width",
        description: "Choose how wide note text runs before it wraps.",
        keywords: ["line length", "measure", "full width"],
      },
      { id: "line-numbers", label: "Line numbers", description: "Show a line-number gutter in the editor." },
      {
        id: "default-view-mode",
        label: "Default view mode",
        description: "Choose Live Preview, Raw, or Reading for newly opened notes.",
        keywords: ["markdown", "reading", "source", "live preview"],
      },
      {
        id: "properties-display",
        label: "Properties in document",
        description: "Choose how YAML frontmatter appears above a note.",
        keywords: ["frontmatter", "yaml", "metadata", "properties display"],
      },
    ],
  },
  {
    id: "vaults",
    group: "vault",
    label: "Vaults",
    icon: "vault",
    settings: [
      { id: "vault-list", label: "Vaults", description: "Switch, create, and manage local and synced vaults." },
    ],
  },
  {
    id: "import-export",
    group: "vault",
    label: "Import / Export",
    icon: "transfer",
    settings: [
      { id: "import-files", label: "Import files", description: "Import Markdown and supported files into this vault." },
      { id: "export-vault", label: "Export vault", description: "Copy the entire vault to another folder." },
    ],
  },
  {
    id: "mcp",
    group: "vault",
    label: "MCP",
    icon: "terminal",
    settings: [
      {
        id: "mcp-endpoint",
        label: "Endpoint URL",
        description: "MCP endpoint URL for this vault.",
        keywords: ["url"],
      },
      {
        id: "mcp-tokens",
        label: "Access tokens",
        description: "Create and revoke access tokens for MCP clients.",
        keywords: ["token", "api key"],
      },
    ],
  },
  {
    id: "versioning",
    group: "vault",
    label: "Versioning",
    icon: "history",
    settings: [
      { id: "checkpoints", label: "Vault checkpoints", description: "Create, inspect, and restore saved vault versions." },
    ],
  },
  {
    id: "profile",
    group: "account",
    label: "Profile",
    icon: "user",
    settings: [
      { id: "display-name", label: "Display name", description: "Change the name teammates see." },
      {
        id: "avatar",
        label: "Avatar image",
        description: "Choose the image used for your account.",
        keywords: ["url", "photo"],
      },
      { id: "email", label: "Email", description: "Inspect your account email and verification state." },
    ],
  },
  {
    id: "status",
    group: "account",
    label: "Activity status",
    icon: "status",
    settings: [
      { id: "activity-status", label: "Activity status", description: "Choose how your availability appears to teammates." },
    ],
  },
  {
    id: "notifications",
    group: "account",
    label: "Notifications",
    icon: "bell",
    settings: [
      { id: "mention-chime", label: "Mention chime", description: "Play a sound when a teammate mentions you." },
    ],
  },
  {
    id: "connection",
    group: "account",
    label: "Connection",
    icon: "server",
    settings: [
      { id: "server-url", label: "Server URL", description: "Choose the managed service or a self-hosted Noam server." },
    ],
  },
  {
    id: "members",
    group: "team",
    label: "Members",
    icon: "members",
    settings: [
      { id: "team-members", label: "Team members", description: "Invite people and manage vault membership." },
      {
        id: "join-code",
        label: "Join code",
        description: "Shareable code teammates use to join this vault.",
        keywords: ["invite code", "share"],
      },
    ],
  },
  {
    id: "access",
    group: "team",
    label: "Access",
    icon: "lock",
    settings: [
      { id: "vault-access", label: "Vault access", description: "Control which members can access folders and notes." },
    ],
  },
  {
    id: "billing",
    group: "team",
    label: "Billing",
    icon: "card",
    settings: [
      { id: "billing-plan", label: "Billing and subscriptions", description: "Manage plans, seats, and vault subscriptions." },
    ],
  },
  {
    id: "updates",
    group: "application",
    label: "Updates",
    icon: "refresh",
    settings: [
      { id: "check-updates", label: "Check for updates", description: "Check for and install a newer Noam release." },
    ],
  },
  {
    id: "about",
    group: "application",
    label: "About",
    icon: "info",
    settings: [
      { id: "app-version", label: "Current version", description: "See the version of Noam running on this device." },
      { id: "sign-out", label: "Sign out", description: "Sign out of this Noam account." },
    ],
  },
];

export interface SettingsAvailability {
  hasSession: boolean;
  hasVault: boolean;
  hasKnownVaults: boolean;
  billingEnabled: boolean;
}

/** Visibility only; locked synced-vault sections remain discoverable in navigation. */
export function availableSettingsSections(
  availability: SettingsAvailability,
): readonly SettingsSectionDefinition[] {
  return SETTINGS_SECTIONS.filter((section) => {
    if (section.group === "account") return availability.hasSession;
    if (section.id === "billing") return availability.billingEnabled;
    if (section.id === "vaults") return availability.hasSession || availability.hasKnownVaults;
    if (section.id === "general") return availability.hasVault;
    return true;
  });
}

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return (
    typeof value === "string" &&
    (SETTINGS_SECTION_IDS as readonly string[]).includes(value)
  );
}

const SECTION_ALIASES: Readonly<Record<string, SettingsSectionId>> = {
  account: "profile",
  activity: "status",
  "activity-status": "status",
  import: "import-export",
  export: "import-export",
  preferences: "general",
  theme: "appearance",
  vault: "general",
};

export function requestedSettingsSection(value: unknown): SettingsSectionId | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (isSettingsSectionId(normalized)) return normalized;
  return SECTION_ALIASES[normalized] ?? null;
}

export function resolveSettingsSection(
  requested: unknown,
  visibleSections: readonly Pick<SettingsSectionDefinition, "id">[] = SETTINGS_SECTIONS,
): SettingsSectionId {
  const candidate = requestedSettingsSection(requested);
  if (candidate && visibleSections.some((section) => section.id === candidate)) {
    return candidate;
  }
  return visibleSections.find((section) => section.id === "general")?.id ??
    visibleSections[0]?.id ??
    "appearance";
}

export interface SettingsSearchResult {
  sectionId: SettingsSectionId;
  sectionLabel: string;
  settingId: string | null;
  label: string;
  description: string;
  score: number;
}

function normalizedWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function fieldScore(field: string, query: string, tokens: readonly string[], weight: number): number {
  const normalized = normalizedWords(field).join(" ");
  if (!normalized) return 0;
  let score = 0;
  if (normalized === query) score += 140 * weight;
  else if (normalized.startsWith(query)) score += 90 * weight;
  else if (normalized.includes(query)) score += 55 * weight;
  for (const token of tokens) {
    if (normalized === token) score += 35 * weight;
    else if (normalized.split(" ").some((word) => word.startsWith(token))) score += 18 * weight;
    else if (normalized.includes(token)) score += 8 * weight;
  }
  return score;
}

export function searchSettings(
  rawQuery: string,
  sections: readonly SettingsSectionDefinition[] = SETTINGS_SECTIONS,
): SettingsSearchResult[] {
  const tokens = normalizedWords(rawQuery);
  if (tokens.length === 0) return [];
  const query = tokens.join(" ");
  const results: SettingsSearchResult[] = [];

  for (const section of sections) {
    const sectionWords = normalizedWords(section.label);
    const sectionScore = tokens.every((token) =>
      sectionWords.some((word) => word.includes(token)),
    )
      ? fieldScore(section.label, query, tokens, 3)
      : 0;
    if (sectionScore > 0) {
      results.push({
        sectionId: section.id,
        sectionLabel: section.label,
        settingId: null,
        label: section.label,
        description: `${section.label} settings`,
        score: sectionScore,
      });
    }
    for (const setting of section.settings) {
      const searchable = normalizedWords(
        [section.label, setting.label, setting.description, ...(setting.keywords ?? [])]
          .filter(Boolean)
          .join(" "),
      );
      if (!tokens.every((token) => searchable.some((word) => word.includes(token)))) {
        continue;
      }
      const labelScore = fieldScore(setting.label, query, tokens, 5);
      const descriptionScore = fieldScore(setting.description ?? "", query, tokens, 2);
      const keywordScore = (setting.keywords ?? []).reduce(
        (score, keyword) => score + fieldScore(keyword, query, tokens, 3),
        0,
      );
      const score = labelScore + descriptionScore + keywordScore;
      if (score === 0) continue;
      results.push({
        sectionId: section.id,
        sectionLabel: section.label,
        settingId: setting.id,
        label: setting.label,
        description: setting.description ?? "",
        score,
      });
    }
  }

  return results.sort(
    (a, b) =>
      b.score - a.score ||
      a.sectionLabel.localeCompare(b.sectionLabel) ||
      a.label.localeCompare(b.label),
  );
}
