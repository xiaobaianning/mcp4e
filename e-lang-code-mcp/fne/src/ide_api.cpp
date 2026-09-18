#include "ide_api.h"

#include <algorithm>
#include <cctype>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <commctrl.h>
#include <tlhelp32.h>

#include <PublicIDEFunctions.h>

namespace bridge {
namespace {

PFN_NOTIFY_SYS g_notify = nullptr;
constexpr int kMaxCodeRows = 20000;

// ---------------------------------------------------------------------------
// 编码：MCP 管道用 UTF-8；易语言 IDE 是 MultiByte(CP_ACP/GBK) 程序。
// ---------------------------------------------------------------------------
std::wstring AnsiToWide(const std::string& value) {
    if (value.empty()) return {};
    const int length = MultiByteToWideChar(CP_ACP, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0) return {};
    std::wstring result(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_ACP, 0, value.data(), static_cast<int>(value.size()), result.data(), length);
    return result;
}
std::string WideToAnsi(const std::wstring& value) {
    if (value.empty()) return {};
    const int length = WideCharToMultiByte(CP_ACP, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return {};
    std::string result(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_ACP, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
    return result;
}
std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0) length = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0) return {};
    std::wstring result(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length);
    return result;
}
std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return {};
    std::string result(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
    return result;
}
std::string AnsiToUtf8(const std::string& value) { return WideToUtf8(AnsiToWide(value)); }
std::string Utf8ToAnsi(const std::string& value) { return WideToAnsi(Utf8ToWide(value)); }

// ---------------------------------------------------------------------------
// 代码表单元格模型
// ---------------------------------------------------------------------------
struct ProgramCell {
    int row = 0;
    int column = 0;
    int type = 0;
    bool title = false;
    std::string text;  // 统一存 UTF-8
};

const mj::Value& Optional(const mj::Value& value, const std::string& key) {
    static const mj::Value kNull;
    return value.contains(key) ? value.at(key) : kNull;
}

int IntOr(const mj::Value& value, const std::string& key, int fallback) {
    return value.contains(key) ? value.at(key).asInt() : fallback;
}
bool BoolOr(const mj::Value& value, const std::string& key, bool fallback) {
    return value.contains(key) ? value.at(key).asBool() : fallback;
}

void PumpIdeMessages(DWORD waitMilliseconds = 2) {
    for (int pass = 0; pass < 3; ++pass) {
        MsgWaitForMultipleObjects(0, nullptr, FALSE, pass == 0 ? waitMilliseconds : 0, QS_ALLINPUT);
        MSG message{};
        bool dispatched = false;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            dispatched = true;
        }
        if (!dispatched) break;
    }
}

// 等待指定毫秒，期间继续泵 IDE 消息（不阻塞界面）。
void WaitWithPump(DWORD milliseconds) {
    const ULONGLONG start = GetTickCount64();
    while (GetTickCount64() - start < milliseconds) {
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 30, QS_ALLINPUT);
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if (!IsConnected()) break;
    }
}

std::pair<int, int> CurrentCaret() {
    int row = -1;
    int column = -1;
    RunIdeFunction(FN_GET_CARET_ROW_INDEX, reinterpret_cast<DWORD>(&row), 0);
    RunIdeFunction(FN_GET_CARET_COL_INDEX, reinterpret_cast<DWORD>(&column), 0);
    return {row, column};
}

bool ReadProgramCell(int row, int column, ProgramCell* output) {
    GET_PRG_TEXT_PARAM parameters{};
    parameters.m_nRowIndex = row;
    parameters.m_nColIndex = column;
    parameters.m_pBuf = nullptr;
    parameters.m_nBufSize = 0;
    if (!RunIdeFunction(FN_GET_PRG_TEXT, reinterpret_cast<DWORD>(&parameters), 0)) return false;
    // 注意：空文本的单元格 m_nBufSize 会是 0，但类型/标题仍然有效，不能当成“不存在”。
    output->row = row;
    output->column = column;
    output->type = parameters.m_nType;
    output->title = parameters.m_blIsTitle != FALSE;
    output->text.clear();
    if (parameters.m_nBufSize > 0) {
        std::vector<char> buffer(static_cast<size_t>(parameters.m_nBufSize) + 1, '\0');
        parameters.m_pBuf = buffer.data();
        parameters.m_nBufSize = static_cast<int>(buffer.size());
        if (RunIdeFunction(FN_GET_PRG_TEXT, reinterpret_cast<DWORD>(&parameters), 0)) {
            output->text = AnsiToUtf8(std::string(buffer.data()));
        }
    }
    return true;
}

std::vector<ProgramCell> ReadCellsInRange(int startRow, int endRow) {
    std::vector<ProgramCell> cells;
    for (int row = std::max(0, startRow); row < endRow; ++row) {
        for (int column = 0; column < 16; ++column) {
            ProgramCell cell;
            if (!ReadProgramCell(row, column, &cell)) break;
            if (cell.type != 0 || cell.title || !cell.text.empty()) cells.push_back(std::move(cell));
            if (cell.type == VT_SUB_PRG_ITEM) break;
        }
    }
    return cells;
}

// 代码表只“物化”当前行附近的内容，所以从顶部开始【逐行】下移读取：
// 每读一行就把光标停在该行上，保证该行一定已物化；到“光标不再移动”为止。
std::vector<ProgramCell> ReadCurrentCells(int maxRows) {
    const auto origin = CurrentCaret();
    std::map<std::pair<int, int>, ProgramCell> merged;
    constexpr int kLook = 32;
    constexpr int kLookEvery = 16;

    if (!RunIdeFunction(FN_MOVE_TOP)) return {};
    PumpIdeMessages();

    int previousRow = -1;
    for (int step = 0; step < maxRows; ++step) {
        const auto caret = CurrentCaret();
        const int row = caret.first;
        if (row < 0 || row >= maxRows) break;
        if (row == previousRow) break;  // 光标卡住 = 已到底部
        previousRow = row;

        // 当前行必定已物化。
        for (auto& cell : ReadCellsInRange(row, row + 1)) merged[{cell.row, cell.column}] = std::move(cell);
        // 每隔一段顺带读一个窗口，兼顾被折叠/隐藏的行。
        if (step % kLookEvery == 0) {
            const int start = std::max(0, row - kLook);
            const int end = std::min(maxRows, row + kLook + 1);
            for (auto& cell : ReadCellsInRange(start, end)) merged[{cell.row, cell.column}] = std::move(cell);
        }

        const auto before = CurrentCaret();
        if (!RunIdeFunction(FN_MOVE_DOWN)) break;
        PumpIdeMessages(0);
        if (CurrentCaret() == before) break;
    }
    PumpIdeMessages();

    if (origin.first >= 0) {
        RunIdeFunction(FN_MOVE_CARET, static_cast<DWORD>(origin.first), static_cast<DWORD>(origin.second));
        PumpIdeMessages();
    }

    std::vector<ProgramCell> cells;
    cells.reserve(merged.size());
    for (auto& entry : merged) cells.push_back(std::move(entry.second));
    return cells;
}

std::string RevisionForCells(const std::vector<ProgramCell>& cells) {
    unsigned long long hash = 1469598103934665603ULL;  // FNV-1a 64
    const auto mix = [&hash](const std::string& value) {
        for (unsigned char byte : value) { hash ^= byte; hash *= 1099511628211ULL; }
        hash ^= 0xff;
        hash *= 1099511628211ULL;
    };
    for (const auto& cell : cells) {
        mix(cell.text);
        mix(std::to_string(cell.type));
        mix(cell.title ? "1" : "0");
        hash ^= static_cast<unsigned long long>(cell.row * 31 + cell.column);
        hash *= 1099511628211ULL;
    }
    char output[32]{};
    std::snprintf(output, sizeof(output), "%016llx", hash);
    return output;
}

mj::Value CellToJson(const ProgramCell& cell) {
    mj::Value item = mj::Value::object();
    item["row"] = cell.row;
    item["column"] = cell.column;
    item["type"] = cell.type;
    item["title"] = cell.title;
    item["text"] = cell.text;
    return item;
}

mj::Value CellsToJson(const std::vector<ProgramCell>& cells, int maxRows, bool includeEmpty) {
    mj::Value array = mj::Value::array();
    for (const auto& cell : cells) {
        if (cell.row >= maxRows) continue;
        if (!includeEmpty && cell.text.empty()) continue;
        array.push(CellToJson(cell));
    }
    return array;
}

bool MoveCaretToCell(int row, int column) {
    if (row < 0 || column < 0) return false;
    if (RunIdeFunction(FN_MOVE_CARET, static_cast<DWORD>(row), static_cast<DWORD>(column))) {
        PumpIdeMessages();
        const auto caret = CurrentCaret();
        ProgramCell probe;
        if (caret.first == row && caret.second == column && ReadProgramCell(row, 0, &probe) && probe.type != 0) return true;
    }
    if (!RunIdeFunction(FN_MOVE_TOP)) return false;
    PumpIdeMessages();
    for (int step = 0; step < kMaxCodeRows * 2; ++step) {
        const auto current = CurrentCaret();
        if (current.first == row) {
            if (!RunIdeFunction(FN_MOVE_CARET, static_cast<DWORD>(row), static_cast<DWORD>(column))) return false;
            PumpIdeMessages();
            const auto selected = CurrentCaret();
            ProgramCell probe;
            return selected.first == row && selected.second == column && ReadProgramCell(row, 0, &probe) && probe.type != 0;
        }
        if (current.first < 0 || current.first > row) return false;
        if (!RunIdeFunction(FN_MOVE_DOWN)) return false;
        PumpIdeMessages(0);
        if (CurrentCaret() == current) return false;
    }
    return false;
}

int ExpectedCellTypeForKind(const std::string& kind) {
    if (kind == "module") return VT_MOD_NAME;
    if (kind == "subprogram") return VT_SUB_NAME;
    if (kind == "dllCommand") return VT_DLL_CMD_NAME;
    if (kind == "argument") return VT_SUB_ARG_NAME;
    if (kind == "localVariable") return VT_SUB_VAR_NAME;
    if (kind == "globalVariable") return VT_GLOBAL_VAR_NAME;
    if (kind == "statement" || kind == "statementAfter") return VT_SUB_PRG_ITEM;
    return -1;
}

const ProgramCell* FindCell(const std::vector<ProgramCell>& cells, int column) {
    for (const auto& cell : cells) if (cell.column == column) return &cell;
    return nullptr;
}

void VerifyCellKind(int row, int column, const std::string& kind) {
    if (!MoveCaretToCell(row, column)) throw std::runtime_error("cannot move to the requested code cell");
    const auto cells = ReadCellsInRange(row, row + 1);
    const auto* cell = FindCell(cells, 0);
    const int expected = ExpectedCellTypeForKind(kind);
    if (expected < 0) throw std::runtime_error("unsupported code cell kind: " + kind);
    if (!cell || cell->title || cell->type != expected) {
        std::ostringstream message;
        message << "code cell kind mismatch at row " << row << ": expected " << kind << " (" << expected
                << "), actual " << (cell ? cell->type : -1);
        throw std::runtime_error(message.str());
    }
}

void SetProgramCellText(int row, int column, const std::string& utf8Text, bool compile) {
    const std::string ansiText = Utf8ToAnsi(utf8Text);
    if (!MoveCaretToCell(row, column)) throw std::runtime_error("cannot move the IDE caret");
    if (!RunIdeFunction(FN_SET_AND_COMPILE_PRG_ITEM_TEXT,
                        reinterpret_cast<DWORD>(const_cast<char*>(ansiText.c_str())),
                        compile ? TRUE : FALSE)) {
        throw std::runtime_error("the IDE rejected the code cell edit");
    }
    PumpIdeMessages();
    ProgramCell applied;
    const bool readable = ReadProgramCell(row, column, &applied);
    const std::string actual = readable ? applied.text : std::string();
    const auto strip = [](const std::string& value) {
        std::string result;
        for (unsigned char c : value) {
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;
            result.push_back(static_cast<char>(c));
        }
        return result;
    };
    if (!readable || strip(actual) != strip(utf8Text)) {
        std::ostringstream message;
        message << "the IDE did not persist the requested code cell text at row " << row << " col " << column
                << ": expected [" << utf8Text << "], actual [" << actual << "]";
        throw std::runtime_error(message.str());
    }
}

std::vector<ProgramCell> ReadAndVerifyRevision(const mj::Value& params) {
    const std::string expected = params.at("expectedRevision").asString();
    auto cells = ReadCurrentCells(kMaxCodeRows);
    const std::string actual = RevisionForCells(cells);
    if (actual != expected) throw std::runtime_error("current code changed since it was read (revision mismatch)");
    return cells;
}

void RollBackToRevision(const std::string& revision, int mutations) {
    for (int attempt = 0; attempt < mutations + 4; ++attempt) {
        if (RevisionForCells(ReadCurrentCells(kMaxCodeRows)) == revision) return;
        if (!RunIdeFunction(FN_UNDO)) break;
        PumpIdeMessages();
    }
    if (RevisionForCells(ReadCurrentCells(kMaxCodeRows)) != revision) {
        throw std::runtime_error("rollback was incomplete; the code may have changed");
    }
}

DWORD InsertFunctionForKind(const std::string& kind) {
    if (kind == "module") return FN_INSERT_NEW_MOD;
    if (kind == "subprogram") return FN_INSERT_NEW_SUB;
    if (kind == "dllCommand") return FN_INSERT_NEW_DLL_CMD;
    if (kind == "argument") return FN_INSERT_NEW_ARG;
    if (kind == "localVariable") return FN_INSERT_NEW_LOCAL_VAR;
    if (kind == "globalVariable") return FN_INSERT_NEW_GLOBAL_VAR;
    if (kind == "statement") return FN_INSERT_NEW;
    if (kind == "statementAfter") return FN_INSERT_NEW_AT_NEXT;
    throw std::runtime_error("unsupported code unit kind: " + kind);
}

std::filesystem::path ProjectPathFromTitle() {
    wchar_t explicitPath[32768]{};
    const DWORD explicitLength = GetEnvironmentVariableW(L"E_LANGUAGE_ACTIVE_PROJECT", explicitPath,
                                                         static_cast<DWORD>(std::size(explicitPath)));
    if (explicitLength > 0 && explicitLength < std::size(explicitPath)) {
        std::filesystem::path path(explicitPath);
        if (std::filesystem::exists(path)) return std::filesystem::absolute(path);
    }
    HWND ide = GetIdeMainWindow();
    if (!ide) return {};
    const int length = GetWindowTextLengthW(ide);
    if (length <= 0) return {};
    std::wstring title(static_cast<size_t>(length) + 1, L'\0');
    GetWindowTextW(ide, title.data(), length + 1);
    title.resize(static_cast<size_t>(length));
    const size_t drive = title.find(L":\\");
    if (drive == std::wstring::npos || drive == 0) return {};
    const size_t start = drive - 1;
    size_t extension = title.find(L".e8", start);
    size_t extensionLength = 3;
    if (extension == std::wstring::npos) { extension = title.find(L".e", start); extensionLength = 2; }
    if (extension == std::wstring::npos) return {};
    const std::filesystem::path candidate(title.substr(start, extension - start + extensionLength));
    return std::filesystem::exists(candidate) ? std::filesystem::absolute(candidate) : std::filesystem::path{};
}

struct DiagnosticCandidate {
    std::wstring className;
    std::wstring title;
    std::wstring text;
    bool editLike = false;
    bool visible = false;
};

std::wstring ReadWindowText(HWND window) {
    const int length = GetWindowTextLengthW(window);
    if (length <= 0) return {};
    std::wstring text(static_cast<size_t>(length) + 1, L'\0');
    GetWindowTextW(window, text.data(), length + 1);
    text.resize(static_cast<size_t>(length));
    return text;
}

BOOL CALLBACK CollectDiagnostics(HWND window, LPARAM parameter) {
    auto* candidates = reinterpret_cast<std::vector<DiagnosticCandidate>*>(parameter);
    wchar_t className[128]{};
    GetClassNameW(window, className, static_cast<int>(std::size(className)));
    std::wstring lowered(className);
    std::transform(lowered.begin(), lowered.end(), lowered.begin(), towlower);
    const bool editLike =
        lowered.find(L"edit") != std::wstring::npos || lowered.find(L"richedit") != std::wstring::npos;
    std::wstring text = ReadWindowText(window);
    // 标准编辑控件全收；其他控件只在文本较长时才当作候选（输出面板常是自绘控件）。
    if (!editLike && text.size() < 24) return TRUE;
    DiagnosticCandidate candidate;
    candidate.className = className;
    candidate.title = text;
    candidate.text = std::move(text);
    candidate.editLike = editLike;
    candidate.visible = IsWindowVisible(window) != FALSE;
    candidates->push_back(std::move(candidate));
    return TRUE;
}

std::vector<DiagnosticCandidate> CollectDiagnosticCandidates() {
    std::vector<DiagnosticCandidate> candidates;
    EnumChildWindows(GetIdeMainWindow(), CollectDiagnostics, reinterpret_cast<LPARAM>(&candidates));
    // 编辑类 > 可见 > 文本长度。
    std::sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
        if (left.editLike != right.editLike) return left.editLike;
        if (left.visible != right.visible) return left.visible;
        return left.text.size() > right.text.size();
    });
    return candidates;
}

std::wstring PrimaryOutputText(const std::vector<DiagnosticCandidate>& candidates) {
    for (const auto& candidate : candidates) {
        if (candidate.editLike && !candidate.text.empty()) return candidate.text;
    }
    return {};
}

mj::Value ReadDiagnostics() {
    const auto candidates = CollectDiagnosticCandidates();
    mj::Value entries = mj::Value::array();
    for (size_t index = 0; index < std::min<size_t>(candidates.size(), 20); ++index) {
        mj::Value item = mj::Value::object();
        item["className"] = WideToUtf8(candidates[index].className);
        item["text"] = WideToUtf8(candidates[index].text);
        item["length"] = static_cast<int>(candidates[index].text.size());
        item["visible"] = candidates[index].visible;
        entries.push(std::move(item));
    }
    mj::Value result = mj::Value::object();
    result["available"] = !candidates.empty();
    result["output"] = WideToUtf8(PrimaryOutputText(candidates));
    result["entries"] = std::move(entries);
    return result;
}

// 调试用：导出 IDE 所有子窗口的类名/标题/文本长度，用于定位“输出”面板等控件。
struct WindowEntry {
    std::wstring className;
    std::wstring title;
    std::wstring text;
    bool visible = false;
    int width = 0;
    int height = 0;
    int depth = 0;
};

BOOL CALLBACK CollectWindows(HWND window, LPARAM parameter) {
    auto* entries = reinterpret_cast<std::vector<WindowEntry>*>(parameter);
    if (entries->size() >= 800) return FALSE;
    WindowEntry entry;
    wchar_t className[256]{};
    GetClassNameW(window, className, static_cast<int>(std::size(className)));
    entry.className = className;
    entry.title = ReadWindowText(window);
    entry.text = entry.title;
    entry.visible = IsWindowVisible(window) != FALSE;
    RECT bounds{};
    GetWindowRect(window, &bounds);
    entry.width = bounds.right - bounds.left;
    entry.height = bounds.bottom - bounds.top;
    int depth = 0;
    for (HWND parent = GetParent(window); parent; parent = GetParent(parent)) ++depth;
    entry.depth = depth;
    entries->push_back(std::move(entry));
    return TRUE;
}

mj::Value DumpWindows() {
    std::vector<WindowEntry> entries;
    EnumChildWindows(GetIdeMainWindow(), CollectWindows, reinterpret_cast<LPARAM>(&entries));
    mj::Value array = mj::Value::array();
    for (const auto& entry : entries) {
        mj::Value item = mj::Value::object();
        item["className"] = WideToUtf8(entry.className);
        item["title"] = WideToUtf8(entry.title);
        item["length"] = static_cast<int>(entry.text.size());
        item["visible"] = entry.visible;
        item["width"] = entry.width;
        item["height"] = entry.height;
        item["depth"] = entry.depth;
        array.push(std::move(item));
    }
    mj::Value result = mj::Value::object();
    result["count"] = static_cast<int>(entries.size());
    result["entries"] = std::move(array);
    return result;
}

// 枚举当前工程已选择的支持库（官方 FN_GET_NUM_LIB / FN_GET_LIB_INFO_TEXT）。
mj::Value ListLibraries() {
    int count = 0;
    RunIdeFunction(FN_GET_NUM_LIB, reinterpret_cast<DWORD>(&count), 0);
    if (count < 0) count = 0;
    mj::Value array = mj::Value::array();
    for (int index = 0; index < count; ++index) {
        char* text = nullptr;
        const BOOL ok = RunIdeFunction(FN_GET_LIB_INFO_TEXT, static_cast<DWORD>(index),
                                       reinterpret_cast<DWORD>(&text));
        mj::Value item = mj::Value::object();
        item["index"] = index;
        item["ok"] = ok != FALSE;
        item["info"] = (text && *text) ? AnsiToUtf8(std::string(text)) : std::string();
        array.push(std::move(item));
    }
    mj::Value result = mj::Value::object();
    result["count"] = count;
    result["libraries"] = std::move(array);
    return result;
}

// 枚举当前工程已使用的易模块（官方 FN_GET_NUM_ECOM / FN_GET_ECOM_FILE_NAME）。
mj::Value ListEcoms() {
    int count = 0;
    RunIdeFunction(FN_GET_NUM_ECOM, reinterpret_cast<DWORD>(&count), 0);
    if (count < 0) count = 0;
    mj::Value array = mj::Value::array();
    for (int index = 0; index < count; ++index) {
        std::vector<char> buffer(1024, '\0');
        const BOOL ok = RunIdeFunction(FN_GET_ECOM_FILE_NAME, static_cast<DWORD>(index),
                                       reinterpret_cast<DWORD>(buffer.data()));
        mj::Value item = mj::Value::object();
        item["index"] = index;
        item["ok"] = ok != FALSE;
        item["fileName"] = AnsiToUtf8(std::string(buffer.data()));
        array.push(std::move(item));
    }
    mj::Value result = mj::Value::object();
    result["count"] = count;
    result["ecoms"] = std::move(array);
    return result;
}

// ---------------------------------------------------------------------------
// 命令目录：从已加载的 .fne/.fnr 的 LIB_INFO 里读命令名与参数（按需触发，缓存）。
// ---------------------------------------------------------------------------
struct CommandArgInfo {
    std::string name;
    std::string type;
};

struct CommandInfo {
    std::string name;
    std::string egName;
    std::string explain;
    std::string library;
    std::vector<CommandArgInfo> args;
};

std::string ArgTypeName(DATA_TYPE rawType) {
    const DATA_TYPE type = static_cast<DATA_TYPE>(rawType & ~0x20000000u);  // 清除 DT_IS_ARY
    if (type == SDT_BYTE) return "字节型";
    if (type == SDT_SHORT) return "短整数型";
    if (type == SDT_INT) return "整数型";
    if (type == SDT_INT64) return "长整数型";
    if (type == SDT_FLOAT) return "小数型";
    if (type == SDT_DOUBLE) return "双精度小数型";
    if (type == SDT_BOOL) return "逻辑型";
    if (type == SDT_DATE_TIME) return "日期时间型";
    if (type == SDT_TEXT) return "文本型";
    if (type == SDT_BIN) return "字节集";
    if (type == SDT_SUB_PTR) return "子程序指针";
    return "其它";
}

std::wstring ToAsciiLowerW(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
    return value;
}

std::string ToAsciiLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

const std::vector<CommandInfo>& CommandCatalog() {
    static std::vector<CommandInfo> catalog;
    static bool built = false;
    if (built) return catalog;
    built = true;

    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snapshot == INVALID_HANDLE_VALUE) return catalog;
    MODULEENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) {
        do {
            const std::wstring moduleName = entry.szModule;
            const std::wstring lower = ToAsciiLowerW(moduleName);
            if (lower.size() < 4) continue;
            const std::wstring extension = lower.substr(lower.size() - 4);
            if (extension != L".fne" && extension != L".fnr") continue;
            auto getNewInf = reinterpret_cast<PFN_GET_LIB_INFO>(
                reinterpret_cast<void*>(GetProcAddress(entry.hModule, FUNCNAME_GET_LIB_INFO)));
            if (!getNewInf) continue;
            PLIB_INFO info = getNewInf();
            if (!info || !info->m_pBeginCmdInfo) continue;
            const std::string libraryName =
                info->m_szName ? AnsiToUtf8(std::string(info->m_szName)) : std::string();
            const int commandCount = info->m_nCmdCount;
            for (int i = 0; i < commandCount && i < 100000; ++i) {
                const CMD_INFO& command = info->m_pBeginCmdInfo[i];
                if (!command.m_szName) continue;
                CommandInfo ci;
                ci.name = AnsiToUtf8(std::string(command.m_szName));
                ci.egName = command.m_szEgName ? std::string(command.m_szEgName) : std::string();
                ci.explain = command.m_szExplain ? AnsiToUtf8(std::string(command.m_szExplain)) : std::string();
                ci.library = libraryName;
                if (command.m_pBeginArgInfo) {
                    for (int a = 0; a < command.m_nArgCount && a < 64; ++a) {
                        const ARG_INFO& argument = command.m_pBeginArgInfo[a];
                        CommandArgInfo ai;
                        ai.name = argument.m_szName ? AnsiToUtf8(std::string(argument.m_szName)) : std::string();
                        ai.type = ArgTypeName(argument.m_dtType);
                        ci.args.push_back(std::move(ai));
                    }
                }
                catalog.push_back(std::move(ci));
                if (catalog.size() >= 100000) break;
            }
        } while (Module32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return catalog;
}

// ---------------------------------------------------------------------------
// 支持库命令树（SysTreeView32）：可覆盖 .ec 易模块的命令（官方无直接 API）。
// ---------------------------------------------------------------------------
struct TreeCatalogEntry {
    int treeIndex = 0;
    int depth = 0;
    std::string library;
    std::string path;
    std::string name;
};

BOOL CALLBACK CollectTreeWindows(HWND window, LPARAM parameter) {
    auto* trees = reinterpret_cast<std::vector<HWND>*>(parameter);
    wchar_t className[128]{};
    GetClassNameW(window, className, static_cast<int>(std::size(className)));
    if (std::wstring(className) == L"SysTreeView32") trees->push_back(window);
    return TRUE;
}

std::wstring ReadTreeItemText(HWND tree, HTREEITEM item) {
    if (!item) return {};
    wchar_t wide[512]{};
    TVITEMW wideItem{};
    wideItem.mask = TVIF_TEXT | TVIF_HANDLE;
    wideItem.hItem = item;
    wideItem.pszText = wide;
    wideItem.cchTextMax = static_cast<int>(std::size(wide));
    if (SendMessageW(tree, TVM_GETITEMW, 0, reinterpret_cast<LPARAM>(&wideItem)) && wide[0]) return wide;
    char ansi[512]{};
    TVITEMA ansiItem{};
    ansiItem.mask = TVIF_TEXT | TVIF_HANDLE;
    ansiItem.hItem = item;
    ansiItem.pszText = ansi;
    ansiItem.cchTextMax = static_cast<int>(std::size(ansi));
    if (SendMessageW(tree, TVM_GETITEMA, 0, reinterpret_cast<LPARAM>(&ansiItem)) && ansi[0]) {
        return AnsiToWide(std::string(ansi));
    }
    return {};
}

void WalkTreeItems(HWND tree, HTREEITEM item, const std::wstring& library, const std::wstring& parentPath,
                   std::vector<TreeCatalogEntry>& output, int treeIndex, int depth, int maxItems) {
    if (!item || depth > 10 || static_cast<int>(output.size()) >= maxItems) return;
    const std::wstring name = ReadTreeItemText(tree, item);
    const std::wstring currentLibrary = library.empty() ? name : library;
    const std::wstring path = parentPath.empty() ? name : (parentPath + L" / " + name);
    TreeCatalogEntry entry;
    entry.treeIndex = treeIndex;
    entry.depth = depth;
    entry.library = WideToUtf8(currentLibrary);
    entry.path = WideToUtf8(path);
    entry.name = WideToUtf8(name);
    output.push_back(std::move(entry));
    HTREEITEM child = reinterpret_cast<HTREEITEM>(
        SendMessageW(tree, TVM_GETNEXTITEM, TVGN_CHILD, reinterpret_cast<LPARAM>(item)));
    while (child) {
        WalkTreeItems(tree, child, currentLibrary, path, output, treeIndex, depth + 1, maxItems);
        if (static_cast<int>(output.size()) >= maxItems) return;
        child = reinterpret_cast<HTREEITEM>(
            SendMessageW(tree, TVM_GETNEXTITEM, TVGN_NEXT, reinterpret_cast<LPARAM>(child)));
    }
}

const std::vector<TreeCatalogEntry>& TreeCatalog() {
    static std::vector<TreeCatalogEntry> catalog;
    static bool built = false;
    if (built) return catalog;
    built = true;
    std::vector<HWND> trees;
    EnumChildWindows(GetIdeMainWindow(), CollectTreeWindows, reinterpret_cast<LPARAM>(&trees));
    for (size_t index = 0; index < trees.size(); ++index) {
        std::vector<TreeCatalogEntry> items;
        // 逐个遍历所有根节点（多个支持库可能是并列的根）。
        HTREEITEM root = reinterpret_cast<HTREEITEM>(
            SendMessageW(trees[index], TVM_GETNEXTITEM, TVGN_ROOT, 0));
        while (root) {
            WalkTreeItems(trees[index], root, L"", L"", items, static_cast<int>(index), 0, 30000);
            if (static_cast<int>(items.size()) >= 30000) break;
            root = reinterpret_cast<HTREEITEM>(
                SendMessageW(trees[index], TVM_GETNEXTITEM, TVGN_NEXT, reinterpret_cast<LPARAM>(root)));
        }
        for (auto& item : items) {
            catalog.push_back(std::move(item));
            if (catalog.size() >= 300000) break;
        }
        if (catalog.size() >= 300000) break;
    }
    return catalog;
}

mj::Value ListTrees() {
    std::vector<HWND> trees;
    EnumChildWindows(GetIdeMainWindow(), CollectTreeWindows, reinterpret_cast<LPARAM>(&trees));
    const auto& catalog = TreeCatalog();
    mj::Value array = mj::Value::array();
    for (size_t index = 0; index < trees.size(); ++index) {
        int count = 0;
        mj::Value samples = mj::Value::array();
        std::set<std::string> topLevel;
        for (const auto& entry : catalog) {
            if (entry.treeIndex != static_cast<int>(index)) continue;
            ++count;
            if (samples.size() < 15) samples.push(entry.path);
            if (entry.depth == 1) topLevel.insert(entry.name);
        }
        mj::Value libraries = mj::Value::array();
        for (const auto& name : topLevel) libraries.push(name);
        mj::Value item = mj::Value::object();
        item["index"] = static_cast<int>(index);
        item["handle"] = static_cast<long long>(reinterpret_cast<intptr_t>(trees[index]));
        item["count"] = count;
        item["topLevel"] = std::move(libraries);
        item["samples"] = std::move(samples);
        array.push(std::move(item));
    }
    mj::Value result = mj::Value::object();
    result["treeCount"] = static_cast<int>(trees.size());
    result["trees"] = std::move(array);
    return result;
}

mj::Value SearchCommands(const mj::Value& params) {
    const std::string keyword = params.contains("keyword") ? params.at("keyword").asString() : std::string();
    const std::string needle = ToAsciiLower(keyword);
    const int limit = std::clamp(IntOr(params, "limit", 50), 1, 500);
    const bool includeExplain = BoolOr(params, "searchExplain", false);
    const bool includeTree = BoolOr(params, "includeTree", true);
    const int treeIndex = IntOr(params, "treeIndex", -1);

    mj::Value array = mj::Value::array();
    int total = 0;
    std::set<std::string> seen;

    for (const auto& command : CommandCatalog()) {
        std::string haystack = command.name + " " + command.egName;
        if (includeExplain) haystack += " " + command.explain;
        if (!needle.empty() && ToAsciiLower(haystack).find(needle) == std::string::npos) continue;
        ++total;
        seen.insert(command.name);
        if (static_cast<int>(array.size()) >= limit) continue;
        mj::Value item = mj::Value::object();
        item["name"] = command.name;
        item["library"] = command.library;
        item["source"] = "library";
        item["explain"] = command.explain;
        mj::Value args = mj::Value::array();
        for (const auto& argument : command.args) {
            mj::Value a = mj::Value::object();
            a["name"] = argument.name;
            a["type"] = argument.type;
            args.push(std::move(a));
        }
        item["args"] = std::move(args);
        array.push(std::move(item));
    }

    if (includeTree) {
        for (const auto& entry : TreeCatalog()) {
            if (treeIndex >= 0 && entry.treeIndex != treeIndex) continue;
            if (entry.name.empty()) continue;
            if (!needle.empty() &&
                ToAsciiLower(entry.name + " " + entry.path).find(needle) == std::string::npos) continue;
            if (seen.find(entry.name) != seen.end()) continue;
            ++total;
            seen.insert(entry.name);
            if (static_cast<int>(array.size()) >= limit) continue;
            mj::Value item = mj::Value::object();
            item["name"] = entry.name;
            item["library"] = entry.library;
            item["source"] = "tree";
            item["path"] = entry.path;
            item["args"] = mj::Value::array();
            array.push(std::move(item));
        }
    }

    mj::Value result = mj::Value::object();
    result["keyword"] = keyword;
    result["totalMatches"] = total;
    result["returned"] = static_cast<int>(array.size());
    result["commands"] = std::move(array);
    return result;
}

// ---------------------------------------------------------------------------
// 从 .ec 易模块文件里“抽字符串”：易模块是私有二进制格式，但命令名/类型名
// 多以 GBK 明文存储，抽取出来通常能拿到命令列表（属于半逆向，不保证完整）。
// ---------------------------------------------------------------------------
bool IsAsciiPrintable(unsigned char b) { return b >= 0x20 && b <= 0x7e; }
bool IsGbkLead(unsigned char b) { return b >= 0xa1 && b <= 0xf7; }
bool IsGbkTrail(unsigned char b) { return b >= 0xa1 && b <= 0xfe; }

// 只允许“像标识符”的字符：CJK 汉字 + ASCII 字母/数字/下划线。
bool IsIdentifierWide(const std::wstring& value) {
    if (value.size() < 2) return false;
    for (wchar_t c : value) {
        if (c < 0x80) {
            const bool ok = (c >= L'0' && c <= L'9') || (c >= L'A' && c <= L'Z') ||
                            (c >= L'a' && c <= L'z') || c == L'_';
            if (!ok) return false;
        } else if (!(c >= 0x4e00 && c <= 0x9fff)) {
            return false;
        }
    }
    return true;
}

unsigned int ReadU32(const std::string& data, size_t offset) {
    return static_cast<unsigned int>(static_cast<unsigned char>(data[offset])) |
           (static_cast<unsigned int>(static_cast<unsigned char>(data[offset + 1])) << 8) |
           (static_cast<unsigned int>(static_cast<unsigned char>(data[offset + 2])) << 16) |
           (static_cast<unsigned int>(static_cast<unsigned char>(data[offset + 3])) << 24);
}

bool IsValidGbkText(const std::string& text) {
    size_t j = 0;
    while (j < text.size()) {
        const unsigned char b = static_cast<unsigned char>(text[j]);
        if (IsAsciiPrintable(b)) { ++j; }
        else if (IsGbkLead(b) && j + 1 < text.size() && IsGbkTrail(static_cast<unsigned char>(text[j + 1]))) { j += 2; }
        else return false;
    }
    return true;
}

std::string SdtTypeName(unsigned int value) {
    switch (value) {
        case 0x80000101u: return "字节型";
        case 0x80000201u: return "短整数型";
        case 0x80000301u: return "整数型";
        case 0x80000401u: return "长整数型";
        case 0x80000501u: return "小数型";
        case 0x80000601u: return "双精度小数型";
        case 0x80000002u: return "逻辑型";
        case 0x80000003u: return "日期时间型";
        case 0x80000004u: return "文本型";
        case 0x80000005u: return "字节集";
        case 0x80000006u: return "子程序指针";
        case 0x80000008u: return "语句";
        default: return std::string();
    }
}

mj::Value ReadEcomStrings(const mj::Value& params) {
    const std::string path = params.at("path").asString();
    const int minChars = std::clamp(IntOr(params, "minChars", 2), 1, 100);
    const int maxStrings = std::clamp(IntOr(params, "maxStrings", 5000), 1, 50000);
    const std::string mode = params.contains("mode") ? params.at("mode").asString() : std::string("anchored");
    std::ifstream input(std::filesystem::path(Utf8ToWide(path)), std::ios::binary);
    if (!input) throw std::runtime_error("cannot open .ec file: " + path);
    std::string data((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    if (data.empty()) throw std::runtime_error("empty .ec file: " + path);
    if (data.size() > 64ull * 1024 * 1024) throw std::runtime_error("ec file too large (>64MB)");

    std::vector<std::string> found;
    std::vector<size_t> offsets;
    std::vector<std::string> kinds;
    std::vector<std::string> types;
    std::set<std::string> seen;
    if (mode == "blind") {
        std::string current;
        int charCount = 0;
        size_t runStart = 0;
        const auto flush = [&]() {
            if (charCount >= minChars && !current.empty() && seen.insert("S:" + current).second) {
                offsets.push_back(runStart);
                found.push_back(current);
                kinds.push_back("text");
                types.push_back(std::string());
            }
            current.clear();
            charCount = 0;
        };
        size_t i = 0;
        while (i < data.size() && static_cast<int>(found.size()) < maxStrings) {
            const unsigned char b = static_cast<unsigned char>(data[i]);
            if (IsAsciiPrintable(b) || (IsGbkLead(b) && i + 1 < data.size() && IsGbkTrail(static_cast<unsigned char>(data[i + 1])))) {
                if (current.empty()) runStart = i;
                if (IsAsciiPrintable(b)) { current.push_back(static_cast<char>(b)); ++i; }
                else { current.push_back(data[i]); current.push_back(data[i + 1]); i += 2; }
                ++charCount;
            } else { flush(); ++i; }
        }
        flush();
    } else {
        // .ec 结构：
        //   普通字符串 = [4 字节小端长度][GBK 字节]
        //   参数记录   = [4 字节长度][4 字节类型][3 字节][名字(长度-9)][2 字节]
        size_t i = 0;
        while (i + 4 <= data.size() && static_cast<int>(found.size()) < maxStrings) {
            const unsigned int length = ReadU32(data, i);
            if (length >= 11 && length <= 8192 && i + 4 + length <= data.size()) {
                const unsigned int typeValue = ReadU32(data, i + 4);
                const int nameLength = static_cast<int>(length) - 9;
                const std::string typeName = SdtTypeName(typeValue);
                if (nameLength >= 2 && !typeName.empty()) {
                    const std::string nameBytes = data.substr(i + 11, static_cast<size_t>(nameLength));
                    if (IsValidGbkText(nameBytes)) {
                        if (seen.insert("P:" + nameBytes).second) {
                            offsets.push_back(i + 11);
                            found.push_back(nameBytes);
                            kinds.push_back("param");
                            types.push_back(AnsiToUtf8(typeName));
                        }
                        i += 4 + length;
                        continue;
                    }
                }
            }
            if (length >= 2 && length <= 8192 && i + 4 + length <= data.size()) {
                const std::string text = data.substr(i + 4, length);
                if (IsValidGbkText(text)) {
                    std::string returnType;
                    bool isCommand = false;
                    if (i >= 4) {
                        returnType = SdtTypeName(ReadU32(data, i - 4));
                        isCommand = !returnType.empty();
                    }
                    if (seen.insert("S:" + text).second) {
                        offsets.push_back(i + 4);
                        found.push_back(text);
                        kinds.push_back(isCommand ? "command" : "text");
                        types.push_back(isCommand ? AnsiToUtf8(returnType) : std::string());
                    }
                    i += 4 + length;
                    continue;
                }
            }
            ++i;
        }
    }

    mj::Value identifiers = mj::Value::array();
    mj::Value raw = mj::Value::array();
    mj::Value records = mj::Value::array();
    for (size_t index = 0; index < found.size(); ++index) {
        const std::string text = AnsiToUtf8(found[index]);
        raw.push(text);
        if (IsIdentifierWide(AnsiToWide(found[index]))) identifiers.push(text);
        mj::Value item = mj::Value::object();
        item["offset"] = static_cast<long long>(index < offsets.size() ? offsets[index] : 0);
        item["kind"] = index < kinds.size() ? kinds[index] : std::string("text");
        item["text"] = text;
        if (index < types.size() && !types[index].empty()) item["type"] = types[index];
        records.push(std::move(item));
    }
    mj::Value result = mj::Value::object();
    result["path"] = path;
    result["mode"] = mode;
    result["fileSize"] = static_cast<long long>(data.size());
    result["count"] = static_cast<int>(found.size());
    result["identifierCount"] = static_cast<int>(identifiers.size());
    result["identifiers"] = std::move(identifiers);
    result["strings"] = std::move(raw);
    result["records"] = std::move(records);
    return result;
}

// 十六进制查看 .ec 指定位置（指定 needle 则定位到它附近），用于看清字符串表结构。
mj::Value InspectEcom(const mj::Value& params) {
    const std::string path = params.at("path").asString();
    const std::string needle = params.contains("needle") ? params.at("needle").asString() : std::string();
    const int context = std::clamp(IntOr(params, "context", 256), 16, 16384);
    std::ifstream input(std::filesystem::path(Utf8ToWide(path)), std::ios::binary);
    if (!input) throw std::runtime_error("cannot open .ec file: " + path);
    std::string data((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    const std::string gbkNeedle = Utf8ToAnsi(needle);
    size_t offset = 0;
    mj::Value result = mj::Value::object();
    if (!gbkNeedle.empty()) {
        const size_t foundAt = data.find(gbkNeedle);
        if (foundAt == std::string::npos) {
            result["found"] = false;
            return result;
        }
        offset = foundAt;
        result["found"] = true;
        result["offset"] = static_cast<long long>(offset);
    }
    const size_t start = offset > static_cast<size_t>(context) ? offset - static_cast<size_t>(context) : 0;
    const size_t end = std::min(data.size(), offset + gbkNeedle.size() + static_cast<size_t>(context));
    mj::Value lines = mj::Value::array();
    char buffer[64];
    for (size_t base = start; base < end; base += 16) {
        std::snprintf(buffer, sizeof(buffer), "%08llX  ", static_cast<unsigned long long>(base));
        std::string line = buffer;
        std::string ascii;
        for (size_t i = 0; i < 16; ++i) {
            if (base + i < end) {
                const unsigned char b = static_cast<unsigned char>(data[base + i]);
                std::snprintf(buffer, sizeof(buffer), "%02X ", b);
                line += buffer;
                ascii.push_back((b >= 0x20 && b < 0x7f) ? static_cast<char>(b) : '.');
            } else {
                line += "   ";
            }
            if (i == 7) line += ' ';
        }
        line += " |";
        line += ascii;
        line += '|';
        lines.push(std::move(line));
    }
    result["start"] = static_cast<long long>(start);
    result["end"] = static_cast<long long>(end);
    result["dump"] = std::move(lines);
    return result;
}

// 搜索 .ec 易模块的命令/参数（默认当前工程加载的所有 .ec）。
mj::Value SearchEcomCommands(const mj::Value& params) {
    const std::string keyword = params.contains("keyword") ? params.at("keyword").asString() : std::string();
    const std::string needle = ToAsciiLower(keyword);
    const int limit = std::clamp(IntOr(params, "limit", 100), 1, 1000);
    const std::string explicitPath = params.contains("path") ? params.at("path").asString() : std::string();

    std::vector<std::string> paths;
    if (!explicitPath.empty()) {
        paths.push_back(explicitPath);
    } else {
        int count = 0;
        RunIdeFunction(FN_GET_NUM_ECOM, reinterpret_cast<DWORD>(&count), 0);
        for (int index = 0; index < count && index < 64; ++index) {
            std::vector<char> buffer(1024, '\0');
            RunIdeFunction(FN_GET_ECOM_FILE_NAME, static_cast<DWORD>(index), reinterpret_cast<DWORD>(buffer.data()));
            if (buffer[0]) paths.push_back(AnsiToUtf8(std::string(buffer.data())));
        }
    }

    mj::Value commands = mj::Value::array();
    int totalMatches = 0;
    int modules = 0;
    for (const auto& path : paths) {
        mj::Value request = mj::Value::object();
        request["path"] = path;
        request["minChars"] = 2;
        request["maxStrings"] = 20000;
        mj::Value parsed;
        try {
            parsed = ReadEcomStrings(request);
        } catch (...) {
            continue;
        }
        ++modules;

        // 把扁平记录按文件顺序归组成“命令 + 其参数”。
        std::vector<std::string> names;
        std::vector<std::string> returnTypes;
        std::vector<std::vector<std::pair<std::string, std::string>>> paramLists;
        for (const auto& record : parsed.at("records").items()) {
            const std::string kind = record.contains("kind") ? record.at("kind").asString() : std::string("text");
            const std::string text = record.at("text").asString();
            if (kind == "command") {
                names.push_back(text);
                returnTypes.push_back(record.contains("type") ? record.at("type").asString() : std::string());
                paramLists.push_back({});
            } else if (kind == "param" && !names.empty()) {
                paramLists.back().push_back(
                    {text, record.contains("type") ? record.at("type").asString() : std::string()});
            }
        }

        for (size_t index = 0; index < names.size(); ++index) {
            bool matched = needle.empty() || ToAsciiLower(names[index]).find(needle) != std::string::npos;
            if (!matched) {
                for (const auto& argument : paramLists[index]) {
                    if (ToAsciiLower(argument.first).find(needle) != std::string::npos) { matched = true; break; }
                }
            }
            if (!matched) continue;
            ++totalMatches;
            if (static_cast<int>(commands.size()) >= limit) continue;

            std::string signature = names[index] + " (";
            mj::Value paramArray = mj::Value::array();
            for (size_t p = 0; p < paramLists[index].size(); ++p) {
                if (p) signature += ", ";
                signature += paramLists[index][p].first;
                mj::Value item = mj::Value::object();
                item["name"] = paramLists[index][p].first;
                item["type"] = paramLists[index][p].second;
                paramArray.push(std::move(item));
            }
            signature += ")";

            mj::Value command = mj::Value::object();
            command["module"] = path;
            command["name"] = names[index];
            if (!returnTypes[index].empty()) command["returnType"] = returnTypes[index];
            command["signature"] = signature;
            command["params"] = std::move(paramArray);
            commands.push(std::move(command));
        }
    }

    mj::Value result = mj::Value::object();
    result["moduleCount"] = modules;
    result["keyword"] = keyword;
    result["totalMatches"] = totalMatches;
    result["returned"] = static_cast<int>(commands.size());
    result["commands"] = std::move(commands);
    return result;
}

mj::Value CodeResultJson(const std::vector<ProgramCell>& cells, int maxRows, bool includeEmpty) {
    int kept = 0;
    for (const auto& cell : cells) if (cell.row < maxRows) ++kept;
    const auto caret = CurrentCaret();
    mj::Value result = mj::Value::object();
    result["revision"] = RevisionForCells(cells);
    result["cells"] = CellsToJson(cells, maxRows, includeEmpty);
    mj::Value caretJson = mj::Value::object();
    caretJson["row"] = caret.first;
    caretJson["column"] = caret.second;
    result["caret"] = std::move(caretJson);
    result["complete"] = kept == static_cast<int>(cells.size());
    int windowType = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&windowType), 0);
    result["activeWindowType"] = windowType;
    return result;
}

mj::Value ReadCurrentCode(int maxRows, bool includeEmpty) {
    return CodeResultJson(ReadCurrentCells(kMaxCodeRows), maxRows, includeEmpty);
}

mj::Value ReadCodeRange(int startRow, int rowCount, int maxRows, bool includeEmpty) {
    const auto all = ReadCurrentCells(kMaxCodeRows);
    const int endRow = std::min(maxRows, startRow + rowCount);
    mj::Value selected = mj::Value::array();
    for (const auto& cell : all) {
        if (cell.row < startRow || cell.row >= endRow) continue;
        if (!includeEmpty && cell.text.empty()) continue;
        selected.push(CellToJson(cell));
    }
    const auto caret = CurrentCaret();
    mj::Value result = mj::Value::object();
    result["revision"] = RevisionForCells(all);
    result["cells"] = std::move(selected);
    result["startRow"] = startRow;
    result["rowCount"] = rowCount;
    mj::Value caretJson = mj::Value::object();
    caretJson["row"] = caret.first;
    caretJson["column"] = caret.second;
    result["caret"] = std::move(caretJson);
    result["complete"] = true;
    return result;
}

mj::Value ApplyCurrent(const mj::Value& params) {
    const auto initial = ReadAndVerifyRevision(params);
    const std::string initialRevision = RevisionForCells(initial);
    const bool compileEach = BoolOr(params, "compileEach", false);
    const auto& edits = params.at("edits");
    int mutations = 0;
    try {
        for (const auto& edit : edits.items()) {
            const int row = edit.at("row").asInt();
            const int column = edit.at("column").asInt();
            if (edit.contains("expectedKind")) VerifyCellKind(row, column, edit.at("expectedKind").asString());
            SetProgramCellText(row, column, edit.at("text").asString(), compileEach);
            ++mutations;
        }
    } catch (const std::exception& error) {
        RollBackToRevision(initialRevision, mutations);
        throw std::runtime_error(std::string("code edit rejected and rolled back: ") + error.what());
    }
    for (const auto& edit : edits.items()) {
        ProgramCell applied;
        if (!ReadProgramCell(edit.at("row").asInt(), edit.at("column").asInt(), &applied) ||
            applied.text != edit.at("text").asString()) {
            RollBackToRevision(initialRevision, mutations);
            throw std::runtime_error("code edit produced mismatched cells and was rolled back");
        }
    }
    const auto after = ReadCurrentCells(kMaxCodeRows);
    const auto caret = CurrentCaret();
    mj::Value result = mj::Value::object();
    result["revision"] = RevisionForCells(after);
    result["cellCount"] = static_cast<int>(after.size());
    mj::Value caretJson = mj::Value::object();
    caretJson["row"] = caret.first;
    caretJson["column"] = caret.second;
    result["caret"] = std::move(caretJson);
    return result;
}

mj::Value BatchCurrent(const mj::Value& params) {
    const auto initial = ReadAndVerifyRevision(params);
    const std::string initialRevision = RevisionForCells(initial);
    int mutations = 0;
    std::vector<std::pair<int, int>> expectedPositions;
    std::vector<std::string> expectedTexts;
    try {
        for (const auto& operation : params.at("operations").items()) {
            const std::string action = operation.at("action").asString();
            if (action == "edit") {
                const int row = operation.at("row").asInt();
                const int column = operation.at("column").asInt();
                if (operation.contains("expectedKind")) VerifyCellKind(row, column, operation.at("expectedKind").asString());
                SetProgramCellText(row, column, operation.at("text").asString(), false);
                ++mutations;
                expectedPositions.push_back({row, column});
                expectedTexts.push_back(operation.at("text").asString());
            } else if (action == "insert") {
                const std::string kind = operation.at("kind").asString();
                if (!RunIdeFunction(InsertFunctionForKind(kind))) throw std::runtime_error("the IDE rejected a structural insertion");
                ++mutations;
                PumpIdeMessages();
                const auto base = CurrentCaret();
                VerifyCellKind(base.first, base.second, kind);
                for (const auto& edit : Optional(operation, "edits").items()) {
                    const int row = base.first + IntOr(edit, "rowOffset", 0);
                    const int column = edit.contains("column") ? edit.at("column").asInt() : base.second;
                    SetProgramCellText(row, column, edit.at("text").asString(), false);
                    ++mutations;
                    expectedPositions.push_back({row, column});
                    expectedTexts.push_back(edit.at("text").asString());
                }
            } else {
                throw std::runtime_error("unsupported batch action: " + action);
            }
        }
    } catch (const std::exception& error) {
        RollBackToRevision(initialRevision, mutations);
        throw std::runtime_error(std::string("code batch rejected and rolled back: ") + error.what());
    }
    for (size_t index = 0; index < expectedPositions.size(); ++index) {
        ProgramCell applied;
        if (!ReadProgramCell(expectedPositions[index].first, expectedPositions[index].second, &applied) ||
            applied.text != expectedTexts[index]) {
            RollBackToRevision(initialRevision, mutations);
            throw std::runtime_error("code batch produced shifted cells and was rolled back");
        }
    }
    const auto after = ReadCurrentCells(kMaxCodeRows);
    mj::Value result = mj::Value::object();
    result["revision"] = RevisionForCells(after);
    result["cellCount"] = static_cast<int>(after.size());
    return result;
}

mj::Value MoveCode(const mj::Value& params) {
    const std::string direction = params.at("direction").asString();
    bool moved = false;
    if (direction == "row") {
        const int row = params.at("row").asInt();
        const int column = IntOr(params, "column", 0);
        moved = MoveCaretToCell(row, column);
    } else if (direction == "top") moved = RunIdeFunction(FN_MOVE_TOP) != FALSE;
    else if (direction == "bottom") moved = RunIdeFunction(FN_MOVE_BOTTOM) != FALSE;
    else if (direction == "up") moved = RunIdeFunction(FN_MOVE_UP) != FALSE;
    else if (direction == "down") moved = RunIdeFunction(FN_MOVE_DOWN) != FALSE;
    else if (direction == "previousUnit") moved = RunIdeFunction(FN_MOVE_PREV_UNIT) != FALSE;
    else if (direction == "nextUnit") moved = RunIdeFunction(FN_MOVE_NEXT_UNIT) != FALSE;
    else throw std::runtime_error("unsupported code movement: " + direction);
    PumpIdeMessages();
    const auto caret = CurrentCaret();
    mj::Value result = mj::Value::object();
    result["moved"] = moved;
    mj::Value caretJson = mj::Value::object();
    caretJson["row"] = caret.first;
    caretJson["column"] = caret.second;
    result["caret"] = std::move(caretJson);
    return result;
}

// 在 DLL 命令表里确保一组 DLL 命令存在（不存在则插入并填充字段与参数）。
mj::Value SyncDllCommands(const mj::Value& params) {
    const auto& commands = params.at("commands");
    if (!RunIdeFunction(FN_VIEW_DLLCMD_TAB)) throw std::runtime_error("无法打开 DLL 命令表");
    PumpIdeMessages();

    mj::Value results = mj::Value::array();
    for (const auto& command : commands.items()) {
        const std::string name = command.at("name").asString();
        const std::string returnType = command.contains("returnType") ? command.at("returnType").asString() : std::string();
        const std::string library = command.contains("library") ? command.at("library").asString() : std::string();
        const std::string entry = command.contains("entryPoint") ? command.at("entryPoint").asString() : std::string();
        std::vector<std::pair<std::string, std::string>> args;
        if (command.contains("args")) {
            for (const auto& argument : command.at("args").items()) {
                args.push_back({argument.at("name").asString(), argument.at("type").asString()});
            }
        }

        auto cells = ReadCurrentCells(kMaxCodeRows);
        bool exists = false;
        for (const auto& cell : cells) {
            if (cell.type == VT_DLL_CMD_NAME && !cell.title && cell.text == name) { exists = true; break; }
        }
        if (exists) {
            mj::Value item = mj::Value::object();
            item["name"] = name;
            item["action"] = "exists";
            results.push(std::move(item));
            continue;
        }
        // 兜底：若已存在一条“入口名相同、但名称格是空的”命令（首次写名失败留下的），
        // 直接把名字补上，避免插出重名 DLL 命令（重名会导致编译报错）。
        if (!entry.empty()) {
            int nameRow = -1;
            for (const auto& cell : cells) {
                if (cell.type != VT_DLL_CMD_IN_LIB_NAME || cell.title || cell.text != entry) continue;
                // 名称格就在入口格的上面几行内，逐行探测（它在读取里可能完全不可见）。
                for (int offset = 1; offset <= 8 && nameRow < 0; ++offset) {
                    const int probeRow = cell.row - offset;
                    if (probeRow < 0) break;
                    ProgramCell probe;
                    if (!ReadProgramCell(probeRow, 0, &probe)) continue;
                    if (probe.title) continue;
                    if (probe.type != VT_DLL_CMD_NAME && probe.type != 0) continue;
                    if (!probe.text.empty()) continue;
                    SetProgramCellText(probeRow, 0, name, false);
                    nameRow = probeRow;
                }
                if (nameRow >= 0) break;
            }
            if (nameRow >= 0) {
                mj::Value item = mj::Value::object();
                item["name"] = name;
                item["action"] = "repaired";
                item["row"] = nameRow;
                results.push(std::move(item));
                continue;
            }
        }

        std::set<int> beforeRows;
        for (const auto& cell : cells) {
            if (cell.type == VT_DLL_CMD_NAME && !cell.title) beforeRows.insert(cell.row);
        }

        if (!RunIdeFunction(FN_INSERT_NEW_DLL_CMD)) throw std::runtime_error("插入 DLL 命令失败: " + name);
        PumpIdeMessages();

        cells = ReadCurrentCells(kMaxCodeRows);
        int nameRow = -1;
        for (const auto& cell : cells) {
            if (cell.type == VT_DLL_CMD_NAME && !cell.title && beforeRows.find(cell.row) == beforeRows.end()) {
                nameRow = cell.row;
                break;
            }
        }
        if (nameRow < 0) throw std::runtime_error("插入后找不到新 DLL 命令行: " + name);

        SetProgramCellText(nameRow, 0, name, false);
        if (!returnType.empty()) {
            for (const auto& cell : cells) {
                if (cell.row == nameRow && !cell.title && cell.type == VT_DLL_CMD_RET_TYPE) {
                    SetProgramCellText(cell.row, cell.column, returnType, false);
                    break;
                }
            }
        }
        if (!library.empty()) {
            for (const auto& cell : cells) {
                if (cell.row > nameRow && !cell.title && cell.type == VT_DLL_LIB_FILE_NAME) {
                    SetProgramCellText(cell.row, cell.column, library, false);
                    break;
                }
            }
        }
        if (!entry.empty()) {
            for (const auto& cell : cells) {
                if (cell.row > nameRow && !cell.title && cell.type == VT_DLL_CMD_IN_LIB_NAME) {
                    SetProgramCellText(cell.row, cell.column, entry, false);
                    break;
                }
            }
        }

        for (size_t index = 0; index < args.size(); ++index) {
            auto current = ReadCurrentCells(kMaxCodeRows);
            int argRow = -1;
            int argCol = 0;
            std::vector<ProgramCell> existingArgs;
            for (const auto& cell : current) {
                if (cell.type == VT_DLL_CMD_ARG_NAME && !cell.title && cell.row > nameRow) {
                    existingArgs.push_back(cell);
                    if (cell.text.empty() && argRow < 0) { argRow = cell.row; argCol = cell.column; }
                }
            }
            if (argRow < 0) {
                if (existingArgs.empty()) {
                    int titleRow = -1;
                    for (const auto& cell : current) {
                        if (cell.type == VT_DLL_CMD_ARG_NAME && cell.title && cell.row > nameRow) { titleRow = cell.row; break; }
                    }
                    if (titleRow < 0) throw std::runtime_error("找不到参数标题行: " + name);
                    MoveCaretToCell(titleRow, 0);
                    bool inserted = RunIdeFunction(FN_INSERT_NEW);
                    if (!inserted) inserted = RunIdeFunction(FN_INSERT_NEW_AT_NEXT);
                    if (!inserted) throw std::runtime_error("插入参数失败: " + name);
                } else {
                    const ProgramCell& last = existingArgs.back();
                    MoveCaretToCell(last.row, last.column);
                    if (!RunIdeFunction(FN_INSERT_NEW_AT_NEXT)) throw std::runtime_error("插入参数失败: " + name);
                }
                PumpIdeMessages();
                auto after = ReadCurrentCells(kMaxCodeRows);
                for (const auto& cell : after) {
                    if (cell.type == VT_DLL_CMD_ARG_NAME && !cell.title && cell.row > nameRow && cell.text.empty()) {
                        argRow = cell.row;
                        argCol = cell.column;
                        break;
                    }
                }
                if (argRow < 0) throw std::runtime_error("插入参数后找不到空白参数格: " + name);
            }
            SetProgramCellText(argRow, argCol, args[index].first, false);
            if (!args[index].second.empty()) {
                auto afterSet = ReadCurrentCells(kMaxCodeRows);
                for (const auto& cell : afterSet) {
                    if (cell.row == argRow && !cell.title && cell.type == VT_DLL_CMD_ARG_TYPE) {
                        SetProgramCellText(cell.row, cell.column, args[index].second, false);
                        break;
                    }
                }
            }
        }

        mj::Value item = mj::Value::object();
        item["name"] = name;
        item["action"] = "created";
        item["row"] = nameRow;
        results.push(std::move(item));
    }

    mj::Value result = mj::Value::object();
    result["results"] = std::move(results);
    return result;
}

// 诊断：窗口类型、光标移动、各插入功能是否可用、实际试插一次的结果。
mj::Value DiagnoseCaret() {
    mj::Value result = mj::Value::object();
    int windowType = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&windowType), 0);
    result["activeWindow"] = windowType;
    result["caretEntry"] = CurrentCaret().first;

    auto maxRowOf = []() {
        int maxRow = -1;
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) maxRow = std::max(maxRow, cell.row);
        return maxRow;
    };
    result["maxRow"] = maxRowOf();

    // 1. IDE 认为哪些功能当前可用？
    struct Entry { const char* name; DWORD function; };
    const Entry entries[] = {
        {"insertNew", FN_INSERT_NEW},
        {"insertNewAtNext", FN_INSERT_NEW_AT_NEXT},
        {"insertNewMod", FN_INSERT_NEW_MOD},
        {"insertNewSub", FN_INSERT_NEW_SUB},
        {"insertNewArg", FN_INSERT_NEW_ARG},
        {"extendAllSub", FN_EXTEND_ALL_SUB},
        {"moveCaret", FN_MOVE_CARET},
        {"insertText", FN_INSERT_TEXT},
        {"insertNewDllCmd", FN_INSERT_NEW_DLL_CMD},
    };
    mj::Value enabled = mj::Value::object();
    for (const auto& entry : entries) {
        BOOL available = FALSE;
        const BOOL handled = RunIdeFunction(FN_IS_FUNC_ENABLED, entry.function, reinterpret_cast<DWORD>(&available));
        enabled[entry.name] = (handled && available) ? 1 : 0;
    }
    result["enabled"] = std::move(enabled);

    // 2. 真试一次 FN_INSERT_NEW，看光标与行数变化。
    {
        const int lastRow = maxRowOf();
        MoveCaretToCell(lastRow, 0);
        const int caretBefore = CurrentCaret().first;
        const BOOL inserted = RunIdeFunction(FN_INSERT_NEW);
        PumpIdeMessages();
        const int caretAfter = CurrentCaret().first;
        ProgramCell probe;
        const bool read = ReadProgramCell(caretAfter, 0, &probe);
        mj::Value attempt = mj::Value::object();
        attempt["caretBefore"] = caretBefore;
        attempt["caretAfter"] = caretAfter;
        attempt["returned"] = inserted ? 1 : 0;
        attempt["maxRowAfter"] = maxRowOf();
        attempt["cellType"] = read ? probe.type : -1;
        attempt["cellTitle"] = (read && probe.title) ? 1 : 0;
        attempt["cellText"] = read ? probe.text : std::string();
        result["tryInsertNew"] = std::move(attempt);
    }

    // 3. 再试 FN_INSERT_TEXT（在末尾写一个 ASCII 标记）
    {
        const int lastRow = maxRowOf();
        MoveCaretToCell(lastRow, 0);
        const BOOL inserted = RunIdeFunction(FN_INSERT_TEXT,
            reinterpret_cast<DWORD>(const_cast<char*>("EUITEST")), 0);
        PumpIdeMessages();
        mj::Value attempt = mj::Value::object();
        attempt["returned"] = inserted ? 1 : 0;
        attempt["caretAfter"] = CurrentCaret().first;
        attempt["maxRowAfter"] = maxRowOf();
        result["tryInsertText"] = std::move(attempt);
    }
    return result;
}

// 确保当前活动窗口是「程序集(代码)」。DLL 命令表/数据类型表等会让代码表操作全部失效，
// 而官方没有“切到程序集”的功能号，只能靠 FN_MOVE_NEXT_UNIT / FN_MOVE_PREV_UNIT 逐个单元找。
bool EnsureCodeView() {
    int windowType = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&windowType), 0);
    if (windowType == 1) return true;
    for (int attempt = 0; attempt < 16; ++attempt) {
        int current = 0;
        RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&current), 0);
        if (current == 1) return true;
        if (!RunIdeFunction(FN_MOVE_NEXT_UNIT)) break;
        PumpIdeMessages();
    }
    for (int attempt = 0; attempt < 16; ++attempt) {
        int current = 0;
        RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&current), 0);
        if (current == 1) return true;
        if (!RunIdeFunction(FN_MOVE_PREV_UNIT)) break;
        PumpIdeMessages();
    }
    int finalType = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&finalType), 0);
    return finalType == 1;
}

// 切到「程序集」代码视图，并返回切换后的窗口类型（供脚本/工具恢复视图用）。
mj::Value EnsureCodeViewResult() {
    const bool ok = EnsureCodeView();
    int windowType = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&windowType), 0);
    mj::Value result = mj::Value::object();
    result["ok"] = ok ? 1 : 0;
    result["activeWindowType"] = windowType;
    return result;
}

// 开发调试：直接调用任意 FN_*，返回是否被处理以及调用后的窗口类型。
// （只作为桥接方法提供，不注册成 MCP 工具。）
mj::Value CallIdeFunction(const mj::Value& params) {
    const DWORD function = static_cast<DWORD>(params.at("fn").asInt());
    const DWORD argument1 = static_cast<DWORD>(IntOr(params, "arg1", 0));
    const DWORD argument2 = static_cast<DWORD>(IntOr(params, "arg2", 0));
    const BOOL handled = RunIdeFunction(function, argument1, argument2);
    PumpIdeMessages();
    int windowType = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&windowType), 0);
    mj::Value result = mj::Value::object();
    result["fn"] = static_cast<long long>(function);
    result["handled"] = handled ? 1 : 0;
    result["activeWindowType"] = windowType;
    return result;
}

// 一键写入界面脚手架：模块 __EUI_生成 / EUI_事件 + 子程序 + 语句 + 参数 + DLL 声明。
mj::Value SyncUiScaffold(const mj::Value& params) {
    const std::string documentName = params.at("documentName").asString();

    // 把 IDE 拉到前台（部分编辑功能需要焦点）。
    if (g_notify) {
        HWND mainWindow = reinterpret_cast<HWND>(g_notify(NES_GET_MAIN_HWND, 0, 0));
        if (mainWindow) { SetForegroundWindow(mainWindow); PumpIdeMessages(); }
    }

    // 关键：DLL 命令表等其它表会让代码表操作全部失效，先切回「程序集」。
    EnsureCodeView();

    int activeWindow = 0;
    RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&activeWindow), 0);

    auto findRow = [](int type, const std::string& text) -> int {
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
            if (cell.type == type && !cell.title && cell.text == text) return cell.row;
        }
        return -1;
    };
    // 直接移动光标并写入（不做会移动光标的“全表读取”，以免打断刚插入的新单元）。
    auto setAt = [](int row, int column, const std::string& text) {
        const std::string ansi = Utf8ToAnsi(text);
        if (!RunIdeFunction(FN_MOVE_CARET, static_cast<DWORD>(row), static_cast<DWORD>(column))) {
            throw std::runtime_error("无法移动光标到目标单元格");
        }
        PumpIdeMessages(0);
        if (!RunIdeFunction(FN_SET_AND_COMPILE_PRG_ITEM_TEXT,
                            reinterpret_cast<DWORD>(const_cast<char*>(ansi.c_str())), FALSE)) {
            throw std::runtime_error("IDE 拒绝写入单元格");
        }
        PumpIdeMessages();
    };
    auto maxRowNow = []() -> int {
        int maxRow = -1;
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) maxRow = std::max(maxRow, cell.row);
        return maxRow;
    };
    // 插入新单元后，光标应落在新单元上、且表格行数增加；满足才写入。
    auto writeAtCaret = [&setAt, &maxRowNow, &activeWindow](int expectedType, const std::string& text, int beforeMaxRow) -> int {
        const auto caret = CurrentCaret();
        ProgramCell cell;
        const bool readable = caret.first >= 0 && ReadProgramCell(caret.first, 0, &cell);
        const int afterMaxRow = maxRowNow();
        const bool typeOk = readable && cell.type == expectedType && !cell.title;
        const bool grew = afterMaxRow > beforeMaxRow;
        if (!typeOk || !grew) {
            std::ostringstream message;
            message << "插入未成功 (活动窗口=" << activeWindow
                    << ", 期望类型=" << expectedType << ", 光标行=" << caret.first
                    << ", 实际类型=" << (readable ? cell.type : -1)
                    << ", 是标题=" << (readable && cell.title ? 1 : 0)
                    << ", 实际文本=[" << (readable ? Utf8ToAnsi(cell.text) : std::string()) << "]"
                    << ", 插入前行数=" << beforeMaxRow << ", 插入后行数=" << afterMaxRow << ")";
            throw std::runtime_error(message.str());
        }
        setAt(caret.first, 0, text);
        return caret.first;
    };
    // 在给定锚点行依次尝试插入功能。
    // 关键：每次尝试前都重新定位光标（失败的功能会把光标挪走）。
    auto insertTryAnchors = [&](const std::vector<int>& anchors, const std::vector<DWORD>& functions,
                               int expectedType, const std::string& text) -> int {
        std::string lastError = "没有可用的插入功能";
        for (int anchor : anchors) {
            if (anchor < 0) continue;
            for (DWORD function : functions) {
                MoveCaretToCell(anchor, 0);
                const int beforeMaxRow = maxRowNow();
                if (!RunIdeFunction(function)) { lastError = "IDE 拒绝该插入功能"; continue; }
                PumpIdeMessages();
                try {
                    return writeAtCaret(expectedType, text, beforeMaxRow);
                } catch (const std::exception& error) {
                    lastError = error.what();
                }
            }
        }
        throw std::runtime_error(lastError);
    };
    auto endRowOf = [](int startRow) -> int {
        int endRow = kMaxCodeRows;
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
            if (!cell.title && (cell.type == VT_MOD_NAME || cell.type == VT_SUB_NAME) && cell.row > startRow) {
                endRow = std::min(endRow, cell.row);
            }
        }
        return endRow;
    };
    auto rowOfTypeIn = [&](int type, int afterRow, int beforeRow) -> int {
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
            if (cell.type == type && !cell.title && cell.row > afterRow && cell.row < beforeRow) return cell.row;
        }
        return -1;
    };
    auto lastRowIn = [&](int afterRow, int beforeRow) -> int {
        int last = -1;
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
            if (cell.row > afterRow && cell.row < beforeRow) last = std::max(last, cell.row);
        }
        return last;
    };
    // 复用工程里已有的程序集（新建程序集会弹窗/失败，这里不做）。
    auto resolveModule = [&]() -> int {
        const int row = rowOfTypeIn(VT_MOD_NAME, -1, kMaxCodeRows);
        if (row < 0) throw std::runtime_error("当前工程里没有任何程序集，请先在易语言里手动插入一个程序集");
        return row;
    };
    auto ensureSubprogram = [&](int moduleRow, const std::string& name) -> int {
        const int existing = findRow(VT_SUB_NAME, name);
        if (existing >= 0) return existing;
        const int endRow = endRowOf(moduleRow);
        const int anchor = rowOfTypeIn(VT_SUB_NAME, moduleRow, endRow);
        const int anywhere = rowOfTypeIn(VT_SUB_NAME, -1, kMaxCodeRows);
        return insertTryAnchors({anchor, anywhere, moduleRow}, {FN_INSERT_NEW, FN_INSERT_NEW_SUB}, VT_SUB_NAME, name);
    };
    // replacePrefix 非空时：把该子程序里以它开头的旧语句改写成新文本（保证幂等，不会插出第二条）。
    auto ensureStatement = [&](int subRow, const std::string& text, const std::string& replacePrefix) -> int {
        const int endRow = endRowOf(subRow);
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
            if (cell.type != VT_SUB_PRG_ITEM || cell.title) continue;
            if (cell.row <= subRow || cell.row >= endRow) continue;
            if (cell.text == text) return cell.row;
            if (!replacePrefix.empty() && cell.text.rfind(replacePrefix, 0) == 0) {
                setAt(cell.row, cell.column, text);
                return cell.row;
            }
        }
        const int anchor = rowOfTypeIn(VT_SUB_PRG_ITEM, subRow, endRow);
        const int last = lastRowIn(subRow, endRow);
        return insertTryAnchors({anchor, last, subRow}, {FN_INSERT_NEW, FN_INSERT_NEW_AT_NEXT}, VT_SUB_PRG_ITEM, text);
    };
    auto ensureArgument = [&](const std::string& subName, const std::string& name, const std::string& type) -> int {
        // 子程序默认处于收缩状态（看不到参数区），先展开。
        RunIdeFunction(FN_EXTEND_ALL_SUB);
        PumpIdeMessages();
        const int subRow = findRow(VT_SUB_NAME, subName);
        if (subRow < 0) throw std::runtime_error("找不到子程序");
        const int endRow = endRowOf(subRow);
        int row = -1;
        for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
            if (cell.type == VT_SUB_ARG_NAME && !cell.title && cell.row > subRow && cell.row < endRow && cell.text == name) {
                row = cell.row;
                break;
            }
        }
        if (row < 0) {
            int titleRow = -1;
            for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
                if (cell.type == VT_SUB_ARG_NAME && cell.title && cell.row > subRow && cell.row < endRow) {
                    titleRow = cell.row;
                    break;
                }
            }
            const int existingArg = rowOfTypeIn(VT_SUB_ARG_NAME, subRow, endRow);
            row = insertTryAnchors({titleRow, existingArg, subRow}, {FN_INSERT_NEW, FN_INSERT_NEW_ARG}, VT_SUB_ARG_NAME, name);
        }
        if (!type.empty()) {
            for (const auto& cell : ReadCurrentCells(kMaxCodeRows)) {
                if (cell.row == row && cell.type == VT_SUB_ARG_TYPE && !cell.title) {
                    setAt(cell.row, cell.column, type);
                    break;
                }
            }
        }
        return row;
    };

    // 在程序入口子程序里调用 EUI_启动界面 ()：优先 _启动子程序，其次 __启动窗口_创建完毕。
    auto ensureEntryCall = [&](const std::string& callText) -> int {
        const char* candidates[] = { "_启动子程序", "__启动窗口_创建完毕" };
        int subRow = -1;
        for (const char* candidate : candidates) {
            subRow = findRow(VT_SUB_NAME, AnsiToUtf8(candidate));
            if (subRow >= 0) break;
        }
        if (subRow < 0) subRow = rowOfTypeIn(VT_SUB_NAME, -1, kMaxCodeRows);
        if (subRow < 0) return -1;
        return ensureStatement(subRow, callText, std::string());
    };

    const std::string startupName = AnsiToUtf8("EUI_启动界面");
    const std::string callbackName = AnsiToUtf8("EUI_事件回调");
    const std::string statement = AnsiToUtf8(
        std::string("EUI_MCP_RunA (取运行目录 () ＋ “\\") + WideToAnsi(Utf8ToWide(documentName)) + "”, &EUI_事件回调)");

    int targetModule = -1;
    int startupRow = -1;
    int callbackRow = -1;
    int entryRow = -1;
    std::string codeError;
    try {
        targetModule = resolveModule();
        startupRow = ensureSubprogram(targetModule, startupName);
        ensureStatement(startupRow, statement, AnsiToUtf8("EUI_MCP_RunA"));
        entryRow = ensureEntryCall(AnsiToUtf8("EUI_启动界面 ()"));
        callbackRow = ensureSubprogram(targetModule, callbackName);
        // 注意：易语言把新参数插在参数区最上面，所以要按倒序插入，
        // 最终顺序才是 控件编号 / 事件代码 / 事件文本指针（与运行时传参顺序一致）。
        ensureArgument(callbackName, AnsiToUtf8("事件文本指针"), AnsiToUtf8("整数型"));
        ensureArgument(callbackName, AnsiToUtf8("事件代码"), AnsiToUtf8("整数型"));
        ensureArgument(callbackName, AnsiToUtf8("控件编号"), AnsiToUtf8("整数型"));
        // 结构插入会移动行号，最后重新读一次真实位置。
        const int finalStartup = findRow(VT_SUB_NAME, startupName);
        const int finalCallback = findRow(VT_SUB_NAME, callbackName);
        if (finalStartup >= 0) startupRow = finalStartup;
        if (finalCallback >= 0) callbackRow = finalCallback;
    } catch (const std::exception& error) {
        codeError = error.what();
    }

    mj::Value dllParams = mj::Value::object();
    dllParams["commands"] = params.at("commands");
    mj::Value dllResult = SyncDllCommands(dllParams);
    // 恢复「程序集」视图，避免下一次调用从 DLL 命令表开始。
    EnsureCodeView();

    mj::Value result = mj::Value::object();
    result["targetModuleRow"] = targetModule;
    result["startupRow"] = startupRow;
    result["callbackRow"] = callbackRow;
    result["entryRow"] = entryRow;
    result["dll"] = std::move(dllResult);
    if (!codeError.empty()) {
        result["codeError"] = AnsiToUtf8(codeError);
        mj::Value steps = mj::Value::array();
        steps.push(AnsiToUtf8("1) 在程序集里新建子程序 ") + startupName);
        steps.push(AnsiToUtf8("2) 在其中写一行: ") + statement);
        steps.push(AnsiToUtf8("3) 在程序集里新建子程序 ") + callbackName);
        steps.push(AnsiToUtf8("4) 给它加 3 个整数型参数: 控件编号 / 事件代码 / 事件文本指针"));
        result["manualSteps"] = std::move(steps);
    }
    return result;
}

// 打开指定 .e 工程（可选先保存当前工程，避免“是否保存”弹窗）。
mj::Value OpenProject(const mj::Value& params) {
    const std::string path = params.at("path").asString();
    if (BoolOr(params, "saveCurrent", false)) {
        if (!RunIdeFunction(FN_SAVE_FILE)) throw std::runtime_error("保存当前工程失败");
        PumpIdeMessages();
    }
    const std::string ansiPath = Utf8ToAnsi(path);
    if (!RunIdeFunction(FN_OPEN_FILE2, reinterpret_cast<DWORD>(const_cast<char*>(ansiPath.c_str())))) {
        throw std::runtime_error("IDE 无法打开工程: " + Utf8ToAnsi(path));
    }
    PumpIdeMessages();
    mj::Value result = mj::Value::object();
    result["opened"] = 1;
    result["path"] = path;
    return result;
}

// 把 eui_runtime.dll 部署到 IDE 安装目录（解释运行时用）与工程目录（编译产物用）。
mj::Value DeployRuntime(const mj::Value& params) {
    const std::string projectDir = params.contains("projectDir") ? params.at("projectDir").asString() : std::string();

    HMODULE selfModule = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&DeployRuntime), &selfModule) || !selfModule) {
        throw std::runtime_error("无法定位桥接支持库模块");
    }
    wchar_t selfPath[MAX_PATH]{};
    if (!GetModuleFileNameW(selfModule, selfPath, MAX_PATH)) throw std::runtime_error("无法定位桥接支持库路径");
    const std::filesystem::path source = std::filesystem::path(selfPath).parent_path() / L"eui_runtime.dll";
    if (!std::filesystem::exists(source)) {
        throw std::runtime_error("找不到 eui_runtime.dll（应与 elang_mcp.fne 同目录）: " + WideToUtf8(source.wstring()));
    }

    wchar_t idePath[MAX_PATH]{};
    GetModuleFileNameW(nullptr, idePath, MAX_PATH);
    std::vector<std::filesystem::path> targets{ std::filesystem::path(idePath).parent_path() };
    if (!projectDir.empty()) targets.push_back(std::filesystem::path(Utf8ToWide(projectDir)));

    mj::Value items = mj::Value::array();
    for (const auto& dir : targets) {
        const auto destination = dir / L"eui_runtime.dll";
        std::error_code code;
        std::filesystem::copy_file(source, destination,
                                    std::filesystem::copy_options::overwrite_existing, code);
        mj::Value item = mj::Value::object();
        item["path"] = WideToUtf8(destination.wstring());
        item["ok"] = code ? 0 : 1;
        if (code) item["error"] = AnsiToUtf8(code.message());
        items.push(std::move(item));
    }

    mj::Value result = mj::Value::object();
    result["source"] = WideToUtf8(source.wstring());
    result["targets"] = std::move(items);
    return result;
}

}  // namespace

void SetNotifyFunction(PFN_NOTIFY_SYS function) { g_notify = function; }

bool IsConnected() { return g_notify != nullptr; }

HWND GetIdeMainWindow() {
    return g_notify ? reinterpret_cast<HWND>(g_notify(NES_GET_MAIN_HWND, 0, 0)) : nullptr;
}

BOOL RunIdeFunction(DWORD functionNumber, DWORD parameter1, DWORD parameter2) {
    if (!g_notify) return FALSE;
    DWORD parameters[2]{parameter1, parameter2};
    return g_notify(NES_RUN_FUNC, functionNumber, reinterpret_cast<DWORD>(parameters)) != 0;
}

mj::Value DispatchRequest(const std::string& method, const mj::Value& params) {
    if (method == "ide.status") {
        mj::Value result = mj::Value::object();
        result["connected"] = IsConnected();
        result["ideVersion"] = "5.95";
        result["mainWindow"] = static_cast<long long>(reinterpret_cast<intptr_t>(GetIdeMainWindow()));
        mj::Value capabilities = mj::Value::object();
        capabilities["codeRead"] = true;
        capabilities["codeWrite"] = true;
        capabilities["codeBatch"] = true;
        capabilities["atomicRollback"] = true;
        capabilities["projectSave"] = true;
        capabilities["compile"] = true;
        result["capabilities"] = std::move(capabilities);
        return result;
    }
    if (method == "project.getInfo" || method == "project.getActive") {
        const auto path = ProjectPathFromTitle();
        if (path.empty()) {
            throw std::runtime_error(
                "cannot resolve the active project path; save the project and/or set E_LANGUAGE_ACTIVE_PROJECT");
        }
        int windowType = 0;
        RunIdeFunction(FN_GET_ACTIVE_WND_TYPE, reinterpret_cast<DWORD>(&windowType), 0);
        mj::Value result = mj::Value::object();
        result["connected"] = true;
        result["ideVersion"] = "5.95";
        result["projectPath"] = WideToUtf8(path.wstring());
        result["projectTitle"] = WideToUtf8(path.filename().wstring());
        result["activeWindowType"] = windowType;
        if (method == "project.getActive") result["revision"] = RevisionForCells(ReadCurrentCells(kMaxCodeRows));
        return result;
    }
    if (method == "code.readCurrent") {
        const int maxRows = std::clamp(IntOr(params, "maxRows", 5000), 1, kMaxCodeRows);
        return ReadCurrentCode(maxRows, BoolOr(params, "includeEmptyCells", false));
    }
    if (method == "code.readRange") {
        const int startRow = std::max(0, IntOr(params, "startRow", 0));
        const int rowCount = std::clamp(IntOr(params, "rowCount", 128), 1, 5000);
        const int maxRows = std::clamp(IntOr(params, "maxRows", 5000), 1, kMaxCodeRows);
        return ReadCodeRange(startRow, rowCount, maxRows, BoolOr(params, "includeEmptyCells", false));
    }
    if (method == "code.applyCurrent") return ApplyCurrent(params);
    if (method == "code.batch") return BatchCurrent(params);
    if (method == "code.move") return MoveCode(params);
    if (method == "code.syncDllCommands") return SyncDllCommands(params);
    if (method == "code.syncUiScaffold") return SyncUiScaffold(params);
    if (method == "code.deployRuntime") return DeployRuntime(params);
    if (method == "project.open") return OpenProject(params);
    if (method == "code.diagnoseCaret") return DiagnoseCaret();
    if (method == "code.ensureCodeView") return EnsureCodeViewResult();
    if (method == "debug.callIdeFunction") return CallIdeFunction(params);
    if (method == "code.undo") {
        if (!RunIdeFunction(FN_UNDO)) throw std::runtime_error("the IDE rejected undo");
        PumpIdeMessages();
        const auto cells = ReadCurrentCells(kMaxCodeRows);
        mj::Value result = mj::Value::object();
        result["revision"] = RevisionForCells(cells);
        result["cellCount"] = static_cast<int>(cells.size());
        return result;
    }
    if (method == "project.save") {
        ReadAndVerifyRevision(params);
        if (!RunIdeFunction(FN_SAVE_FILE)) throw std::runtime_error("the IDE could not save the project");
        mj::Value result = mj::Value::object();
        result["saved"] = true;
        return result;
    }
    if (method == "build.compile") {
        ReadAndVerifyRevision(params);
        if (!RunIdeFunction(FN_SAVE_FILE)) throw std::runtime_error("save failed before compilation");
        const bool staticBuild = BoolOr(params, "staticBuild", false);
        const int waitMs = std::clamp(IntOr(params, "waitMs", 0), 0, 60000);
        const std::wstring before = PrimaryOutputText(CollectDiagnosticCandidates());
        const bool started = RunIdeFunction(staticBuild ? FN_COMPILE_STATIC : FN_COMPILE) != FALSE;
        if (waitMs > 0) WaitWithPump(static_cast<DWORD>(waitMs));
        const std::wstring after = PrimaryOutputText(CollectDiagnosticCandidates());
        std::wstring delta;
        if (after.size() >= before.size() && std::equal(before.begin(), before.end(), after.begin())) {
            delta = after.substr(before.size());
        } else {
            delta = after;
        }
        mj::Value result = mj::Value::object();
        result["started"] = started;
        result["newOutput"] = WideToUtf8(delta);
        result["diagnostics"] = ReadDiagnostics();
        return result;
    }
    if (method == "build.run") {
        ReadAndVerifyRevision(params);
        mj::Value result = mj::Value::object();
        result["started"] = RunIdeFunction(FN_COMPILE_AND_RUN) != FALSE;
        return result;
    }
    if (method == "build.stop") {
        mj::Value result = mj::Value::object();
        result["stopped"] = RunIdeFunction(FN_END_RUN) != FALSE;
        return result;
    }
    if (method == "build.getDiagnostics") {
        const int waitMs = std::clamp(IntOr(params, "waitMs", 0), 0, 60000);
        if (waitMs > 0) WaitWithPump(static_cast<DWORD>(waitMs));
        return ReadDiagnostics();
    }
    if (method == "debug.dumpWindows") return DumpWindows();
    if (method == "lib.listLibraries") return ListLibraries();
    if (method == "lib.listEcoms") return ListEcoms();
    if (method == "lib.searchCommands") return SearchCommands(params);
    if (method == "lib.listTrees") return ListTrees();
    if (method == "lib.readEcomStrings") return ReadEcomStrings(params);
    if (method == "lib.inspectEcom") return InspectEcom(params);
    if (method == "lib.searchEcomCommands") return SearchEcomCommands(params);
    throw std::runtime_error("unsupported bridge method: " + method);
}

mj::Value HandleRequest(const mj::Value& request) {
    mj::Value response = mj::Value::object();
    const int id = request.contains("id") ? request.at("id").asInt() : 0;
    response["id"] = id;
    try {
        const std::string method = request.at("method").asString();
        static const mj::Value kEmptyParams = mj::Value::object();
        const mj::Value& params = request.contains("params") ? request.at("params") : kEmptyParams;
        response["ok"] = true;
        response["result"] = DispatchRequest(method, params);
    } catch (const std::exception& error) {
        response["ok"] = false;
        // C++ 窄字符串字面量是 GBK（/execution-charset:gbk），转成 UTF-8 再发，避免中文错误乱码。
        response["error"] = AnsiToUtf8(std::string(error.what()));
    }
    return response;
}

}  // namespace bridge
