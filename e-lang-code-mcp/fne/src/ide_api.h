#pragma once

#include <windows.h>
#include <tchar.h>

#include <string>

#include <lib2.h>

#include "mini_json.hpp"

namespace bridge {

void SetNotifyFunction(PFN_NOTIFY_SYS function);
bool IsConnected();
HWND GetIdeMainWindow();
BOOL RunIdeFunction(DWORD functionNumber, DWORD parameter1 = 0, DWORD parameter2 = 0);

mj::Value DispatchRequest(const std::string& method, const mj::Value& params);
mj::Value HandleRequest(const mj::Value& request);

}  // namespace bridge
