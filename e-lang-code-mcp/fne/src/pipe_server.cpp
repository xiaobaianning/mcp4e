#include "pipe_server.h"

#include <atomic>
#include <chrono>
#include <sddl.h>
#include <stdexcept>
#include <string>
#include <thread>

#include "ide_api.h"

namespace bridge {
namespace {

constexpr wchar_t kPipeName[] = L"\\\\.\\pipe\\e-lang-code-mcp";
constexpr wchar_t kWindowClass[] = L"ELangCodeMcpDispatch";
constexpr UINT kDispatchMessage = WM_APP + 0x595;

std::atomic<bool> g_running{false};
HWND g_window = nullptr;
std::thread g_thread;
bool g_classRegistered = false;

struct Exchange {
    const mj::Value* request;
    mj::Value response;
};

std::string ReadLine(HANDLE pipe) {
    std::string value;
    char buffer[4096];
    DWORD read = 0;
    while (ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
        value.append(buffer, read);
        const size_t newline = value.find('\n');
        if (newline != std::string::npos) {
            value.resize(newline);
            break;
        }
        if (value.size() > 8 * 1024 * 1024) throw std::runtime_error("pipe request too large");
    }
    return value;
}

void WriteLine(HANDLE pipe, const std::string& line) {
    std::string data = line;
    data.push_back('\n');
    DWORD written = 0;
    WriteFile(pipe, data.data(), static_cast<DWORD>(data.size()), &written, nullptr);
    FlushFileBuffers(pipe);
}

LRESULT CALLBACK DispatchWndProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == kDispatchMessage) {
        auto* exchange = reinterpret_cast<Exchange*>(lParam);
        exchange->response = HandleRequest(*exchange->request);
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

HANDLE CreateInstance() {
    return CreateNamedPipeW(
        kPipeName,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_UNLIMITED_INSTANCES,
        1024 * 1024,
        1024 * 1024,
        0,
        nullptr);
}

void ServerLoop() {
    HANDLE pipe = CreateInstance();
    while (g_running.load() && pipe != INVALID_HANDLE_VALUE) {
        const BOOL connected = ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED;
        if (!connected || !g_running.load()) {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
            pipe = g_running.load() ? CreateInstance() : INVALID_HANDLE_VALUE;
            if (!g_running.load()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }

        // 关键：先把“下一个”实例创建好，然后才处理当前请求。
        // 这样客户端在两次请求之间（甚至并发）总能立即连上，不会出现 ENOENT。
        HANDLE next = CreateInstance();

        try {
            const std::string line = ReadLine(pipe);
            if (!line.empty()) {
                mj::Value request = mj::Value::parse(line);
                Exchange exchange{&request, mj::Value::object()};
                if (g_window && IsWindow(g_window)) {
                    SendMessageW(g_window, kDispatchMessage, 0, reinterpret_cast<LPARAM>(&exchange));
                    WriteLine(pipe, exchange.response.dump());
                } else {
                    mj::Value error = mj::Value::object();
                    error["id"] = 0;
                    error["ok"] = false;
                    error["error"] = "bridge not ready";
                    WriteLine(pipe, error.dump());
                }
            }
        } catch (const std::exception& error) {
            mj::Value response = mj::Value::object();
            response["id"] = 0;
            response["ok"] = false;
            response["error"] = std::string(error.what());
            WriteLine(pipe, response.dump());
        }

        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        pipe = next;
    }
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
}

}  // namespace

bool StartPipeServer() {
    if (g_running.exchange(true)) return true;

    HINSTANCE instance = GetModuleHandleW(nullptr);
    if (!g_classRegistered) {
        WNDCLASSEXW windowClass{};
        windowClass.cbSize = sizeof(windowClass);
        windowClass.lpfnWndProc = DispatchWndProc;
        windowClass.hInstance = instance;
        windowClass.lpszClassName = kWindowClass;
        if (!RegisterClassExW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            g_running = false;
            return false;
        }
        g_classRegistered = true;
    }
    // 在调用线程（IDE UI 线程）创建消息窗口，之后所有 IDE 调用都在此窗口过程里执行。
    g_window = CreateWindowExW(0, kWindowClass, L"E-Lang MCP Bridge", 0, 0, 0, 0, 0,
                               HWND_MESSAGE, nullptr, instance, nullptr);
    if (!g_window) {
        g_running = false;
        return false;
    }
    try {
        g_thread = std::thread(ServerLoop);
        return true;
    } catch (...) {
        g_running = false;
        DestroyWindow(g_window);
        g_window = nullptr;
        return false;
    }
}

void StopPipeServer() {
    if (!g_running.exchange(false)) return;
    // 用一次连接唤醒可能阻塞在 ConnectNamedPipe 的线程。
    HANDLE wake = CreateFileW(kPipeName, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (wake != INVALID_HANDLE_VALUE) CloseHandle(wake);
    if (g_thread.joinable()) g_thread.join();
    if (g_window && IsWindow(g_window)) DestroyWindow(g_window);
    g_window = nullptr;
    if (g_classRegistered) {
        UnregisterClassW(kWindowClass, GetModuleHandleW(nullptr));
        g_classRegistered = false;
    }
}

}  // namespace bridge
