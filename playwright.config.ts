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
    trace: "retain-on-failure",
  },
});
