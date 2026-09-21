import { spawn } from "node:child_process";
import { request } from "node:http";

const port = 1431;
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["ignore", "pipe", "pipe"],
});

function waitForServer(attempts = 50) {
  return new Promise((resolve, reject) => {
    const poll = (remaining) => {
      const call = request(`http://127.0.0.1:${port}/src/components/filePreview/pdfInlineLayout.fixture.html`, { method: "HEAD" }, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) resolve();
        else retry(remaining);
      });
      call.on("error", () => retry(remaining));
      call.end();
    };
    const retry = (remaining) => {
      if (remaining <= 0) reject(new Error("Vite fixture server did not start"));
      else setTimeout(() => poll(remaining - 1), 100);
    };
    poll(attempts);
  });
}

try {
  await waitForServer();
  const browser = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--dump-dom",
    "--virtual-time-budget=1500",
    `http://127.0.0.1:${port}/src/components/filePreview/pdfInlineLayout.fixture.html`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let html = "";
  let errors = "";
  browser.stdout.on("data", (chunk) => { html += chunk; });
  browser.stderr.on("data", (chunk) => { errors += chunk; });
  const code = await new Promise((resolve) => browser.on("close", resolve));
  if (code !== 0) throw new Error(errors || `Chrome exited ${code}`);
  const encoded = /data-result="([^"]+)"/.exec(html)?.[1];
  if (!encoded) throw new Error("Fixture did not report a result");
  const result = JSON.parse(encoded.replaceAll("&quot;", '"'));
  console.log(JSON.stringify(result));
  if (!result.contained) process.exitCode = 1;
} finally {
  vite.kill("SIGTERM");
}
