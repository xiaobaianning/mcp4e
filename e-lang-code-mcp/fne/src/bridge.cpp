// 支持库入口：定义 LIB_INFO、命令表，并处理 IDE 通知。
#include <windows.h>
#include <tchar.h>

#include <cstddef>

#include <lib2.h>
#include <lang.h>

#include "ide_api.h"
#include "pipe_server.h"

namespace {

constexpr INT kCommandCount = 1;

// 命令实现（PFN_EXECUTE_CMD 是 cdecl）
extern "C" void CmdBridgeStatus(PMDATA_INF result, INT, PMDATA_INF) {
    if (result) result->m_bool = bridge::IsConnected() ? BL_TRUE : BL_FALSE;
}

// 命令描述表
CMD_INFO g_commands[kCommandCount] = {
    {
        _T("MCP_桥接状态"),
        _T("McpBridgeStatus"),
        _T("返回 MCP IDE 桥接是否已经连接到易语言开发环境。"),
        1,
        static_cast<WORD>(_CMD_OS(__OS_WIN)),
        static_cast<DATA_TYPE>(SDT_BOOL),
        0,
        LVL_SIMPLE,
        0,
        0,
        0,
        nullptr,
    },
};

PFN_EXECUTE_CMD g_commandFunctions[kCommandCount] = { CmdBridgeStatus };
const char* g_commandNames[kCommandCount] = { "CmdBridgeStatus" };

// 分类字符串：格式为 "0000分类名\0" 重复，最后以 \0\0 结束。
TCHAR g_categories[] = _T("0000易语言 MCP\0\0");

INT WINAPI BridgeNotify(INT message, DWORD parameter1, DWORD parameter2) {
    switch (message) {
        case NL_SYS_NOTIFY_FUNCTION:
            bridge::SetNotifyFunction(reinterpret_cast<PFN_NOTIFY_SYS>(parameter1));
            return NR_OK;
        case NL_IDE_READY:
            return bridge::StartPipeServer() ? NR_OK : NR_ERR;
        case NL_UNLOAD_FROM_IDE:
        case NL_FREE_LIB_DATA:
            bridge::StopPipeServer();
            return NR_OK;
        default:
            return NR_ERR;
    }
}

extern "C" INT WINAPI ELangMcp_ProcessNotifyLib(INT message, DWORD parameter1, DWORD parameter2) {
    if (message == NL_GET_CMD_FUNC_NAMES) return reinterpret_cast<INT>(g_commandNames);
    if (message == NL_GET_NOTIFY_LIB_FUNC_NAME) return reinterpret_cast<INT>("ELangMcp_ProcessNotifyLib");
    if (message == NL_GET_DEPENDENT_LIBS) return 0;
    return BridgeNotify(message, parameter1, parameter2);
}

LIB_INFO g_libraryInfo = {
    LIB_FORMAT_VER,
    _T("7F3A9C2E5B1D4A6F8E0C1D2B3A4F5E60"),
    1,
    0,
    0,
    5,
    0,
    3,
    0,
    _T("易语言 MCP 桥接支持库"),
    __GBK_LANG_VER,
    _T("通过易语言官方 IDE 接口，让 AI 读取和修改当前工程代码。"),
    _LIB_OS(__OS_WIN) | LBS_IDE_PLUGIN,
    _T(""),
    _T(""),
    _T(""),
    _T(""),
    _T(""),
    _T(""),
    _T(""),
    _T(""),
    0,
    nullptr,
    1,
    g_categories,
    kCommandCount,
    g_commands,
    g_commandFunctions,
    nullptr,
    nullptr,
    ELangMcp_ProcessNotifyLib,
    nullptr,
    nullptr,
    0,
    nullptr,
    nullptr,
};

}  // namespace

extern "C" __declspec(dllexport) PLIB_INFO WINAPI GetNewInf() {
    return &g_libraryInfo;
}

BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) {
    return TRUE;
}
