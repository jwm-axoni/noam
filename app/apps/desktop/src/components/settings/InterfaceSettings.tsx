// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { ITEM_COLORS, itemColorValue } from "../../lib/appearance";
import * as ipc from "../../lib/ipc";
import { useLayoutStore } from "../../layout/store";
import {
  CENTER_NOTE_GROUP_ID,
  createDefaultLayout,
  type NoteTab,
} from "../../layout/types";
import { useStore } from "../../store";
import { Switch } from "../Switch";
import { SettingRow } from "./SettingRow";

const ITEM_ICON = {
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
};

function resetWorkspaceLayout() {
  const current = useLayoutStore.getState().layout;
  const currentNoteGroup = current.groups[CENTER_NOTE_GROUP_ID];
  const noteTabs = (currentNoteGroup?.tabs.filter(
    (tab): tab is NoteTab => tab.kind === "note",
  ) ?? []);
  const openNotePath = useStore.getState().openNote?.path;
  const activeNote =
    noteTabs.find((tab) => tab.id === currentNoteGroup?.activeTabId) ??
    noteTabs.find((tab) => tab.path === openNotePath) ??
    noteTabs[0];
  const next = createDefaultLayout();
  const noteGroup = next.groups[CENTER_NOTE_GROUP_ID]!;
  noteGroup.tabs = noteTabs;
  noteGroup.activeTabId = activeNote?.id ?? null;
  useLayoutStore.getState().replace(next);
}

export function InterfaceSettings() {
  const layout = useLayoutStore((state) => state.layout);
  const itemColors = useStore((state) => state.itemColors);
  const tree = useStore((state) => state.tree);
  const items = useMemo(() => {
    const result: Array<{ path: string; name: string; depth: number; isDir: boolean }> = [];
    const walk = (node: ipc.TreeNode, depth: number) => {
      result.push({
        path: node.path,
        name: node.isDir ? node.name : node.name.replace(/\.(md|html?)$/i, ""),
        depth,
        isDir: node.isDir,
      });
      node.children?.forEach((child) => walk(child, depth + 1));
    };
    tree?.children?.forEach((child) => walk(child, 0));
    return result;
  }, [tree]);
  const coloredCount = items.filter((item) => itemColors[item.path]).length;
  const leftAvailable = layout.zones.left.groupIds.length > 0;
  const rightAvailable = layout.zones.right.groupIds.length > 0;

  return (
    <>
      <SettingRow
        id="left-dock"
        label="Left dock"
        description="Show the dock that contains Files and Search."
      >
        <Switch
          checked={leftAvailable && !layout.zones.left.userCollapsed}
          disabled={!leftAvailable}
          ariaLabel="Show left dock"
          onChange={(collapsed) =>
            useLayoutStore.getState().dispatch({
              type: "set-zone-collapsed",
              zone: "left",
              collapsed: !collapsed,
            })
          }
        />
      </SettingRow>
      <SettingRow
        id="right-dock"
        label="Right dock"
        description={
          rightAvailable
            ? "Show the dock that contains right-side tools."
            : "Open a right-side tool before changing this dock's visibility."
        }
      >
        <Switch
          checked={rightAvailable && !layout.zones.right.userCollapsed}
          disabled={!rightAvailable}
          ariaLabel="Show right dock"
          onChange={(visible) =>
            useLayoutStore.getState().dispatch({
              type: "set-zone-collapsed",
              zone: "right",
              collapsed: !visible,
            })
          }
        />
      </SettingRow>
      <SettingRow
        id="workspace-layout"
        label="Workspace layout"
        description="Panel positions and dock sizes are saved for this vault. Resetting keeps open note tabs."
      >
        <button type="button" className="secondary sm" onClick={resetWorkspaceLayout}>
          Reset layout
        </button>
      </SettingRow>

      <div className="settings-subsection" data-setting-id="item-colors" tabIndex={-1}>
        <h3>Folder &amp; note colors</h3>
        <p>
          Color-code the file tree. Colors are saved with this device's vault settings.
        </p>
        {items.length === 0 ? (
          <div className="muted perm-empty">Open a vault to color its folders and notes.</div>
        ) : (
          <>
            <ul className="appearance-list">
              {items.map((item) => {
                const active = itemColors[item.path];
                return (
                  <li
                    key={item.path}
                    className="appearance-row"
                    style={{ paddingLeft: `${12 + item.depth * 16}px` }}
                  >
                    <span
                      className="appearance-glyph"
                      style={{ color: itemColorValue(active) }}
                      aria-hidden="true"
                    >
                      {item.isDir ? ITEM_ICON.folder : ITEM_ICON.note}
                    </span>
                    <span className="appearance-name" title={item.path}>
                      {item.name}
                    </span>
                    <span
                      className="appearance-swatches"
                      role="radiogroup"
                      aria-label={`Color for ${item.name}`}
                    >
                      <button
                        type="button"
                        className={`swatch clear${!active ? " on" : ""}`}
                        title="Default"
                        aria-label="Default color"
                        onClick={() => useStore.getState().setItemColor(item.path, null)}
                      />
                      {ITEM_COLORS.map((color) => (
                        <button
                          key={color.id}
                          type="button"
                          className={`swatch${active === color.id ? " on" : ""}`}
                          style={{ backgroundColor: color.value }}
                          title={color.label}
                          aria-label={color.label}
                          onClick={() => useStore.getState().setItemColor(item.path, color.id)}
                        />
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
            {coloredCount > 0 && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  const { itemColors: colors, setItemColor } = useStore.getState();
                  Object.keys(colors).forEach((path) => setItemColor(path, null));
                }}
              >
                Clear all colors ({coloredCount})
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
