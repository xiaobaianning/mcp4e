#pragma once

#include <windows.h>

namespace bridge {

// 在调用线程（必须是 IDE UI 线程）创建派发窗口并启动命名管道服务线程。
bool StartPipeServer();
// 停止管道并销毁派发窗口（必须从创建它的 UI 线程调用）。
void StopPipeServer();

}  // namespace bridge
