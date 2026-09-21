import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve("pdfjs-dist/package.json"));

/** PDF.js requests these by name at runtime, so Vite must copy the directories. */
function pdfRuntimeAssets() {
  const directories = ["cmaps", "iccs", "standard_fonts", "wasm"];
  return {
    name: "pdf-runtime-assets",
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/pdfjs\/(cmaps|iccs|standard_fonts|wasm)\/([^/?]+)$/.exec(req.url ?? "");
        if (!match) return next();
        try {
          if (match[1] === "wasm" && match[2].endsWith(".wasm")) {
            res.setHeader("Content-Type", "application/wasm");
          }
          res.end(readFileSync(join(pdfRoot, match[1], match[2])));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
    buildStart(this: { emitFile: (file: { type: "asset"; fileName: string; source: Buffer }) => void }) {
      for (const directory of directories) {
        for (const name of readdirSync(join(pdfRoot, directory))) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${directory}/${name}`,
            source: readFileSync(join(pdfRoot, directory, name)),
          });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), pdfRuntimeAssets()],

  build: {
    /**
     * `minimumSystemVersion: "10.15"` (src-tauri/tauri.conf.json) means the
     * oldest WKWebView we support is Safari 13. Vite's default target is
     * baseline-widely-available (~Safari 16.4), which emits syntax that throws
     * on Catalina — a correctness bug, not a size one. Keep 10.15 and target
     * the webview that ships with it.
     */
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    /**
     * One stylesheet, as before the code split. The Suspense fallbacks render
     * rules that belong to a lazy chunk's CSS (the editor skeleton, the graph
     * overlay, the avatar monogram), and splitting them would show the
     * fallbacks unstyled and repaint the pane when the chunk lands. The whole
     * sheet is ~135 KB and already shipped blocking, so this costs nothing new.
     */
    cssCodeSplit: false,
    /**
     * Never inline the AudioWorklet module.
     *
     * It's ~2 KB, so Vite's default `assetsInlineLimit` turns it into a `data:`
     * URL — and the Tauri CSP is `script-src 'self'`, which blocks a worklet
     * loaded from `data:`. Push-to-talk then fails only in a packaged build,
     * where `tauri dev` (which serves the file over http) looks fine. Keep it a
     * real same-origin asset.
     */
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith("recorder-worklet.js") ? false : undefined,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
