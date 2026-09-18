import { defineConfig } from "vitest/config";

// The bridge is pure TS with injected I/O, so tests run in a plain Node
// environment with no Tauri/DOM. Keep vitest scoped to the bridge suites.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
