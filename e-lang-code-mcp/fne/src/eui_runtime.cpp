// eui_runtime.dll —— 读 .eui.json，用 Win32 原生控件渲染窗口，事件回调给易语言。
//
// 导出（均为 __stdcall）：
//   int  EUI_RunA(const char* documentPath, EUI_EVENT_CALLBACK callback)   // 建窗口 + 消息循环
//   int  EUI_Close()
//   int  EUI_SetTextA(int runtimeId, const char* text)
//   const char* EUI_GetTextPtrA(int runtimeId)
//   int  EUI_SetVisible(int runtimeId, int visible)
//   int  EUI_SetEnabled(int runtimeId, int enabled)
//   int  EUI_GetLastEventControl()
//   int  EUI_GetLastEventCode()
//   const char* EUI_GetLastEventValuePtrA()
#include <windows.h>

#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "mini_json.hpp"

namespace {

constexpr wchar_t kWindowClass[] = L"ELangMcpRuntimeWindow";
constexpr UINT kQuitMessage = WM_APP + 0x441;
constexpr UINT_PTR kTimerId = 1;
constexpr UINT kTimerIntervalMs = 500;

enum EventCode {
    kWindowCreated = 1,
    kWindowClosing = 2,
    kButtonClick = 100,
    kTextChanged = 200,
    kCheckedChanged = 300,
    kSelectionChanged = 400,
    kTimer = 500,
};

const char* EventName(int code) {
    switch (code) {
        case kWindowCreated: return "created";
        case kWindowClosing: return "closing";
        case kButtonClick: return "click";
        case kTextChanged: return "textChanged";
        case kCheckedChanged: return "checkedChanged";
        case kSelectionChanged: return "selectionChanged";
        case kTimer: return "timer";
        default: return "";
    }
}

using EventCallback = int(__stdcall*)(int controlId, int eventCode, const char* value);

struct Control {
    int runtimeId = 0;
    std::string type = "label";
    std::string text;
    int x = 0;
    int y = 0;
    int width = 80;
    int height = 24;
    bool visible = true;
    bool enabled = true;
    bool checked = false;
    std::vector<std::string> items;
    int selectedIndex = -1;
    std::vector<std::string> events;  // 已绑定的“事件名”列表
};

struct Document {
    std::string title = "Easy UI";
    int width = 720;
    int height = 480;
    bool resizable = true;
    std::string fontFace = "Microsoft YaHei UI";
    int fontSize = 10;
    std::vector<std::string> formEvents;
    std::vector<Control> controls;
};

struct RuntimeState {
    HINSTANCE instance = nullptr;
    HWND window = nullptr;
    DWORD threadId = 0;
    HFONT font = nullptr;
    EventCallback callback = nullptr;
    std::wstring documentPath;
    Document document;
    std::map<int, HWND> controls;
    int lastEventControl = 0;
    int lastEventCode = 0;
    std::string lastEventValue;
};

std::unique_ptr<RuntimeState> g_state;

// ------------------------------------------------------------------ 编码

std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), (int)value.size(), nullptr, 0);
    if (length <= 0) length = MultiByteToWideChar(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0);
    if (length <= 0) return {};
    std::wstring result((size_t)length, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), (int)value.size(), result.data(), length);
    return result;
}

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return {};
    std::string result((size_t)length, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), result.data(), length, nullptr, nullptr);
    return result;
}

std::wstring AnsiToWide(const std::string& value) {
    if (value.empty()) return {};
    int length = MultiByteToWideChar(CP_ACP, 0, value.data(), (int)value.size(), nullptr, 0);
    if (length <= 0) return {};
    std::wstring result((size_t)length, L'\0');
    MultiByteToWideChar(CP_ACP, 0, value.data(), (int)value.size(), result.data(), length);
    return result;
}

std::string WideToAnsi(const std::wstring& value) {
    if (value.empty()) return {};
    int length = WideCharToMultiByte(CP_ACP, 0, value.data(), (int)value.size(), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return {};
    std::string result((size_t)length, '\0');
    WideCharToMultiByte(CP_ACP, 0, value.data(), (int)value.size(), result.data(), length, nullptr, nullptr);
    return result;
}

std::string Utf8ToAnsi(const std::string& value) { return WideToAnsi(Utf8ToWide(value)); }
std::string AnsiToUtf8(const std::string& value) { return WideToUtf8(AnsiToWide(value)); }

// ------------------------------------------------------------------ 文档解析

Document ParseDocument(const std::string& text) {
    const mj::Value root = mj::Value::parse(text);
    Document document;
    if (root.contains("form")) {
        const auto& form = root.at("form");
        if (form.contains("title")) document.title = form.at("title").asString();
        if (form.contains("width")) document.width = form.at("width").asInt();
        if (form.contains("height")) document.height = form.at("height").asInt();
        if (form.contains("resizable")) document.resizable = form.at("resizable").asBool();
        if (form.contains("events")) {
            for (const auto& binding : form.at("events").items()) {
                document.formEvents.push_back(binding.at("event").asString());
            }
        }
    }
    if (root.contains("theme")) {
        const auto& theme = root.at("theme");
        if (theme.contains("fontFace")) document.fontFace = theme.at("fontFace").asString();
        if (theme.contains("fontSize")) document.fontSize = theme.at("fontSize").asInt();
    }
    if (root.contains("controls")) {
        for (const auto& item : root.at("controls").items()) {
            Control control;
            if (item.contains("runtimeId")) control.runtimeId = item.at("runtimeId").asInt();
            if (item.contains("type")) control.type = item.at("type").asString();
            if (item.contains("text")) control.text = item.at("text").asString();
            if (item.contains("x")) control.x = item.at("x").asInt();
            if (item.contains("y")) control.y = item.at("y").asInt();
            if (item.contains("width")) control.width = item.at("width").asInt();
            if (item.contains("height")) control.height = item.at("height").asInt();
            if (item.contains("visible")) control.visible = item.at("visible").asBool();
            if (item.contains("enabled")) control.enabled = item.at("enabled").asBool();
            if (item.contains("checked")) control.checked = item.at("checked").asBool();
            if (item.contains("selectedIndex")) control.selectedIndex = item.at("selectedIndex").asInt();
            if (item.contains("items")) {
                for (const auto& value : item.at("items").items()) control.items.push_back(value.asString());
            }
            if (item.contains("events")) {
                for (const auto& binding : item.at("events").items()) control.events.push_back(binding.at("event").asString());
            }
            document.controls.push_back(std::move(control));
        }
    }
    return document;
}

const Control* FindControl(int runtimeId) {
    if (!g_state) return nullptr;
    for (const auto& control : g_state->document.controls) {
        if (control.runtimeId == runtimeId) return &control;
    }
    return nullptr;
}

bool IsBound(int controlId, int eventCode) {
    if (!g_state) return false;
    const std::string name = EventName(eventCode);
    if (name.empty()) return false;
    if (controlId == 0) {
        for (const auto& event : g_state->document.formEvents) if (event == name) return true;
        return false;
    }
    const Control* control = FindControl(controlId);
    if (!control) return false;
    for (const auto& event : control->events) if (event == name) return true;
    return false;
}

// ------------------------------------------------------------------ 事件

void EmitEvent(int controlId, int eventCode, HWND source = nullptr) {
    if (!g_state) return;
    std::wstring wideValue;
    if (source) {
        const Control* control = FindControl(controlId);
        if (control && control->type == "checkbox") {
            wideValue = SendMessageW(source, BM_GETCHECK, 0, 0) == BST_CHECKED ? L"true" : L"false";
        } else {
            const int length = GetWindowTextLengthW(source);
            if (length > 0) {
                wideValue.resize((size_t)length + 1);
                GetWindowTextW(source, wideValue.data(), length + 1);
                wideValue.resize((size_t)length);
            }
        }
    }
    g_state->lastEventControl = controlId;
    g_state->lastEventCode = eventCode;
    g_state->lastEventValue = WideToAnsi(wideValue);
    if (g_state->callback && IsBound(controlId, eventCode)) {
        g_state->callback(controlId, eventCode, g_state->lastEventValue.c_str());
    }
}

// ------------------------------------------------------------------ 控件

HWND CreateControl(const Control& control) {
    const std::wstring text = Utf8ToWide(control.text);
    const wchar_t* className = L"STATIC";
    DWORD style = WS_CHILD | WS_TABSTOP;
    if (control.type == "label") {
        className = L"STATIC";
        style |= SS_LEFT;
        style &= ~WS_TABSTOP;
    } else if (control.type == "button") {
        className = L"BUTTON";
        style |= BS_PUSHBUTTON;
    } else if (control.type == "text") {
        className = L"EDIT";
        style |= ES_AUTOHSCROLL | WS_BORDER;
    } else if (control.type == "textarea") {
        className = L"EDIT";
        style |= ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL | WS_BORDER;
    } else if (control.type == "checkbox") {
        className = L"BUTTON";
        style |= BS_AUTOCHECKBOX;
    } else if (control.type == "combobox") {
        className = L"COMBOBOX";
        style |= CBS_DROPDOWNLIST | WS_VSCROLL;
    } else {
        return nullptr;
    }
    if (control.visible) style |= WS_VISIBLE;
    if (!control.enabled) style |= WS_DISABLED;

    HWND window = CreateWindowExW(
        0, className, text.c_str(), style,
        control.x, control.y, control.width, control.height,
        g_state->window,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(control.runtimeId)),
        g_state->instance, nullptr);
    if (!window) return nullptr;
    SendMessageW(window, WM_SETFONT, reinterpret_cast<WPARAM>(g_state->font), TRUE);
    if (control.type == "checkbox") {
        SendMessageW(window, BM_SETCHECK, control.checked ? BST_CHECKED : BST_UNCHECKED, 0);
    } else if (control.type == "combobox") {
        for (const auto& item : control.items) {
            const std::wstring wide = Utf8ToWide(item);
            SendMessageW(window, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(wide.c_str()));
        }
        SendMessageW(window, CB_SETCURSEL, control.selectedIndex, 0);
    }
    return window;
}

HFONT CreateRuntimeFont(UINT dpi, int points);

UINT SystemDpi() {
    HDC dc = GetDC(nullptr);
    if (!dc) return 96;
    const int dpi = GetDeviceCaps(dc, LOGPIXELSY);
    ReleaseDC(nullptr, dc);
    return dpi > 0 ? (UINT)dpi : 96;
}

HFONT CreateRuntimeFont(UINT dpi, int points) {
    const std::wstring face = g_state ? Utf8ToWide(g_state->document.fontFace) : L"Microsoft YaHei UI";
    return CreateFontW(
        -MulDiv(points, (int)dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
        DEFAULT_PITCH | FF_DONTCARE, face.c_str());
}

// ------------------------------------------------------------------ 窗口过程

LRESULT CALLBACK RuntimeWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_CLOSE:
            EmitEvent(0, kWindowClosing);
            DestroyWindow(window);
            return 0;
        case WM_DESTROY:
            if (g_state) {
                KillTimer(window, kTimerId);
                g_state->window = nullptr;
                PostThreadMessageW(g_state->threadId, kQuitMessage, 0, 0);
            }
            return 0;
        case WM_TIMER:
            if (wParam == kTimerId) {
                EmitEvent(0, kTimer);
                return 0;
            }
            break;
        case WM_COMMAND: {
            if (!g_state) break;
            const int controlId = LOWORD(wParam);
            const int notification = HIWORD(wParam);
            HWND source = reinterpret_cast<HWND>(lParam);
            const Control* control = FindControl(controlId);
            if (!control) break;
            if (control->type == "button" && notification == BN_CLICKED) {
                EmitEvent(controlId, kButtonClick, source);
            } else if ((control->type == "text" || control->type == "textarea") && notification == EN_CHANGE) {
                EmitEvent(controlId, kTextChanged, source);
            } else if (control->type == "checkbox" && notification == BN_CLICKED) {
                EmitEvent(controlId, kCheckedChanged, source);
            } else if (control->type == "combobox" && notification == CBN_SELCHANGE) {
                EmitEvent(controlId, kSelectionChanged, source);
            }
            return 0;
        }
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

bool RegisterRuntimeClass(HINSTANCE instance) {
    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = RuntimeWindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
    windowClass.lpszClassName = kWindowClass;
    return RegisterClassExW(&windowClass) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

int RunDocument(const std::wstring& path, EventCallback callback) {
    if (g_state) return ERROR_ALREADY_EXISTS;

    auto state = std::make_unique<RuntimeState>();
    state->instance = GetModuleHandleW(L"eui_runtime.dll");
    if (!state->instance) state->instance = GetModuleHandleW(nullptr);
    state->threadId = GetCurrentThreadId();
    state->callback = callback;
    state->documentPath = path;
    state->font = nullptr;

    try {
        const std::string source = [&path]() {
            HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("无法打开界面文档");
            LARGE_INTEGER size{};
            GetFileSizeEx(file, &size);
            std::string data((size_t)size.QuadPart, '\0');
            DWORD read = 0;
            ReadFile(file, data.data(), (DWORD)data.size(), &read, nullptr);
            CloseHandle(file);
            data.resize(read);
            return data;
        }();
        state->document = ParseDocument(source);
    } catch (...) {
        return ERROR_BAD_FORMAT;
    }

    if (!RegisterRuntimeClass(state->instance)) return (int)GetLastError();

    const std::wstring title = Utf8ToWide(state->document.title);
    DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    if (state->document.resizable) style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
    RECT bounds{0, 0, state->document.width, state->document.height};
    AdjustWindowRectEx(&bounds, style, FALSE, 0);

    g_state = std::move(state);
    g_state->font = CreateRuntimeFont(SystemDpi(), g_state->document.fontSize);
    if (!g_state->font) g_state->font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);

    g_state->window = CreateWindowExW(
        0, kWindowClass, title.c_str(), style,
        CW_USEDEFAULT, CW_USEDEFAULT,
        bounds.right - bounds.left, bounds.bottom - bounds.top,
        nullptr, nullptr, g_state->instance, nullptr);
    if (!g_state->window) {
        const int error = (int)GetLastError();
        g_state.reset();
        return error;
    }

    for (const auto& control : g_state->document.controls) {
        HWND child = CreateControl(control);
        if (child) g_state->controls[control.runtimeId] = child;
    }
    ShowWindow(g_state->window, SW_SHOW);
    UpdateWindow(g_state->window);

    for (const auto& event : g_state->document.formEvents) {
        if (event == "timer") { SetTimer(g_state->window, kTimerId, kTimerIntervalMs, nullptr); break; }
    }
    EmitEvent(0, kWindowCreated, nullptr);

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == kQuitMessage) break;
        if (!IsDialogMessageW(g_state->window, &message)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    if (g_state->font && g_state->font != GetStockObject(DEFAULT_GUI_FONT)) DeleteObject(g_state->font);
    g_state.reset();
    return 0;
}

HWND WindowForControl(int runtimeId) {
    if (!g_state) return nullptr;
    const auto iterator = g_state->controls.find(runtimeId);
    return iterator == g_state->controls.end() ? nullptr : iterator->second;
}

}  // namespace

extern "C" __declspec(dllexport) int __stdcall EUI_RunA(const char* documentPath, EventCallback callback) {
    if (!documentPath) return ERROR_INVALID_PARAMETER;
    return RunDocument(std::wstring(AnsiToWide(std::string(documentPath))), callback);
}

extern "C" __declspec(dllexport) int __stdcall EUI_Close() {
    if (!g_state || !g_state->window) return 0;
    return PostMessageW(g_state->window, WM_CLOSE, 0, 0) ? 1 : 0;
}

extern "C" __declspec(dllexport) int __stdcall EUI_SetTextA(int runtimeId, const char* text) {
    if (!text) return 0;
    HWND window = WindowForControl(runtimeId);
    if (!window) return 0;
    return SetWindowTextW(window, AnsiToWide(std::string(text)).c_str()) ? 1 : 0;
}

extern "C" __declspec(dllexport) const char* __stdcall EUI_GetTextPtrA(int runtimeId) {
    static thread_local std::string result;
    result.clear();
    HWND window = WindowForControl(runtimeId);
    if (!window) return result.c_str();
    const int length = GetWindowTextLengthW(window);
    if (length <= 0) return result.c_str();
    std::wstring text((size_t)length + 1, L'\0');
    GetWindowTextW(window, text.data(), length + 1);
    text.resize((size_t)length);
    result = WideToAnsi(text);
    return result.c_str();
}

extern "C" __declspec(dllexport) int __stdcall EUI_SetVisible(int runtimeId, int visible) {
    HWND window = WindowForControl(runtimeId);
    if (!window) return 0;
    ShowWindow(window, visible ? SW_SHOW : SW_HIDE);
    return 1;
}

extern "C" __declspec(dllexport) int __stdcall EUI_SetEnabled(int runtimeId, int enabled) {
    HWND window = WindowForControl(runtimeId);
    if (!window) return 0;
    EnableWindow(window, enabled != 0);
    return 1;
}

extern "C" __declspec(dllexport) int __stdcall EUI_GetLastEventControl() {
    return g_state ? g_state->lastEventControl : 0;
}

extern "C" __declspec(dllexport) int __stdcall EUI_GetLastEventCode() {
    return g_state ? g_state->lastEventCode : 0;
}

extern "C" __declspec(dllexport) const char* __stdcall EUI_GetLastEventValuePtrA() {
    return g_state ? g_state->lastEventValue.c_str() : "";
}

BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) {
    return TRUE;
}
