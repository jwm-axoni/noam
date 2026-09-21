// The `tasks` and `calendar` panel types through the layout machinery: the
// registry knows both, each opens into a dock zone, and a layout holding them
// survives the persistence round trip — including the case that matters for a
// downgrade, where a layout written by THIS build is read by one that still
// validates every other panel it knows.

import { describe, expect, it } from "vitest";
import { panelRegistry } from "./panelRegistry";
import { applyLayoutOperation, findPanelTab } from "./operations";
import {
  createDefaultLayout,
  isPanelType,
  PANEL_ALLOWED_ZONES,
  PANEL_MULTIPLICITY,
  PANEL_TYPES,
} from "./types";
import { serializableLayout, validatePersistedLayout } from "./persistence";

const DOCK_ONLY: Array<"tasks" | "calendar"> = ["tasks", "calendar"];

describe("tasks and calendar panel registration", () => {
  it.each(DOCK_ONLY)("%s is a known panel type docked left or right", (type) => {
    expect(PANEL_TYPES).toContain(type);
    expect(isPanelType(type)).toBe(true);
    expect(PANEL_ALLOWED_ZONES[type]).toEqual(["left", "right"]);
    expect(PANEL_MULTIPLICITY[type]).toBe(1);
  });

  it("has registrations the shell can render", () => {
    expect(panelRegistry.tasks.label).toBe("Tasks");
    expect(panelRegistry.calendar.label).toBe("Calendar");
    for (const type of DOCK_ONLY) {
      const registration = panelRegistry[type];
      expect(registration.icon).toBeTruthy();
      expect(registration.defaultZone).toBe("left");
      expect(registration.multiplicity).toBe(1);
      expect(typeof registration.load).toBe("function");
      // 220 px compact is the release gate; the minimum must not exceed it.
      expect(registration.minimumWidth).toBeLessThanOrEqual(220);
    }
  });

  it("opens both into the left dock and survives a persistence round trip", () => {
    let layout = createDefaultLayout();
    for (const type of DOCK_ONLY) {
      layout = applyLayoutOperation(layout, { type: "open-panel", panelType: type, zone: "left" });
    }
    expect(findPanelTab(layout, "tasks")).not.toBeNull();
    expect(findPanelTab(layout, "calendar")).not.toBeNull();

    const restored = validatePersistedLayout(
      JSON.parse(JSON.stringify(serializableLayout(layout))),
    );
    expect(restored).not.toBeNull();
    expect(findPanelTab(restored!, "tasks")).not.toBeNull();
    expect(findPanelTab(restored!, "calendar")).not.toBeNull();
  });

  it("keeps a layout valid when one of them sits in the right dock", () => {
    const layout = applyLayoutOperation(
      applyLayoutOperation(createDefaultLayout(), {
        type: "open-panel",
        panelType: "tasks",
        zone: "left",
      }),
      { type: "open-panel", panelType: "calendar", zone: "right" },
    );
    const restored = validatePersistedLayout(
      JSON.parse(JSON.stringify(serializableLayout(layout))),
    );
    expect(restored).not.toBeNull();
    const found = findPanelTab(restored!, "calendar");
    expect(found).not.toBeNull();
    expect(restored!.zones.right.groupIds).toContain(found!.groupId);
  });
});
