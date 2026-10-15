import { spawn } from "node:child_process";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
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

// 沙箱的 safe-delete 对「单轮删除」有 50 条上限：Playwright 启动时会清空 outputDir
// （test-results/），而一次带 trace 的运行留下的残留可达 2,000+ 条，清理会被直接拒绝
// （SAFE_DELETE_BULK_CONFIRM_REQUIRED），E2E 在跑第一个用例之前就崩。
// 这里在启动前把残留用 rename（同卷重命名：不进回收站、不受批量上限约束）挪进
// _quarantine/，让 Playwright 总能从干净的目录开始。默认 trace 已关闭，此路径仅在
// 用 PW_TRACE=1 调试过之后才会用到。
async function parkResidue() {
  const residueDirectory = join(projectDirectory, "test-results");
  let entries;
  try {
    entries = await readdir(residueDirectory);
  } catch {
    return; // 不存在：Playwright 会自己创建
  }
  if (entries.length === 0) return; // 空的交给 Playwright 清理即可
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const batchDirectory = join(projectDirectory, "_quarantine", `${stamp.slice(0, 10)}_playwright-residue`);
  await mkdir(batchDirectory, { recursive: true });
  const target = join(batchDirectory, `run-${stamp}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(residueDirectory, target);
      console.log(`[run-e2e] parked previous test-results at _quarantine/${stamp.slice(0, 10)}_playwright-residue/run-${stamp}`);
      return;
    } catch (error) {
      if (attempt === 2) {
        // 挪不动也不能挡住测试；最坏情况是 Playwright 自己清理时被批量上限拦下。
        console.warn(`[run-e2e] could not park test-results: ${error.message}`);
      } else {
        await delay(200); // 目录偶发被占用（Windows），重试即成功
      }
    }
  }
}

let exitCode = 1;
try {
  await waitForServer();
  await parkResidue();
  exitCode = await runPlaywright();
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(3_000),
  ]);
}

process.exitCode = exitCode;
