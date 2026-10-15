import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  // Vite 开发服务器是首次请求才现编译整个模块图的：实测第一个用例独自承担
  // 这段冷启动（28–30s），其余用例只要 ~1.7s。默认 30s 会让基线随机变红。
  // 这里只放宽整体超时以容纳冷启动，不放宽任何断言。
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1200, height: 760 },
    // trace 会逐帧录 screencast（jpeg），一次全量运行产出约 2,000 个文件；本机沙箱的
    // safe-delete 对「单轮删除」有 50 条上限，Playwright 在成功用例上丢弃 trace 的那次
    // 递归删除会被拦掉，残留累积后下一次启动清空 outputDir 直接失败
    // （SAFE_DELETE_BULK_CONFIRM_REQUIRED，E2E 在跑第一个用例之前就崩）。
    // 默认关闭；需要排查失败时用 PW_TRACE=1 打开（run-e2e.mjs 会把残留挪进 _quarantine/）。
    trace: process.env.PW_TRACE ? "retain-on-failure" : "off",
  },
});
