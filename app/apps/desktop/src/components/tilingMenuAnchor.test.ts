// @vitest-environment jsdom
//
// The TilingMenu wrapper (`.tiling-menu-wrap`, rendered by TabBar's
// `TilingMenu`) must stay pinned to the right edge of the center workspace
// header: `margin-left: auto` claims whatever space the tab strip left
// behind instead of relying on the strip's own flex-grow, and
// `flex: 0 0 auto` keeps it from being squeezed when the strip overflows
// and shrinks. jsdom does no real layout (no line-wrapping/overflow math),
// so this only checks the declared rule — a real "does it float mid-header"
// regression is a manual check (see below).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const style = document.createElement("style");

describe("tiling menu anchoring", () => {
  beforeAll(() => {
    style.textContent = readFileSync(join(here, "..", "styles", "workspace.css"), "utf8");
    document.head.append(style);
  });

  afterAll(() => {
    style.remove();
  });

  it("pins .tiling-menu-wrap to the end of the tab row regardless of tab-strip width", () => {
    const wrap = document.createElement("div");
    wrap.className = "tiling-menu-wrap";
    document.body.append(wrap);
    const computed = getComputedStyle(wrap);
    expect(computed.marginLeft).toBe("auto");
    expect(computed.flexGrow).toBe("0");
    expect(computed.flexShrink).toBe("0");
    wrap.remove();
  });
});

/**
 * Manual check for the integrator (geometry jsdom cannot verify):
 * 1. Open a note so the center TabBar is visible.
 * 2. With a single tab open (short tab strip), confirm the workspace-layout
 *    (tiling) button sits at the header's right side, not floating right
 *    after the lone tab.
 * 3. Open enough notes for the tab strip to overflow/scroll, and confirm the
 *    tiling button does not shift left or shrink.
 * 4. Toggle the right dock open/closed and resize it; the tiling button
 *    should track the center header's right edge the whole time.
 */
