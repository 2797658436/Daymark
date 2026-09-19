// Windows 的 release 构建不附带控制台窗口；debug 构建保留，方便看日志。
// 没有这一行时，release 版每次启动都会额外弹出一个黑色终端窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    daymark_lib::run();
}
