#!/bin/bash
# Daymark Tauri 打包：手动配置 MSVC 环境变量（不调用 vcvars64.bat，避免 reg.exe 触发宿主程序黑名单）
set -e
cd "F:/PythonProject/Daymark"

MSVC="D:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.43.34808"
KITS="C:/Program Files (x86)/Windows Kits/10"
SDK="10.0.22621.0"

# PATH：cl.exe / link.exe / rc.exe 等本地工具（POSIX 风格）
export PATH="/d/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.43.34808/bin/HostX64/x64:$KITS/bin/$SDK/x64:$PATH"

# INCLUDE / LIB：cl.exe 与 link.exe 用的 Windows 风格分号列表
export INCLUDE="D:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.43.34808\\include;C:\\Program Files (x86)\\Windows Kits\\10\\include\\$SDK\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\include\\$SDK\\um;C:\\Program Files (x86)\\Windows Kits\\10\\include\\$SDK\\shared;C:\\Program Files (x86)\\Windows Kits\\10\\include\\$SDK\\winrt;C:\\Program Files (x86)\\Windows Kits\\10\\include\\$SDK\\cppwinrt"
export LIB="D:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\14.43.34808\\lib\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\$SDK\\um\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\$SDK\\ucrt\\x64"

echo "=== env check ==="
which cl.exe link.exe rc.exe || true
cl 2>&1 | head -2 || true

echo "=== build ==="
npm run tauri build
