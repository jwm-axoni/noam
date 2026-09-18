// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  containSettingsBackground,
  containSettingsNestedFocus,
  containSettingsTab,
  settingsReturnFocusTarget,
  settingsSearchFocusTarget,
} from "./focusContainment";

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings focus containment", () => {
  it("lands search results on the matching control", () => {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.className = "settings-section-title";
    title.tabIndex = -1;
    const row = document.createElement("div");
    row.dataset.settingId = "content-width";
    row.tabIndex = -1;
    const slider = document.createElement("input");
    slider.type = "range";
    row.append(slider);
    section.append(title, row);

    expect(settingsSearchFocusTarget(section, "content-width")).toEqual({
      scrollTarget: row,
      focusTarget: slider,
    });
    expect(settingsSearchFocusTarget(section, "missing")).toEqual({
      scrollTarget: title,
      focusTarget: title,
    });
  });

  it("restores focus to the opener when a removed popover leaves body focused", () => {
    const opener = document.createElement("button");
    opener.dataset.settingsReturnFocus = "";
    document.body.append(opener);

    expect(settingsReturnFocusTarget(document.body)).toBe(opener);
    expect(settingsReturnFocusTarget(opener)).toBe(opener);
  });

  it("wraps Tab in both directions and pulls outside focus into the dialog", () => {
    const outside = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    const first = document.createElement("button");
    const last = document.createElement("input");
    dialog.append(first, last);
    document.body.append(outside, dialog);

    last.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    expect(containSettingsTab(forward, dialog)).toBe(true);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const backward = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });
    expect(containSettingsTab(backward, dialog)).toBe(true);
    expect(document.activeElement).toBe(last);

    outside.focus();
    const reenter = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    containSettingsTab(reenter, dialog);
    expect(document.activeElement).toBe(first);
  });

  it("keeps Tab inside the dialog from search-focused programmatic rows", () => {
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    const leadingRow = document.createElement("div");
    leadingRow.tabIndex = -1;
    const first = document.createElement("button");
    const middleRow = document.createElement("div");
    middleRow.tabIndex = -1;
    const last = document.createElement("input");
    const trailingRow = document.createElement("div");
    trailingRow.tabIndex = -1;
    dialog.append(leadingRow, first, middleRow, last, trailingRow);
    document.body.append(dialog);

    // A search landing on a row after the last tabbable control wraps
    // forward to the first control instead of escaping the dialog.
    trailingRow.focus();
    const fromEnd = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    expect(containSettingsTab(fromEnd, dialog)).toBe(true);
    expect(fromEnd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    // ...and wraps backward to the last control.
    const fromEndBack = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });
    expect(containSettingsTab(fromEndBack, dialog)).toBe(true);
    expect(document.activeElement).toBe(last);

    // A row between two tabbable controls moves to the nearest one in the
    // pressed direction.
    middleRow.focus();
    const midForward = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    containSettingsTab(midForward, dialog);
    expect(document.activeElement).toBe(last);

    middleRow.focus();
    const midBack = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });
    containSettingsTab(midBack, dialog);
    expect(document.activeElement).toBe(first);

    // A programmatic row before the first control wraps backward to the end.
    leadingRow.focus();
    const leadBack = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });
    expect(containSettingsTab(leadBack, dialog)).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("makes background surfaces inert and restores their prior state", () => {
    const app = document.createElement("main");
    const alreadyInert = document.createElement("aside");
    alreadyInert.setAttribute("inert", "");
    const portal = document.createElement("div");
    document.body.append(app, alreadyInert, portal);

    const restore = containSettingsBackground(portal);
    expect(app.hasAttribute("inert")).toBe(true);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
    expect(portal.hasAttribute("inert")).toBe(false);

    restore();
    expect(app.hasAttribute("inert")).toBe(false);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
  });

  it("temporarily releases a host that mounts a nested dialog", async () => {
    const app = document.createElement("main");
    const portal = document.createElement("div");
    document.body.append(app, portal);

    const restore = containSettingsBackground(portal);
    expect(app.hasAttribute("inert")).toBe(true);

    const nested = document.createElement("div");
    nested.className = "modal-backdrop";
    app.append(nested);
    await Promise.resolve();
    expect(app.hasAttribute("inert")).toBe(false);

    nested.remove();
    await Promise.resolve();
    expect(app.hasAttribute("inert")).toBe(true);

    restore();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("hands focus to a nested dialog and restores its settings trigger", async () => {
    const settings = document.createElement("div");
    settings.tabIndex = -1;
    const trigger = document.createElement("button");
    settings.append(trigger);
    document.body.append(settings);
    trigger.focus();

    const stop = containSettingsNestedFocus(settings);
    const nested = document.createElement("div");
    nested.className = "modal-backdrop";
    const close = document.createElement("button");
    nested.append(close);
    document.body.append(nested);
    await Promise.resolve();
    expect(document.activeElement).toBe(close);

    nested.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);
    stop();
  });
});
