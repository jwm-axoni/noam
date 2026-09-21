// The `workflows` panel type, end to end through the layout machinery: the
// registry knows it, the rail can open it, it persists, and — the part that
// actually bites — a layout written by a build that had a panel type THIS one
// does not know must not take the whole workspace down with it.

import { describe, expect, it } from "vitest";
import { panelRegistry } from "./panelRegistry";
import { applyLayoutOperation, findPanelTab } from "./operations";
import {
  createDefaultLayout,
  isPanelType,
  PANEL_ALLOWED_ZONES,
  PANEL_MULTIPLICITY,
  PANEL_TYPES,
  CENTER_NOTE_GROUP_ID,
} from "./types";
import { serializableLayout, validatePersistedLayout } from "./persistence";

describe("workflows panel registration", () => {
  it("is a known panel type with a left/right dock home", () => {
    expect(PANEL_TYPES).toContain("workflows");
    expect(isPanelType("workflows")).toBe(true);
    expect(PANEL_ALLOWED_ZONES.workflows).toEqual(["left", "right"]);
    expect(PANEL_MULTIPLICITY.workflows).toBe(1);
  });

  it("has a registration the shell can render", () => {
    const registration = panelRegistry.workflows;
    expect(registration.label).toBe("Workflows");
    expect(registration.icon).toBeTruthy();
    expect(registration.defaultZone).toBe("left");
    expect(registration.multiplicity).toBe(1);
    expect(typeof registration.load).toBe("function");
  });

  it("opens into the left dock and survives a persistence round trip", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "workflows",
      zone: "left",
    });
    expect(findPanelTab(opened, "workflows")).not.toBeNull();

    const restored = validatePersistedLayout(
      JSON.parse(JSON.stringify(serializableLayout(opened))),
    );
    expect(restored).not.toBeNull();
    expect(findPanelTab(restored!, "workflows")).not.toBeNull();
  });

  it("drops an unknown panel type from a newer build instead of throwing", () => {
    const opened = applyLayoutOperation(createDefaultLayout(), {
      type: "open-panel",
      panelType: "workflows",
      zone: "left",
    });
    const raw = JSON.parse(JSON.stringify(serializableLayout(opened)));
    raw.panels["panel:from-the-future"] = {
      id: "panel:from-the-future",
      type: "timeline",
      stateVersion: 1,
      state: {},
    };
    const group = Object.values(raw.groups as Record<string, { tabs: unknown[] }>).find(
      (candidate) => candidate !== raw.groups[CENTER_NOTE_GROUP_ID],
    );
    group?.tabs.push({ id: "tab:future", kind: "panel", panelId: "panel:from-the-future" });

    const restored = validatePersistedLayout(raw);
    expect(restored).not.toBeNull();
    expect(restored!.panels["panel:from-the-future"]).toBeUndefined();
    expect(findPanelTab(restored!, "workflows")).not.toBeNull();
  });
});
