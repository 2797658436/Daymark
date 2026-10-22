import { expect, test } from "@playwright/test";

/**
 * 开机自启动开关（2026-10-22）。
 *
 * 桌面版由 `tauri-plugin-autostart` 写 Windows 注册表（HKCU\...\Run），启动时追加
 * `--autostart` 静默到托盘；浏览器预览用 localStorage 模拟系统状态。这里验证设置页的
 * 读取、切换与跨刷新持久化这条接线，真实注册表行为由原生层负责。
 */
test("settings remembers the launch-at-startup toggle in the browser preview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();

  const toggle = page.getByRole("checkbox", { name: "开机自启动" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("daymark.preview.autostart"))).toBe("true");

  // 刷新后重新读取的是系统状态（预览里是 localStorage），不是页面内存。
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "开机自启动" })).toBeChecked();

  await page.getByRole("checkbox", { name: "开机自启动" }).click();
  await expect(page.getByRole("checkbox", { name: "开机自启动" })).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("daymark.preview.autostart"))).toBeNull();
});
