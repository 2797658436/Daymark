import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 原生层构建配置护栏。
 *
 * `src-tauri/Cargo.toml` 的 `[build-dependencies]` 里有一行看起来「没人用」的
 * `indexmap = { version = "1.9", features = ["std"] }`。它其实是必需的：
 *
 * - `indexmap 1.9.3` 是 `schemars 0.8` 的构建期依赖（`tauri-build` → `tauri-utils` → `schemars`）；
 * - 它的 `build.rs` 在 `CARGO_FEATURE_STD` 未设置时用 autocfg **探测**目标是否带 `std`；
 * - 探测失败时编译出的 `IndexMap<K, V, S>` 没有 `S` 的默认值，而 `schemars` 写的是
 *   `indexmap::IndexMap<K, V>` → 整个原生层以 `error[E0107]` 编译失败
 *   （rustc/cargo 1.97.1 可稳定复现，`cargo clean -p indexmap` 后同样失败）；
 * - 显式启用 `std` 让那个 `build.rs` 走 `autocfg::emit("has_std")`、完全跳过探测。
 *
 * 为什么这条护栏放在前端测试里：一旦有人删掉那一行，原生测试**根本编译不出来**，
 * 用 Rust 测试守住它是不可能生效的 —— 只有不依赖 cargo 的测试才能真正报出原因。
 */
describe("native build configuration", () => {
  // 用字符串路径而不是 URL：本机 node 的 fs 被 shim 包装，不接受 URL 对象。
  const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src-tauri/Cargo.toml");
  const cargoManifest = readFileSync(manifestPath, "utf8");

  it("keeps indexmap pinned with the std feature for the schemars build dependency", () => {
    const pinned = cargoManifest.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("indexmap") && trimmed.includes("1.9") && trimmed.includes("std");
    });
    expect(pinned, "Cargo.toml 的 [build-dependencies] 必须保留 indexmap 的 std 特性，否则原生层会以 E0107 编译失败").toBe(true);
  });
});
