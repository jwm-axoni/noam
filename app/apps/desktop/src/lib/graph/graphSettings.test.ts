import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings } from "./graphSettings";

function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
}

afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

describe("graph settings migration", () => {
  it("uses type colors and visible orphans for new graph instances", () => {
    storage({});
    expect(loadSettings("panel:new")).toMatchObject({ colorMode: "type", minDegree: 0, hideOrphans: false });
  });

  it("preserves explicit legacy filters while filling missing new defaults", () => {
    storage({
      "context.graph.settings.v5": JSON.stringify({ minDegree: 4, hideOrphans: true, colorMode: "folder" }),
    });
    expect(loadSettings("panel:graph")).toMatchObject({ minDegree: 4, hideOrphans: true, colorMode: "folder" });
  });

  it("does not copy singleton legacy filters into a new second graph", () => {
    storage({
      "context.graph.settings.v5": JSON.stringify({ minDegree: 4, hideOrphans: true, colorMode: "folder" }),
    });
    expect(loadSettings("panel:graph:second")).toMatchObject({
      colorMode: "type",
      minDegree: 0,
      hideOrphans: false,
    });
  });

  it("keeps an instance-specific value ahead of legacy settings", () => {
    storage({
      "context.graph.settings.v5": JSON.stringify({ minDegree: 9 }),
      [`${SETTINGS_STORAGE_KEY}:panel:graph`]: JSON.stringify({ minDegree: 2 }),
    });
    expect(loadSettings("panel:graph").minDegree).toBe(2);
    expect(DEFAULT_SETTINGS.colorMode).toBe("type");
  });
});
