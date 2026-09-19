import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const playwrightEntry = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const server = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1"], {
  cwd: projectDirectory,
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:1420");
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await delay(250);
  }
  throw new Error("Vite did not start within 15 seconds");
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    // 透传 CLI 参数（例如 `node scripts/run-e2e.mjs --workers=1`）：
    // 并发 worker 下两个 spec 冷编译会互相争抢，M3/M4 更容易出现滚动竞态假红。
    const runner = spawn(process.execPath, [playwrightEntry, "test", ...process.argv.slice(2)], {
      cwd: projectDirectory,
      stdio: "inherit",
    });
    runner.once("error", reject);
    runner.once("exit", (code) => resolve(code ?? 1));
  });
}

let exitCode = 1;
try {
  await waitForServer();
  exitCode = await runPlaywright();
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(3_000),
  ]);
}

process.exitCode = exitCode;
