#!/usr/bin/env bash
# 在 Git Bash / MSYS 环境下准备 MSVC 工具链后执行给定命令。
#
# 背景：本机 PATH 上没有 MSVC 的 link.exe，只有 Git Bash 自带的
# GNU coreutils `link.exe`。rustc（x86_64-pc-windows-msvc）按名字调用 link.exe 时
# 会命中 GNU 那个，报 `link: missing operand after ...` 之类与真实原因无关的错误。
# 这个脚本把 MSVC + Windows SDK 排到 PATH 最前，并补齐 LIB / INCLUDE。
#
# 用法：
#   scripts/with-msvc-env.sh cargo test --manifest-path src-tauri/Cargo.toml --all-targets
#   scripts/with-msvc-env.sh npm run tauri build

set -euo pipefail

VC_TOOLS_VERSION="${DAYMARK_MSVC_VERSION:-14.43.34808}"
SDK_VERSION="${DAYMARK_WINDOWS_SDK_VERSION:-10.0.22621.0}"
VS_ROOT_WIN='D:\Program Files\Microsoft Visual Studio\2022\Community'
VS_TOOLS_WIN="${VS_ROOT_WIN}\\VC\\Tools\\MSVC\\${VC_TOOLS_VERSION}"
SDK_ROOT_WIN='C:\Program Files (x86)\Windows Kits\10'
VS_ROOT_UNIX='/d/Program Files/Microsoft Visual Studio/2022/Community'
SDK_ROOT_UNIX='/c/Program Files (x86)/Windows Kits/10'

msvc_bin="${VS_ROOT_UNIX}/VC/Tools/MSVC/${VC_TOOLS_VERSION}/bin/Hostx64/x64"
sdk_bin="${SDK_ROOT_UNIX}/bin/${SDK_VERSION}/x64"

if [ ! -x "${msvc_bin}/link.exe" ]; then
  echo "找不到 MSVC 链接器：${msvc_bin}/link.exe" >&2
  echo "请确认 Visual Studio 版本，或用 DAYMARK_MSVC_VERSION 覆盖。" >&2
  exit 1
fi

export PATH="${msvc_bin}:${sdk_bin}:${PATH}"

# 链接器与编译器按 Windows 路径查找库与头文件，这里必须写反斜杠绝对路径。
export LIB="${VS_TOOLS_WIN}\\lib\\x64;${VS_TOOLS_WIN}\\atlmfc\\lib\\x64;${SDK_ROOT_WIN}\\Lib\\${SDK_VERSION}\\ucrt\\x64;${SDK_ROOT_WIN}\\Lib\\${SDK_VERSION}\\um\\x64"
export INCLUDE="${VS_TOOLS_WIN}\\include;${VS_TOOLS_WIN}\\atlmfc\\include;${SDK_ROOT_WIN}\\Include\\${SDK_VERSION}\\ucrt;${SDK_ROOT_WIN}\\Include\\${SDK_VERSION}\\um;${SDK_ROOT_WIN}\\Include\\${SDK_VERSION}\\shared"

# 早期失败就报清楚一点，而不是让 cargo 抛出难懂的链接器错误。
resolved="$(command -v link.exe || true)"
case "${resolved}" in
  "${msvc_bin}/link.exe") ;;
  *) echo "link.exe 解析异常：${resolved:-<未找到>}" >&2; exit 1 ;;
esac

exec "$@"
