# 从零写一个「易语言代码读写 MCP」实现指南

> 目标：做一个 MCP 工具，核心功能只有两个 —— **读取易语言 IDE 里的代码**、**写入/修改易语言代码**。
> 前提：易语言闭源，只有一条合法路 —— **官方支持库（FNE 插件）+ 官方 IDE 功能号（`FN_*`）**。
> 本指南基于对开源项目 `e-language-codex-mcp` 的源码分析，但目标是**最小可用**，不做那 222 条命令、不做 UI 设计器、不引入 Rust。

---

## 0. 先定边界（很重要）

只做代码读写时，**你不需要**：

- ❌ Rust 扩展引擎
- ❌ 222 条工具命令
- ❌ 可视化界面设计器 / `.eui.json` / `eui_runtime.dll`
- ❌ 模拟鼠标键盘、逆向 `.e` 二进制、Hook IDE

你**只需要**：

- ✅ 一个能被易语言加载的 **FNE 支持库**
- ✅ 命名管道（或本地 socket）做进程间通信
- ✅ 一个 TypeScript 写的 **MCP stdio 服务**
- ✅ 围绕两个官方接口：`FN_GET_PRG_TEXT`（读）和 `FN_SET_AND_COMPILE_PRG_ITEM_TEXT`（写）

---

## 1. 需要准备的开发环境

| 组件 | 说明 |
|---|---|
| 易语言 5.95 | 安装目录下要有 `sdk\cpp\elib\lib2.h`、`PublicIDEFunctions.h`、`lang.h` |
| Visual Studio | 必须含 **x86 (Win32) C++ 桌面开发**（5.95 是 32 位，只能编 Win32 DLL） |
| Node.js 20+ | 写 MCP 服务 + 命名管道客户端 |
| 一个 MCP 客户端 | Codex CLI / Claude Desktop / Cursor 等 |
| 参考代码 | 直接读 `e-language-codex-mcp` 的 `native/bridge/` 当教材最快 |

> ⚠️ **头文件是 GBK 编码**。编译时加 `/source-charset:utf-8 /execution-charset:gbk`；或像原项目那样先把 SDK 头文件转成 UTF-8 再编。

参考 `vcxproj` 关键配置：

```xml
<CharacterSet>MultiByte</CharacterSet>
<LanguageStandard>stdcpp17</LanguageStandard>
<AdditionalOptions>/source-charset:utf-8 /execution-charset:gbk %(AdditionalOptions)</AdditionalOptions>
<AdditionalIncludeDirectories>$(EasyLangRoot)\sdk\cpp\elib;...</AdditionalIncludeDirectories>
```

---

## 2. 整体架构（只有 4 层）

```
MCP 客户端(Codex/Claude)
   │ stdio + JSON-RPC (MCP)
   ▼
MCP Server (Node.js/TypeScript)          ← 你写
   │ Windows 命名管道，每行一条 JSON
   ▼
FNE 支持库 (C++，注入易语言进程)          ← 你写
   │ 官方 PFN_NOTIFY_SYS / NES_RUN_FUNC
   ▼
易语言 IDE 的代码表（内存里）
```

**为什么要有管道？** 因为 MCP Server 是独立进程，而操作 IDE 的代码必须在 IDE 进程里、且必须在 IDE 的 UI 线程上执行。

---

## 3. 里程碑总览

| 里程碑 | 目标 | 关键点 |
|---|---|---|
| **M1** | 最小 FNE 能被易语言加载 | `GetNewInf` + `LIB_INFO` + 1 条命令 |
| **M2** | 拿到 IDE 主窗口 + 官方调用入口 | `NL_SYS_NOTIFY_FUNCTION` → `PFN_NOTIFY_SYS` |
| **M3** | 命名管道跑通，能派发到 UI 线程 | `SendMessage` 回 UI 线程 |
| **M4** | **读代码** | `FN_GET_PRG_TEXT`（两次调用）+ 分页扫描 |
| **M5** | **写代码** | `FN_MOVE_CARET` + `FN_SET_AND_COMPILE_PRG_ITEM_TEXT` + 回读 |
| **M6** | 并发安全 | revision + `FN_UNDO` 回滚 |
| **M7** | MCP 服务 | `@modelcontextprotocol/sdk` + 管道客户端 |

建议**严格按顺序**做，每一步都先在易语言里手工验证，再往下走。

---

## 4. M1：最小支持库

FNE 支持库的入口就一个：`GetNewInf()` 返回 `LIB_INFO`。先做一条命令，确认 IDE 能加载。

```cpp
#include <windows.h>
#include <tchar.h>
#include <lib2.h>
#include <lang.h>
#include <PublicIDEFunctions.h>

static PFN_NOTIFY_SYS g_notify = nullptr;

// ---- 命令实现 ----
extern "C" void CmdStatus(PMDATA_INF result, INT, PMDATA_INF) {
    if (result) result->m_bool = (g_notify != nullptr);
}

// ---- 命令表 ----
static CMD_INFO g_cmd{
    _T("Codex_桥接状态"), _T("CodexBridgeStatus"),
    _T("返回桥接是否已连接易语言开发环境。"),
    1, _CMD_OS(__OS_WIN), (DATA_TYPE)SDT_BOOL,
    0, LVL_SIMPLE, 0, 0, 0, nullptr
};
static PFN_EXECUTE_CMD g_fn{ CmdStatus };
static const char* g_names[]{ "CmdStatus" };
static TCHAR g_cats[] = _T("0000Codex MCP\0\0");

// ---- 通知回调 ----
static INT WINAPI Notify(INT msg, DWORD p1, DWORD p2) {
    switch (msg) {
        case NL_SYS_NOTIFY_FUNCTION: g_notify = (PFN_NOTIFY_SYS)p1; return NR_OK;
        case NL_IDE_READY:           /* M2/M3: 启动管道 */           return NR_OK;
        case NL_UNLOAD_FROM_IDE:     /* M3: 停止管道 */             return NR_OK;
        case NL_FREE_LIB_DATA:       return NR_OK;
    }
    return NR_ERR;
}

extern "C" INT WINAPI Codex_ProcessNotifyLib(INT msg, DWORD p1, DWORD p2) {
    if (msg == NL_GET_CMD_FUNC_NAMES)      return (INT)g_names;
    if (msg == NL_GET_NOTIFY_LIB_FUNC_NAME) return (INT)"Codex_ProcessNotifyLib";
    if (msg == NL_GET_DEPENDENT_LIBS)       return 0;
    return Notify(msg, p1, p2);
}

// ---- 库信息 ----
static LIB_INFO g_lib{
    LIB_FORMAT_VER,
    _T("换成你自己的 GUID"),
    1, 8, 8, 5, 0, 3, 0,
    _T("Codex MCP IDE桥接支持库"),
    __GBK_LANG_VER,
    _T("让 AI 读写易语言代码。"),
    _LIB_OS(__OS_WIN) | LBS_IDE_PLUGIN,   // ← 关键：声明为 IDE 插件
    _T("你的名字"), _T(""), _T(""), _T(""), _T(""), _T(""), _T(""),
    0, nullptr,
    1, g_cats,
    1, &g_cmd, &g_fn, nullptr, nullptr,
    Codex_ProcessNotifyLib,
    nullptr, nullptr, 0, nullptr, nullptr
};

extern "C" __declspec(dllexport) PLIB_INFO WINAPI GetNewInf() { return &g_lib; }
BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
```

`.def` 文件：

```
LIBRARY "codex_bridge.fne"
EXPORTS
    GetNewInf
```

**验证**：
1. 编出 `codex_bridge.fne`，放到易语言 `lib\` 目录。
2. 打开易语言 → 工具 → 支持库配置 → 勾选它。
3. 重启易语言，写个小程序调用 `Codex_桥接状态 ()`，返回真即成功。

> 💡 `LIB_INFO` 的字段顺序/个数很讲究，**照抄原项目 `native/bridge/bridge.cpp` 里的 `g_library_info` 初始化**最稳。

---

## 5. M2：拿到官方调用入口

```cpp
static BOOL RunIde(DWORD fn, DWORD p1 = 0, DWORD p2 = 0) {
    if (!g_notify) return FALSE;
    DWORD args[2]{ p1, p2 };
    return g_notify(NES_RUN_FUNC, fn, (DWORD)args) != 0;
}
static HWND IdeMain() {
    return g_notify ? (HWND)g_notify(NES_GET_MAIN_HWND, 0, 0) : nullptr;
}
```

- `NL_SYS_NOTIFY_FUNCTION` 里保存的 `PFN_NOTIFY_SYS` 就是**所有官方能力的入口**。
- `NES_GET_MAIN_HWND` 拿 IDE 主窗口；`NES_RUN_FUNC` + `FN_*` 执行具体功能。
- **`FN_*` 的编号定义在 `PublicIDEFunctions.h` 里**，务必以你本地 5.95 SDK 的为准。

---

## 6. M3：命名管道 + UI 线程派发（最容易踩坑的一步）

**核心规则：所有 `FN_*` 调用必须在 IDE 的 UI 线程执行。**

做法：管道服务跑在后台线程，收到请求后 `SendMessage` 到你在 IDE 里创建的一个「派发窗口」，让 UI 线程去执行：

```cpp
constexpr UINT kDispatchMsg = WM_APP + 0x595;

// 后台线程读管道
std::string line = ReadLine(pipe);
RequestContext ctx{ json::parse(line) };
SendMessageW(g_dispatcher_hwnd, kDispatchMsg, 0, (LPARAM)&ctx);  // 阻塞等 UI 线程
WriteLine(pipe, ctx.response);

// 派发窗口的窗口过程（UI 线程）
if (msg == kDispatchMsg) return DispatchRequest((LPARAM)lParam);
```

管道要点：

- 名字：`\\.\pipe\codex-e-language-mcp`（可自定义）
- `PIPE_ACCESS_DUPLEX | PIPE_REJECT_REMOTE_CLIENTS`
- 安全描述符只放 SYSTEM + Owner：`D:P(A;;GA;;;SY)(A;;GA;;;OW)`
- 协议：**每行一条 JSON**。请求 `{ "id":1, "method":"code.read", "params":{...} }`，响应 `{ "id":1, "ok":true, "result":{...} }`
- 用 `\n` 分隔，不要依赖 readline（可能按其他字符切）

---

## 7. M4：读代码（先读后写）

### 7.1 关键接口：`FN_GET_PRG_TEXT`

参数结构（以 5.95 SDK 为准）：

```cpp
GET_PRG_TEXT_PARAM p{};
p.m_nRowIndex = row;   // 行
p.m_nColIndex = col;   // 列
p.m_pBuf      = nullptr;
p.m_nBufSize  = 0;
// 第一次调用：只让 IDE 告诉你需要多大缓冲区
RunIde(FN_GET_PRG_TEXT, (DWORD)&p);
// p.m_nBufSize 就是需要的字节数
std::vector<char> buf(p.m_nBufSize + 1, 0);
p.m_pBuf     = buf.data();
p.m_nBufSize = (int)buf.size();
// 第二次调用：真正取内容
RunIde(FN_GET_PRG_TEXT, (DWORD)&p);
// p.m_nType=单元格类型, p.m_blIsTitle=是否标题行, buf.data()=文本(GBK)
```

### 7.2 读取整张代码表的最大坑

**IDE 只“物化”当前页附近的代码行**，直接跳到一个很远的行会失败。所以读全表要这样：

1. `FN_MOVE_TOP` 回到顶部；
2. 每页读「当前光标行前后各 ~32 行」的窗口；
3. 用 `(row, col)` 去重合并；
4. 循环 `FN_MOVE_DOWN` 下移（例如每页 20 行），直到到底；
5. 结束时把光标恢复到原位置。

伪代码：

```cpp
auto origin = CurrentCaret();
RunIde(FN_MOVE_TOP); Pump();
std::map<std::pair<int,int>, Cell> merged;
for (int page = 0; page < kMaxRows; page += 20) {
    int row = CurrentCaret().first;
    if (row < 0) break;
    for (auto& c : ReadRange(row - 32, row + 33)) merged[{c.row, c.col}] = c;
    bool bottom = false;
    for (int i = 0; i < 20; ++i) {
        auto before = CurrentCaret();
        if (!RunIde(FN_MOVE_DOWN) || CurrentCaret() == before) { bottom = true; break; }
    }
    Pump();
    if (bottom) break;
}
RunIde(FN_MOVE_TOP);
for (int r = 0; r < origin.first; ++r) RunIde(FN_MOVE_DOWN);
RunIde(FN_MOVE_CARET, origin.first, origin.second);
```

### 7.3 单元格的 `type` 是什么

`FN_GET_PRG_TEXT` 返回的 `m_nType` 是 `VT_*` 常量，代表这个格子的语义：

| 逻辑含义 | 类型常量 |
|---|---|
| 模块名 | `VT_MOD_NAME` |
| 子程序名 | `VT_SUB_NAME` |
| 子程序返回值类型 | `VT_SUB_RET_TYPE` |
| 参数名 | `VT_SUB_ARG_NAME` |
| 参数类型 | `VT_SUB_ARG_TYPE` |
| 局部变量 | `VT_SUB_VAR_NAME` |
| 全局变量 | `VT_GLOBAL_VAR_NAME` |
| 语句 | `VT_SUB_PRG_ITEM` |
| DLL 命令名 | `VT_DLL_CMD_NAME` |

> 这些常量同样在 SDK 头文件里，**以本地为准**。

### 7.4 对外返回

```json
{ "revision":"a1b2c3d4e5f60718",
  "cells":[ {"row":0,"column":0,"type":..., "title":true, "text":"..."} ],
  "caret":{"row":12,"column":0} }
```

---

## 8. M5：写代码

### 8.1 写入原语

官方写接口假设“写**当前光标**处的格子”，所以必须先移光标：

```cpp
bool WriteCell(int row, int col, const std::string& utf8, bool compile = false) {
    std::string gbk = Utf8ToGbk(utf8);          // UTF-8 → GBK(CP_ACP)
    if (!MoveCaret(row, col)) return false;      // FN_MOVE_CARET
    if (!RunIde(FN_SET_AND_COMPILE_PRG_ITEM_TEXT,
                (DWORD)gbk.c_str(), compile ? TRUE : FALSE)) return false;
    Pump();
    Cell c;                                      // 写后回读校验
    return ReadCell(row, col, &c) && c.text == gbk;
}
```

### 8.2 稳健地移动光标

```cpp
bool MoveCaret(int row, int col) {
    if (RunIde(FN_MOVE_CARET, row, col)) {
        Pump();
        if (CurrentCaret() == std::make_pair(row, col)) return true;
    }
    // 绝对跳转失败 → 置顶后逐行下移
    if (!RunIde(FN_MOVE_TOP)) return false;
    Pump();
    for (int step = 0; step < kMaxRows * 2; ++step) {
        auto cur = CurrentCaret();
        if (cur.first == row) return RunIde(FN_MOVE_CARET, row, col);
        if (cur.first < 0 || cur.first > row) return false;
        if (!RunIde(FN_MOVE_DOWN)) return false;
        Pump();
    }
    return false;
}
```

### 8.3 插入结构

不能凭空写模块/子程序，要先用官方插入命令建空行，再填充：

```cpp
DWORD InsertFn(kind) {
  module        -> FN_INSERT_NEW_MOD
  subprogram    -> FN_INSERT_NEW_SUB
  argument      -> FN_INSERT_NEW_ARG
  localVariable -> FN_INSERT_NEW_LOCAL_VAR
  globalVariable-> FN_INSERT_NEW_GLOBAL_VAR
  statement     -> FN_INSERT_NEW          // 在当前项之后插
}
```

插入后光标就在新行，可以据此用**相对行偏移**填字段。

### 8.4 回滚

```cpp
void Rollback(const std::string& initialRevision, int mutations) {
    for (int i = 0; i < mutations + 4; ++i) {
        if (Revision() == initialRevision) return;
        if (!RunIde(FN_UNDO)) break;
        Pump();
    }
}
```

---

## 9. M6：并发安全（Revision）

**原理**：把整张代码表算一个哈希，写操作必须带上“我读到的那个版本”。版本对不上就拒绝，防止覆盖别人的改动。

```cpp
std::string Revision(const std::vector<Cell>& cells) {
    uint64_t h = 1469598103934665603ULL;          // FNV-1a 64
    auto mix = [&](const std::string& s) {
        for (unsigned char b : s) { h ^= b; h *= 1099511628211ULL; }
        h ^= 0xff; h *= 1099511628211ULL;
    };
    for (auto& c : cells) {
        mix(c.text);
        mix(std::to_string(c.type));
        h ^= (uint64_t)(c.row * 31 + c.col); h *= 1099511628211ULL;
    }
    char out[17]; snprintf(out, sizeof(out), "%016llx", h);
    return out;
}
```

写流程：`读全表 → revision → 比对 expectedRevision → 逐格写 → 写后回读 → 失败则 UNDO 回滚`。

> 进阶（可选）：按“模块/子程序”分段哈希再组合，把冲突粒度做小，避免改一个字就全表失效。

---

## 10. M7：MCP 服务（TypeScript）

### 10.1 最小服务

```ts
// index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call } from "./pipe-client.js";

const server = new McpServer({ name: "e-language-mcp", version: "0.1.0" });

server.registerTool("code_read",
  { title: "读取当前代码", description: "读取活动工程当前代码表。",
    inputSchema: { maxRows: z.number().int().min(1).max(20000).default(5000) } },
  async ({ maxRows }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("code.read", { maxRows }), null, 2) }],
  }));

server.registerTool("code_write",
  { title: "修改代码", description: "按行列修改代码，带修订号校验。",
    inputSchema: {
      expectedRevision: z.string().min(8),
      edits: z.array(z.object({
        row: z.number().int().min(0),
        column: z.number().int().min(0),
        text: z.string().max(32768),
      })).min(1).max(1000),
    } },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(await call("code.write", params), null, 2) }],
  }));

await server.connect(new StdioServerTransport());
```

### 10.2 管道客户端

```ts
// pipe-client.ts
import net from "node:net";
const PIPE = "\\\\.\\pipe\\codex-e-language-mcp";
let nextId = 1;

export function call<T>(method: string, params: unknown = {}): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(PIPE);
    let buf = "", done = false;
    const finish = (err?: Error, val?: T) => {
      if (done) return; done = true;
      clearTimeout(timer); sock.destroy();
      err ? reject(err) : resolve(val as T);
    };
    const timer = setTimeout(() => finish(new Error(`超时: ${method}`)), 10000);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n"); if (nl < 0) return;
      const res = JSON.parse(buf.slice(0, nl));
      if (!res.ok) finish(new Error(res.error)); else finish(undefined, res.result);
    });
    sock.on("error", (e) => finish(new Error(
      e.message.includes("ENOENT") ? "易语言未运行或未启用桥接支持库。" : e.message)));
  });
}
```

### 10.3 建议暴露的工具（够用就行）

| 工具 | 作用 |
|---|---|
| `ide_status` | 是否连上 IDE |
| `project_get_active` | 当前工程路径 + revision |
| `code_read` | 读代码表 |
| `code_read_range` | 读指定行范围（大工程的精确定位） |
| `code_write` | 按行列批量改（带 revision） |
| `code_insert` | 插入模块/子程序/参数/语句 |
| `project_save` | 官方保存 |
| `build_compile` / `build_run` / `build_stop` | 编译 / 运行 / 停止 |
| `build_get_diagnostics` | 读编译输出（只读） |

### 10.4 注册到客户端

- Codex：`codex mcp add e-language -- node /path/to/server.mjs`
- Claude Desktop：写进 `claude_desktop_config.json` 的 `mcpServers`

---

## 11. 必须记住的坑（血泪清单）

1. **必须 x86**：易语言 5.95 是 32 位，FNE 只能 Win32。
2. **源码/执行字符集**：`/source-charset:utf-8 /execution-charset:gbk`；SDK 头文件是 GBK，注意转码。
3. **所有 IDE 操作在 UI 线程**：管道线程必须 `SendMessage` 回 UI 线程执行。
4. **光标是有状态的**：读全表会移动光标，**记得恢复**；写之前必须移动光标。
5. **代码表只物化当前页**：读全表要 `MOVE_TOP` + 逐行 `MOVE_DOWN` 分页扫。
6. **行号会漂移**：插入/删除后行号变化，尽量用“结构定位 + 相对偏移”，并靠回读校验。
7. **编码有损**：IDE 是 GBK/GB18030，表示不了的字符会变 `?`，要显式报错而不是静默替换。
8. **工程路径**：从 IDE 标题解析不稳定，最好支持环境变量（如 `E_LANGUAGE_ACTIVE_PROJECT`）或让用户传参。
9. **写后必回读**：官方接口可能“接受但不生效”。
10. **失败要能回滚**：记录操作数，用 `FN_UNDO` 撤回；理想情况包成一个 undo 块。
11. **别做**：输入模拟、逆向 `.e`、Hook 内存 —— 破坏“官方、稳定、可审查”的优势。
12. **版本绑定**：这套只对 5.95 有效，把 `FN_*` 差异封装成适配层，别散落各处。

---

## 12. 最小目录结构

```
e-lang-mcp/
├─ fne/                       # C++ 支持库（VS 工程，Win32）
│  ├─ bridge.cpp              # GetNewInf / LIB_INFO / 通知
│  ├─ pipe_server.cpp         # 命名管道 + UI 线程派发
│  ├─ ide_api.cpp             # 读/写/导航/保存/编译
│  ├─ code_types.h            # VT_* 映射
│  └─ codex_bridge.def
├─ server/                    # MCP 服务（TypeScript）
│  ├─ package.json
│  ├─ src/index.ts
│  ├─ src/pipe-client.ts
│  └─ src/tools.ts
└─ scripts/
   ├─ build-native.ps1        # 编 FNE
   └─ install.ps1             # 拷到 <EasyLang>\lib\ 并注册 MCP
```

---

## 13. 快速通道：直接基于开源项目裁剪

如果不想从零，**最快**的方法是 fork `e-language-codex-mcp`，然后：

1. 删掉 `rust-common/`（222 命令）、`native/runtime/`（UI 运行库）、`native/bridge/designer.cpp`（设计器）。
2. 保留并精简 `native/bridge/ide_api.cpp` 里的读/写/导航/保存/编译，以及 `pipe_server.cpp`。
3. 保留 `mcp-server` 的 `pipe-client.ts`，把 `tools.ts` 裁到上表那几个工具。
4. 去掉 `.eui.json` 相关代码。

这样你能在几天内得到一个**只做代码读写、体积小、可维护**的版本。

---

## 14. 一句话总结

> 先做一个能被 IDE 加载的 FNE，拿到 `PFN_NOTIFY_SYS`；然后**先实现读（`FN_GET_PRG_TEXT` + 分页导航），再实现写（`FN_MOVE_CARET` + `FN_SET_AND_COMPILE_PRG_ITEM_TEXT` + 回读）**；用命名管道把请求搬到 UI 线程；最后用 TypeScript 包成 MCP 工具。全程只碰官方接口，不碰 `.e` 二进制。
