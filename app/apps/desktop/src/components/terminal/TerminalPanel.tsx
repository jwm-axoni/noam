import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { PanelBodyProps } from "../../layout/panelRegistry";
import { useLayoutStore } from "../../layout/store";
import { copyText } from "../../lib/clipboard";
import {
  createTerminalChannel,
  terminalAttach,
  terminalDetach,
  terminalKill,
  terminalOpen,
  terminalResize,
  terminalStatus,
  terminalWrite,
  type TerminalMessage,
} from "../../lib/ipc";
import { platformClass } from "../../lib/platform";
import { appKeepsKey, TERMINAL_HOST_CLASS } from "../../lib/terminal/keys";
import { consumeSpawnRequest, reapOrphans, trackSession } from "../../lib/terminal/lifecycle";
import "./terminal.css";

type Phase =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number | null }
  | { kind: "ended" }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

// One subscription for the whole app: a terminal panel that leaves the layout
// (closed tab, vault switch, layout reset) takes its shell with it. Moving a
// tab keeps the panel id, so moves never reach this.
let reaperInstalled = false;
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  useLayoutStore.subscribe((state, previous) => {
    if (state.layout.panels === previous.layout.panels) return;
    for (const id of reapOrphans(state.layout.panels)) void terminalKill(id).catch(() => {});
  });
}

/** Clipboard read for Ctrl+Shift+V only — an explicit paste keystroke. Native
 *  first: WebKit refuses `navigator.clipboard.readText` outside a user
 *  activation it can see, which an await breaks. */
async function readClipboardForPaste(): Promise<string | null> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return await readText();
  } catch {
    return navigator.clipboard?.readText().catch(() => null) ?? null;
  }
}

/**
 * Is the host showing at a usable size? A hidden tab or a collapsed bottom dock
 * measures (near) zero, and fitting to that would shrink the shell to one row:
 * every TUI in it (Claude Code, vim) would redraw at that size, and again on
 * the way back. So a terminal that is not really on screen keeps its last size.
 */
function canFit(host: HTMLElement): boolean {
  return host.clientWidth >= 60 && host.clientHeight >= 40 &&
    getComputedStyle(host).visibility !== "hidden";
}

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function themeFromCss(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const background = cssVar(style, "--bg-surface", "#ffffff");
  const foreground = cssVar(style, "--text-primary", "#0f0f0f");
  return {
    background,
    foreground,
    cursor: cssVar(style, "--accent", foreground),
    cursorAccent: background,
    selectionBackground: cssVar(style, "--accent-soft", "#e8eef4"),
    selectionForeground: foreground,
  };
}

function isExit(message: TerminalMessage): message is { exit: number | null } {
  return typeof message === "object" && message !== null && !Array.isArray(message) &&
    !(message instanceof ArrayBuffer) && !(message instanceof Uint8Array) && "exit" in message;
}

function toBytes(message: Exclude<TerminalMessage, { exit: number | null }>): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return Uint8Array.from(message);
}

export function TerminalPanel({ instanceId, visible }: PanelBodyProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  // Bumped by Restart: a new generation always spawns and never re-attaches.
  const [generation, setGeneration] = useState(0);

  // The xterm view: one per mount, independent of the shell behind it.
  useEffect(() => {
    installReaper();
    const host = hostRef.current;
    if (!host) return;
    const isMac = platformClass() === "macos";
    const style = getComputedStyle(document.documentElement);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: cssVar(style, "--font-mono", "ui-monospace, monospace"),
      fontSize: 13,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return !appKeepsKey(e, isMac);
      // Ctrl+Shift+C / V on Windows and Linux, where plain Ctrl+C is SIGINT.
      if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "c") {
          const selection = term.getSelection();
          if (selection) void copyText(selection);
          return false;
        }
        if (key === "v") {
          void readClipboardForPaste().then((text) => {
            if (text) term.paste(text);
          });
          return false;
        }
      }
      // Keys the app keeps (Ctrl+`, Ctrl+Tab, ⌘-shortcuts) never reach the shell.
      return !appKeepsKey(e, isMac);
    });

    const input = term.onData((data) => {
      void terminalWrite(instanceId, data).catch(() => {});
    });
    const resized = term.onResize(({ cols, rows }) => {
      void terminalResize(instanceId, cols, rows).catch(() => {});
    });

    // Follow the app theme (light/dark, accent presets).
    const themeWatch = new MutationObserver(() => {
      term.options.theme = themeFromCss();
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-preset", "data-accent", "class", "style"],
    });

    // Fit whenever the panel's box changes — but only while it is really on
    // screen (see `canFit`), so hiding the bottom dock never resizes the shell.
    const observer = new ResizeObserver(() => {
      if (canFit(host) && fit.proposeDimensions()) fit.fit();
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      themeWatch.disconnect();
      input.dispose();
      resized.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [instanceId]);

  // The shell connection: attach to a live session, or spawn only when the user
  // asked for this terminal (a restored tab shows "Session ended" instead).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    const channel = createTerminalChannel((message) => {
      if (cancelled) return;
      if (isExit(message)) setPhase({ kind: "exited", code: message.exit });
      else term.write(toBytes(message));
    });

    void (async () => {
      const { enabled } = await terminalStatus();
      if (cancelled) return;
      if (!enabled) {
        setPhase({ kind: "disabled" });
        return;
      }
      if (generation === 0) {
        const attached = await terminalAttach(instanceId, channel);
        if (cancelled) return;
        if (attached) {
          trackSession(instanceId);
          setPhase({ kind: "running" });
          return;
        }
        if (!consumeSpawnRequest(instanceId)) {
          setPhase({ kind: "ended" });
          return;
        }
      }
      const host = hostRef.current;
      if (host && canFit(host) && fitRef.current?.proposeDimensions()) fitRef.current.fit();
      trackSession(instanceId);
      await terminalOpen(instanceId, term.cols, term.rows, channel);
      if (cancelled) {
        // Closed while the shell was starting: the reaper ran before there was
        // a process to kill, so kill it here.
        if (!useLayoutStore.getState().layout.panels[instanceId]) {
          void terminalKill(instanceId).catch(() => {});
        }
        return;
      }
      setPhase({ kind: "running" });
    })().catch((err: unknown) => {
      if (!cancelled) setPhase({ kind: "error", message: String(err) });
    });

    return () => {
      cancelled = true;
      void terminalDetach(instanceId, channel.id).catch(() => {});
    };
  }, [instanceId, generation]);

  // A tab that becomes visible again may have been resized while hidden.
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (fit && host && canFit(host) && fit.proposeDimensions()) fit.fit();
  }, [visible]);

  const restart = () => {
    termRef.current?.reset();
    setPhase({ kind: "starting" });
    setGeneration((g) => g + 1);
    window.requestAnimationFrame(() => termRef.current?.focus());
  };

  const overlay = (() => {
    switch (phase.kind) {
      case "ended":
        return { text: "Session ended. Terminals don't restart on their own.", action: "Restart" };
      case "exited":
        return {
          text: phase.code == null ? "Shell exited." : `Shell exited with code ${phase.code}.`,
          action: "Restart",
        };
      case "disabled":
        return { text: "The terminal is turned off by your organization's policy.", action: null };
      case "error":
        return { text: `Couldn't start the terminal: ${phase.message}`, action: "Try again" };
      default:
        return null;
    }
  })();

  return (
    <div className="terminal-panel" data-terminal-id={instanceId}>
      <div ref={hostRef} className={TERMINAL_HOST_CLASS} />
      {overlay && (
        <div className="terminal-overlay" role="status">
          <span>{overlay.text}</span>
          {overlay.action && (
            <button type="button" className="terminal-restart" onClick={restart}>
              {overlay.action}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
