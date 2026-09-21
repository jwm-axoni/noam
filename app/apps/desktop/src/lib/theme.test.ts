// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getThemeAccent,
  getThemeMode,
  getThemePreset,
  initTheme,
  observeThemeChanges,
  setThemeAccent,
  setThemeMode,
  setThemePreset,
} from "./theme";

describe("theme preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preset");
    document.documentElement.removeAttribute("data-theme-accent");
    document.documentElement.removeAttribute("data-accent");
    vi.restoreAllMocks();
  });

  it.each([
    ["ink", "paper-ink"],
    ["violet", "noam"],
    ["sea", "sea"],
    ["terracotta", "terracotta"],
    ["moss", "moss"],
  ] as const)("keeps the legacy %s world as the %s palette", (legacy, preset) => {
    localStorage.setItem("context.accentTheme", legacy);
    document.documentElement.dataset.accent = legacy;
    initTheme();

    expect(getThemePreset()).toBe(preset);
    expect(document.documentElement.dataset.themePreset).toBe(preset);
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(localStorage.getItem("noam-theme-preset")).toBeNull();
  });

  it("uses Paper & Ink when no old or new palette preference exists", () => {
    initTheme();
    expect(getThemePreset()).toBe("paper-ink");
    expect(document.documentElement.dataset.themePreset).toBe("paper-ink");
  });

  it("stores palette and display mode independently", () => {
    setThemeMode("dark");
    setThemePreset("paper-ink");
    expect(getThemeMode()).toBe("dark");
    expect(getThemePreset()).toBe("paper-ink");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreset).toBe("paper-ink");

    setThemeMode("light");
    expect(getThemePreset()).toBe("paper-ink");
    expect(document.documentElement.dataset.themePreset).toBe("paper-ink");
  });

  it("keeps an accent override independent from palette and mode", () => {
    setThemeMode("dark");
    setThemePreset("paper-ink");
    setThemeAccent("blue");

    setThemePreset("black");
    setThemeMode("light");
    expect(getThemeAccent()).toBe("blue");
    expect(getThemePreset()).toBe("black");
    expect(getThemeMode()).toBe("light");
    expect(document.documentElement.dataset.themeAccent).toBe("blue");

    setThemeAccent(null);
    expect(getThemeAccent()).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme-accent")).toBe(false);
  });

  it("notifies mounted consumers when mode, palette, or accent changes", async () => {
    const onChange = vi.fn();
    const stop = observeThemeChanges(onChange);
    const changes = [
      () => setThemeMode("dark"),
      () => setThemePreset("sea"),
      () => setThemeAccent("blue"),
    ];

    for (const change of changes) {
      onChange.mockClear();
      change();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(onChange).toHaveBeenCalledOnce();
    }

    stop();
    onChange.mockClear();
    setThemeAccent("green");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores an unknown stored palette", () => {
    localStorage.setItem("noam-theme-preset", "downloaded-script-theme");
    initTheme();
    expect(getThemePreset()).toBe("paper-ink");
    expect(document.documentElement.dataset.themePreset).toBe("paper-ink");
  });

});
