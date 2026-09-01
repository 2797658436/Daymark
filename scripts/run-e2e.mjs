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
    const runner = spawn(process.execPath, [playwrightEntry, "test"], {
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
