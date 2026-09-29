// The `gallery` panel type through the layout machinery: a center-only
// singleton whose one persisted field is the folder it shows, and which
// follows in-app folder renames.

import { beforeEach, describe, expect, it } from "vitest";
import { panelRegistry } from "./panelRegistry";
import { applyLayoutOperation } from "./operations";
import { serializableLayout, validatePersistedLayout } from "./persistence";
import { useLayoutStore } from "./store";
import { CENTER_NOTE_GROUP_ID, createDefaultLayout, PANEL_ALLOWED_ZONES, PANEL_MULTIPLICITY, type LayoutV1 } from "./types";
import {
  galleryFolder,
  galleryPanelId,
  galleryTabLabel,
  remapGalleryFolders,
  withGalleryFolder,
} from "../lib/gallery/panelState";
import { followGalleryRename, openGallery } from "../lib/gallery/open";

function openCenter(layout: LayoutV1, instanceId?: string): LayoutV1 {
  return applyLayoutOperation(layout, {
    type: "open-panel",
    panelType: "gallery",
    zone: "center",
    groupId: CENTER_NOTE_GROUP_ID,
    instanceId,
  });
}

describe("gallery panel registration", () => {
  it("lives in the center only, one at a time", () => {
    expect(PANEL_ALLOWED_ZONES.gallery).toEqual(["center"]);
    expect(panelRegistry.gallery.allowedZones).toEqual(["center"]);
    expect(panelRegistry.gallery.defaultZone).toBe("center");
    expect(PANEL_MULTIPLICITY.gallery).toBe(1);
    expect(panelRegistry.gallery.multiplicity).toBe(1);
  });

  it("persists only the folder", () => {
    const persist: (state: Record<string, unknown>) => Record<string, unknown> =
      panelRegistry.gallery.persistentState;
    expect(persist({ folder: "Trips/Italy", scroll: 120, __temporaryReturnZone: "left" })).toEqual({
      folder: "Trips/Italy",
    });
    expect(persist({})).toEqual({ folder: "" });
    expect(persist({ folder: 42 })).toEqual({ folder: "" });
  });

  it("reads the folder defensively and labels the tab with it", () => {
    expect(galleryFolder(undefined)).toBe("");
    expect(galleryFolder({ folder: "/A/B/" })).toBe("A/B");
    expect(galleryTabLabel({ folder: "A/B" })).toBe("B");
    expect(galleryTabLabel({})).toBe("Gallery");
  });
});

describe("gallery panels in the layout", () => {
  it("opens as a center tab and refuses the docks", () => {
    const layout = openCenter(createDefaultLayout());
    const id = galleryPanelId(layout)!;
    expect(layout.groups[CENTER_NOTE_GROUP_ID]!.tabs.some((t) => t.kind === "panel" && t.panelId === id)).toBe(true);
    const right = applyLayoutOperation(createDefaultLayout(), { type: "open-panel", panelType: "gallery", zone: "right" });
    expect(galleryPanelId(right)).toBeNull();
  });

  it("never makes a second instance", () => {
    let layout = openCenter(createDefaultLayout());
    layout = openCenter(layout, "panel:gallery:other");
    expect(Object.values(layout.panels).filter((p) => p.type === "gallery")).toHaveLength(1);
  });

  it("restores its folder from a saved layout", () => {
    let layout = openCenter(createDefaultLayout());
    layout = withGalleryFolder(layout, galleryPanelId(layout)!, "Trips");
    const restored = validatePersistedLayout(JSON.parse(JSON.stringify(serializableLayout(layout))));
    const panel = Object.values(restored!.panels).find((p) => p.type === "gallery");
    expect(panel?.state).toEqual({ folder: "Trips" });
  });

  it("follows an in-app rename of its folder or an ancestor, and nothing else", () => {
    let layout = openCenter(createDefaultLayout());
    const id = galleryPanelId(layout)!;
    layout = withGalleryFolder(layout, id, "Work/Q3");
    expect(galleryFolder(remapGalleryFolders(layout, "Work", "Job").panels[id]!.state)).toBe("Job/Q3");
    expect(galleryFolder(remapGalleryFolders(layout, "Work/Q3", "Work/Q4").panels[id]!.state)).toBe("Work/Q4");
    expect(remapGalleryFolders(layout, "Workshop", "Shop")).toBe(layout);
    expect(remapGalleryFolders(layout, "Wor", "X")).toBe(layout);
  });
});

describe("opening from the sidebar", () => {
  beforeEach(() => useLayoutStore.getState().replace(createDefaultLayout()));

  it("opens the gallery on a folder, then retargets the same tab", () => {
    expect(openGallery("Trips")).toBe(true);
    const first = useLayoutStore.getState().layout;
    const id = galleryPanelId(first)!;
    expect(galleryFolder(first.panels[id]!.state)).toBe("Trips");

    expect(openGallery("Recipes")).toBe(true);
    const second = useLayoutStore.getState().layout;
    expect(galleryPanelId(second)).toBe(id);
    expect(galleryFolder(second.panels[id]!.state)).toBe("Recipes");
    const group = second.groups[CENTER_NOTE_GROUP_ID]!;
    expect(group.tabs.find((t) => t.id === group.activeTabId)).toMatchObject({ kind: "panel", panelId: id });
  });

  it("follows the store's rename funnel", () => {
    openGallery("Trips/Italy");
    followGalleryRename("Trips", "Travel");
    const layout = useLayoutStore.getState().layout;
    expect(galleryFolder(layout.panels[galleryPanelId(layout)!]!.state)).toBe("Travel/Italy");
  });
});
