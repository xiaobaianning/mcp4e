# 易语言 Codex MCP —— 实现原理分析

> 分析对象：`E:\mcp4e\e-language-codex-mcp-main`
> 项目：易语言 Codex MCP（`e-language-mcp-ide` v0.8.0，MIT）
> 作用：让 Codex（以及任何 MCP 客户端）直接在**易语言 5.95 IDE**里读代码、写代码、设计窗口、运行/编译程序，并提供 222 条 Rust 实现的中文扩展命令。

---

## 0. 一句话原理

> 用 **TypeScript 写一个 MCP stdio 服务**，它通过 **Windows 命名管道**把 JSON 请求发给一个**注入到易语言 IDE 进程内的 C++ 支持库（FNE）**；该支持库只调用易语言**官方 SDK 接口**（`PFN_NOTIFY_SYS` / `NES_RUN_FUNC`）操作 IDE，用 **`.eui.json`** 作为可视化界面的旁路数据，并额外加载一个 **x86 Rust cdylib** 提供 222 条通用工具命令。

不模拟鼠标键盘、不逆向 IDE 内部函数、不改写 `.e` 二进制工程。

---

## 1. 总体架构

```
                   ┌──────────────────────────────────────────────┐
   模型/Codex  ──stdio(JSON-RPC)──►  MCP Server (Node.js, TS)        │
                   │  @modelcontextprotocol/sdk  McpServer          │
                   │  ├─ tools.ts   注册 ~20 个 MCP 工具            │
                   │  ├─ ui-store/schema/revision  .eui.json 读写   │
                   │  └─ pipe-client.ts  IdeBridgeClient            │
                   └───────────────┬──────────────────────────────┘
                                   │ Windows 命名管道
                                   │ \\.\pipe\e-language-mcp
                                   │ 每行一条 JSON: {id,method,params}
                                   ▼
        ┌────────────────────────────────────────────────────────────┐
        │  易语言 IDE 进程 (5.95, x86)                                │
        │  ┌──────────────────────────────────────────────────────┐  │
        │  │ eide_bridge.fne  (C++ 支持库, native/bridge)          │  │
        │  │  ├─ pipe_server.cpp   命名管道服务 + UI 线程派发       │  │
        │  │  ├─ ide_api.cpp       调用官方 IDE 功能 + 代码修订/回滚 │  │
        │  │  ├─ designer.cpp      IDE 内嵌可视化设计器（GDI）      │  │
        │  │  └─ rust_common_support.cpp  222 条命令适配层          │  │
        │  └───────────────┬──────────────────────┬───────────────┘  │
        │                  │ LoadLibrary          │ 生成的 .e 调用     │
        │                  ▼                      ▼                   │
        │      eide_tools_engine.dll       eui_runtime.dll            │
        │      (Rust cdylib, 222 命令)     (Win32 GUI 运行库)         │
        └────────────────────────────────────────────────────────────┘
                                   ▲
                                   │ 运行时读取
                            <工程名>.eui.json  (UTF-8 界面文档)
```

关键点：**命名管道服务虽然运行在独立线程，但真正的 IDE 操作通过 `SendMessageW(设计器窗口, WM_APP+0x595, ...)` 回到 IDE 的 UI 线程执行**，因为易语言官方 API 只能在 UI 线程调用（见 `pipe_server.cpp` 的 `SendMessageW(g_dispatcher, kPipeDispatchMessage, ...)` 与 `designer.cpp` 中 `if (message == PipeDispatchMessage()) return DispatchPipeMessage(l_param);`）。

---

## 2. 目录结构（核心部分）

```
e-language-codex-mcp-main/
├─ package.json                 # npm workspace: mcp-server；build/test/check 脚本
├─ mcp-server/                  # MCP 服务（TypeScript）
│  ├─ package.json              # 依赖 @modelcontextprotocol/sdk 1.29.0 + zod 4
│  ├─ tsconfig.json
│  ├─ src/
│  │  ├─ index.ts               # 入口：StdioServerTransport + createServer()
│  │  ├─ server.ts              # McpServer 实例，注册说明与工具
│  │  ├─ tools.ts               # 全部 MCP 工具定义（zod schema + annotations）
│  │  ├─ pipe-client.ts         # IdeBridgeClient：命名管道 JSON 调用
│  │  ├─ project.ts             # 活动工程信息/校验
│  │  ├─ project-template.ts    # 从内置模板新建工程（含模板 SHA256 校验）
│  │  ├─ paths.ts               # .e/.e8 与 .eui.json 路径规则、目录逃逸校验
│  │  ├─ schema.ts              # .eui.json 的 zod schema + 交叉校验
│  │  ├─ ui-store.ts            # 文档读写/增删改/事件绑定（原子写）
│  │  ├─ revision.ts            # canonicalJson + sha256 修订号
│  │  ├─ generated-code.ts      # 生成易语言启动/事件回调源码文本
│  │  └─ event-trace.ts         # 读取运行期事件追踪 JSONL
│  └─ templates/                # windows-window.e / windows-console.e / windows-ui.e
├─ native/                      # 原生层（C++ / MSBuild Win32）
│  ├─ eui_native.sln
│  ├─ bridge/                   # eide_bridge.fne（IDE 桥接 + 设计器 + 管道）
│  ├─ runtime/                  # eui_runtime.dll（界面运行库）
│  ├─ common/                   # ui_document.{h,cpp}（.eui.json 解析/校验/原子保存）
│  ├─ rust_common_support/      # 222 条命令 → Rust 的 C++ 适配层
│  ├─ tests/  preview/          # 原生测试 / 预览 exe
│  └─ third_party/              # nlohmann/json 等
├─ rust-common/engine/          # Rust cdylib：eide_tools_engine.dll
│  ├─ Cargo.toml                # aes-gcm/argon2/blake3/ed25519/zstd/qrcode/...
│  └─ src/lib.rs                # 约 7000 行，导出 #[no_mangle] FFI
├─ scripts/                     # build-native.ps1 / install.ps1 / package-release.ps1 / check-no-simulation.ps1
├─ docs/                        # INSTALL.md / 扩展命令-使用说明.md
└─ examples/                    # 星盾安全工具箱.e、声律播放器.e + .eui.json
```

---

## 3. 分层实现原理

### 3.1 MCP 服务层（TypeScript）

- 入口 `src/index.ts`：

  ```ts
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  ```

  即标准 **stdio 传输**的 MCP Server（每行一条 JSON-RPC）。
- `src/server.ts` 用 `McpServer` 注册名称、版本、说明，并调用 `registerTools(server, client)`。
- `src/tools.ts` 用 `server.registerTool(name, { title, description, inputSchema, annotations }, handler)` 注册工具；`inputSchema` 由 **zod** 描述，SDK 自动生成 JSON Schema。
- 工具用 `annotations` 表达语义（读写属性）：
  - 读：`readOnlyHint: true`
  - 写：`destructiveHint: true`
  - 执行（编译/运行）：`openWorldHint: true`
- 返回值统一为 `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`。

主要工具（对应 README 表格）：

| 分类 | 工具 |
|---|---|
| 状态 | `ide_status`、`project_get_active` |
| 工程 | `project_new`（模板）、`project_open`（先官方保存再打开）、`project_save` |
| 代码 | `code_read_current`、`code_read_range`、`code_apply_current`、`code_batch`、`code_insert_unit`、`code_move`、`code_compact_current`（只读预览） |
| 界面 | `project_attach_ui`、`ui_get_document`、`ui_upsert_control`、`ui_apply_batch`、`ui_remove_control`、`ui_bind_event`、`ui_sync_code`、`ui_get_event_trace`、`ui_clear_event_trace` |
| 构建 | `build_compile`、`build_run`、`build_stop`、`build_get_diagnostics` |

#### 命名管道客户端（`pipe-client.ts`）

```ts
export const defaultPipePath = "\\\\.\\pipe\\e-language-mcp";
const request = `${JSON.stringify({ id, method, params })}\n`;
// net.createConnection(pipePath) → write(request)
// 读一行 → JSON.parse → { id, ok, result?, error? }
```

- 每次调用新建连接（短连接），默认 10s 超时。
- 连接失败时把 `ENOENT` 翻译为“易语言 IDE 插件未运行，请启动易语言并启用 eide_bridge 支持库”。

#### `.eui.json` 界面文档（`schema.ts` + `ui-store.ts` + `revision.ts`）

- zod schema 定义 `schemaVersion=1`、`revision`、`form`（标题/尺寸/事件）、`theme`（配色/字体）、`controls[]`（label/button/text/textarea/checkbox/combobox）。
- `superRefine` 做交叉校验：id 与 runtimeId 唯一、事件类型与控件类型匹配、combobox `selectedIndex` 合法等。
- **修订号**：`revision = sha256(canonicalJson(document))`。写操作必须带 `expectedRevision`，不匹配则拒绝（乐观并发控制）。
- **原子写**：写 `<file>.<pid>.tmp` 后 `rename` 覆盖。

### 3.2 IDE 桥接层：命名管道 JSON-RPC（`native/bridge/pipe_server.cpp`）

- 管道名 `\\.\pipe\e-language-mcp`，`PIPE_ACCESS_DUPLEX | PIPE_REJECT_REMOTE_CLIENTS`。
- 安全描述符 SDDL `D:P(A;;GA;;;SY)(A;;GA;;;OW)`：仅允许 **SYSTEM** 与 **Owner** 访问。
- 服务线程循环：`CreateNamedPipeW → ConnectNamedPipe → ReadLine → parse JSON → SendMessageW(dispatcher, kPipeDispatchMessage, ...) → WriteLine(response) → Disconnect/Close`。
- 单条请求上限 8MB。
- `StartPipeServer(dispatcher_window)` 在收到 IDE 的 `NL_IDE_READY` 通知后启动；`StopPipeServer` 在卸载时唤醒并 join。

`HandlePipeDispatch` 组装统一响应：

```cpp
context->response = { {"id", id}, {"ok", true}, {"result", DispatchRequest(request)} };
// 异常时 { {"id",id}, {"ok",false}, {"error", what()} }
```

### 3.3 易语言支持库（FNE）如何被 IDE 加载（`bridge.cpp`）

- 产物 `eide_bridge.fne`，只导出 `GetNewInf()`（见 `eide_bridge.def`）。
- `GetNewInf()` 返回一个 `LIB_INFO g_library_info`，其中声明：
  - 库名 `Codex MCP IDE桥接支持库`、21 个分类、`kCommandCount = 1 + 222`
  - 命令表 `g_commands`、函数表 `g_command_functions`、函数名表
  - 依赖 DLL `eide_tools_engine.dll`
  - 通知函数 `eide_bridge_ProcessNotifyLib`
- IDE 通过消息通知支持库：
  - `NL_SYS_NOTIFY_FUNCTION`：拿到官方 `PFN_NOTIFY_SYS` 回调，保存到 `bridge::SetNotifyFunction`。
  - `NL_IDE_READY`：拿到 IDE 主窗口 → `CreateDesigner()` 创建设计器子窗口 → `StartPipeServer()` 启动管道。
  - `NL_UNLOAD_FROM_IDE / NL_FREE_LIB_DATA`：停止管道、销毁设计器、卸载 Rust 引擎。
- 唯一自带命令 `Codex_桥接状态` 返回 IDE 主窗口是否可用。

分类编号严格用易语言 SDK 的“1 起始编号”，按命令中文前缀归类（`工具_`→2、`文本_`→4、`JSON_`→5 … `图片_`→21，`CommandCategory()`）。左侧命令树与命令名完全一致。

### 3.4 调用官方 IDE 接口 + 代码读写/回滚（`native/bridge/ide_api.cpp`）

官方调用封装：

```cpp
HWND GetIdeMainWindow() { return g_notify_sys(NES_GET_MAIN_HWND, 0, 0); }
BOOL RunIdeFunction(DWORD fn, DWORD p1, DWORD p2) {
    DWORD params[2]{p1, p2};
    return g_notify_sys(NES_RUN_FUNC, fn, (DWORD)params) != 0;
}
```

用到的官方功能号（举例）：

- 读写代码：`FN_GET_PRG_TEXT`、`FN_SET_AND_COMPILE_PRG_ITEM_TEXT`
- 导航：`FN_GET_CARET_ROW_INDEX`/`COL`、`FN_MOVE_TOP/BOTTOM/UP/DOWN`、`FN_MOVE_CARET`、`FN_MOVE_PREV_UNIT`/`NEXT_UNIT`
- 结构插入：`FN_INSERT_NEW_MOD`/`SUB`/`DLL_CMD`/`ARG`/`LOCAL_VAR`/`GLOBAL_VAR`/`NEW`/`NEW_AT_NEXT`
- 编辑器：`FN_VIEW_DLLCMD_TAB`、`FN_EXTEND_ALL_SUB`、`FN_BLK_ADD_DEF`/`FN_BLK_CLEAR_ALL_DEF`、`FN_REMOVE`、`FN_UNDO`
- 工程：`FN_SAVE_FILE`、`FN_OPEN_FILE2`、`FN_NEW_FILE`、`FN_GET_ACTIVE_WND_TYPE`
- 构建：`FN_COMPILE`、`FN_COMPILE_STATIC`、`FN_COMPILE_AND_RUN`、`FN_COMPILE_WINDOWS_ECOM`、`FN_END_RUN`
- 设计器页签：`FN_ADD_TAB`

关键机制：

1. **代码表读取分页**：5.95 只暴露“已物化”的行，绝对跳行会失败，于是 `ReadCurrentCells` 先 `FN_MOVE_TOP`，再按 20 行步进 `FN_MOVE_DOWN`，每次读当前页前后各 32 行的窗口，用 `{row,col}` 去重合并，最后恢复原光标。
2. **修订号（revision）**：`RevisionForCells` 用 **FNV-1a 64 位**哈希覆盖每个单元格的 text/type/title/坐标，输出 16 位十六进制。所有写操作先校验 `expectedRevision`，防止基于过期内容覆盖。
3. **写后回读校验**：`SetProgramCellText` 调用官方写接口后，重新读回该单元格，文本不一致即抛错。
4. **整批原子回滚**：`code.batch`/`code.applyCurrent` 记录 `mutation_count`，任一步失败或回读不一致时 `RollBackToRevision()` 连续 `FN_UNDO` 直到 revision 回到初始值，回滚不完整则报错。
5. **类型严格校验**：`VerifyCellKind` 把逻辑类型（module/subprogram/argument/statement…）映射为 `VT_*` 单元格类型，不匹配即拒绝（用于 `windows-ui` 脚手架同步）。
6. **IDE 消息泵**：`PumpIdeMessages()` 反复 `MsgWaitForMultipleObjects + PeekMessage + Translate/Dispatch`，让 IDE 在处理管道请求期间仍能刷新。
7. **诊断采集（只读）**：`ReadDiagnostics()` 用 `EnumChildWindows` 找 class 含 `edit`/`richedit` 的子窗口，取文本最长的 5 个作为编译输出，不做任何输入注入。

`DispatchRequest()` 支持的方法：`ide.status`、`project.getInfo/getActive/open/save`、`code.readCurrent/readRange/compactCurrent/findUnit/findSymbol/syncUiScaffold/move/insertUnit/batch/applyCurrent`、`ui.open`、`build.compile/run/stop/getDiagnostics/compileEcom`。

活动工程路径解析：优先环境变量 `E_LANGUAGE_ACTIVE_PROJECT`，否则从 IDE 主窗口标题中解析 `X:\...\*.e`/`.e8`（`ProjectPathFromTitle()`）。写盘前用 `ProjectDirectorySupportsBackups()` 探测目录可写，避免弹“是否保存”对话框。

### 3.5 IDE 内可视化设计器（`native/bridge/designer.cpp`）

- 用 `CreateWindowExW` 创建子窗口，`FN_ADD_TAB` 注册成 IDE 的一个页签（“Codex UI”）。
- 纯 GDI 绘制：调色板按钮、网格画布、缩放（0.5x~2x）、拖拽/右下角缩放、属性面板、撤销/重做栈（最多 100 步）。
- 编辑结果调用 `eui::SaveDocument()` 落盘为 `.eui.json`（原子替换），并触发管道把最新文档同步给 MCP 端。
- 它只改 `.eui.json` 旁路文档，**不动 `.e` 二进制**。

### 3.6 界面运行库 `eui_runtime.dll`（`native/runtime/runtime.cpp`）

- 导出（`eui_runtime.def`）：`EUI_RunA/W`、`EUI_Close`、`EUI_GetTextA/PtrA`、`EUI_SetTextA`、`EUI_SetVisible/Enabled`、`EUI_GetLastEventControl/Code/ValuePtrA`。
- `EUI_RunA(path, callback)`：加载 `.eui.json` → 创建真实 Win32 窗口与控件（STATIC/BUTTON/EDIT/COMBOBOX），自绘按钮（`BS_OWNERDRAW` + `WM_DRAWITEM` + `RoundRect`），按 DPI（`GetDpiForSystem` + `WM_DPICHANGED`）缩放，应用主题配色/字体。
- 事件：按钮 `BN_CLICKED`、编辑框 `EN_CHANGE`、复选框 `BN_CLICKED`、组合框 `CBN_SELCHANGE`、窗口 `created/closing`、以及绑定 `timer` 时 500ms 定时器。
- 事件分派前先查 `.eui.json` 是否绑定该事件；若绑定且回调存在，调用易语言回调 `EUI_事件回调(控件ID, 事件码, 文本指针)`，并记录：
  - `EUI_GetLastEventControl/Code/ValuePtrA`
  - 追加 JSONL 事件追踪到 `%TEMP%\eui-runtime-events.jsonl`（MCP 端 `event-trace.ts` 读取，用于判断“事件是否绑定、回调是否存在、是否派发”）。
- 追踪文件超过 4MB 自动清空。

### 3.7 生成的易语言启动/事件代码（`generated-code.ts`）

`generateEasySource()` 输出 `.版本 2` 源码文本，包含：

- `.DLL命令 EUI_MCP_RunA, 整数型, "eui_runtime.dll", "EUI_RunA"` 等 DLL 声明
- `.程序集 __EUI_生成`、`.子程序 _启动子程序`/`EUI_启动界面`
- `.程序集 EUI_事件`、`.子程序 EUI_事件回调`（按控件号/事件码分派）

`ui_sync_code` 会用 `code.findUnit("__EUI_生成")` / `code.findSymbol("_启动子程序")` 校验 `windows-ui` 工程脚手架是否完整，然后把启动语句里的 `__EUI_DOCUMENT__` 或旧路径替换为当前 `.eui.json` 文件名；**不向普通工程强行注入脚手架**（不支持时明确报错）。

### 3.8 Rust 扩展引擎（`rust-common/engine/src/lib.rs`）

- 产物：`eide_tools_engine.dll`，`crate-type=["cdylib"]`，目标 `i686-pc-windows-msvc`（x86，匹配 5.95）。
- 依赖：`aes-gcm / argon2 / blake3 / ed25519-dalek / x25519-dalek / hmac / sha1/sha2/md-5 / pbkdf2 / regex / serde_json / serde_yaml / toml / csv / flate2 / zstd / zip / qrcode / image / url / ureq / chrono / unicode-* / subtle / strsim / ciborium / rmp-serde / data-encoding / crc32fast / mime_guess / imagesize`。
- FFI 约定（统一风格）：

  ```rust
  #[unsafe(no_mangle)]
  pub unsafe extern "system" fn rust_text_sha256(
      input: *const u16, output: *mut u16, capacity: u32) -> i32
  ```

  - 入参/出参用 **UTF-16**（`*const u16` / `*mut u16 + capacity`），返回 `i32`（1/0 或数值）。
  - 错误写入 **thread_local `LAST_ERROR`**，由 `rust_common_last_error` 读取（中文错误消息）。
  - 需要系统随机数时用 `BCryptGenRandom(BCRYPT_USE_SYSTEM_PREFERRED_RNG)`；安全随机整数用拒绝采样消除取模偏差。
  - 直接调用 Win32：`mciSendStringW`（媒体）、`ShowWindow/GetConsoleWindow`（隐藏控制台）、`GlobalMemoryStatusEx`、`GetDiskFreeSpaceExW` 等。
- 覆盖能力：文本/编码、JSON/CSV/INI/TOML/YAML/Markdown、哈希与 HMAC、PBKDF2/Argon2id/AES-256-GCM/Ed25519/X25519/JWT/TOTP、正则、GZIP/ZSTD/ZIP、文件/目录/路径、系统信息、时间、网络(URL/DNS/HTTP)、图片(信息/缩略图/二维码/感知哈希/主色)、媒体播放、分布式 ID（UUID/ULID/NanoID/雪花）、SimHash 等。

### 3.9 C++ 适配层：把 Rust 变成易语言命令（`native/rust_common_support/`）

- `common_commands.h`：`kCommandCount = 222`，暴露 `Commands()/Functions()/FunctionNames()`。
- `rust_common_support.cpp` 做了三件事：
  1. **动态加载引擎**：`LoadLibraryW` 从 FNE 同目录加载 `eide_tools_engine.dll`（`Engine()` / `EngineFunction<T>(name)`），缺 DLL 时给出中文提示。
  2. **编码转换**：易语言 ABI 用 **GB18030（代码页 54936，回退 GBK 936）**，Rust 用 UTF-16/UTF-8；`ToWide/ToEasyText` 负责互转。
  3. **声明 222 条 `CMD_INFO`**：每条含中文命令名、英文符号名、说明、分类号、返回类型、参数个数与 `ARG_INFO` 参数说明；`g_functions[]` 是 `extern "C"` 适配函数，把 `PMDATA_INF` 参数转成 Rust FFI 调用再写回结果。
- 编译期 `static_assert` 保证 `g_commands / g_functions / g_function_names` 三者数量都等于 222。

### 3.10 安装与 Codex 集成（`scripts/install.ps1` / `package-release.ps1`）

- 安装（管理员一次）：
  - 把 `dist/native/eide_bridge.fne` 与 `eide_tools_engine.dll` 复制到易语言 `lib\`（覆盖前做哈希比对与备份，`-Force` 才替换；清理旧的 `rust_common.fne`）。
  - 注册 Codex MCP：`codex mcp add e-language --env E_LANGUAGE_RUNTIME_DLL=<...eui_runtime.dll> -- node <...server.mjs>`。
  - 在 `~/.codex/config.toml` 的 `[mcp_servers.e-language]` 段补 `default_tools_approval_mode = "writes"`（写操作需人工批准）。
- 发布（`package-release.ps1`）：esbuild 把 TS 打成单文件 `server.mjs`，复制 FNE/引擎/运行库/模板/示例/文档，生成 `SHA256SUMS.txt`，用 `tar.exe` 打 UTF-8 ZIP（`易语言CodexMCP-v0.8.0.zip`）。
- 普通用户安装步骤（README/INSTALL）：解压 → 关闭易语言 → 双击 `安装.bat` → 易语言“工具→支持库配置”勾选 → 重启易语言与 Codex。

### 3.11 构建流程（`scripts/build-native.ps1`）

1. 用 `vswhere` 找 VS x86 C++ Build Tools 与 MSBuild。
2. 从易语言 SDK 目录读取 `lib2.h / PublicIDEFunctions.h / lang.h`（**GBK(936) 解码**），做几处默认参数替换后以 **UTF-8 无 BOM** 写入 `native/.generated-sdk`（便于 MSVC 以 UTF-8 编译）。
3. `cargo build --release --target i686-pc-windows-msvc` 构建 Rust 引擎，复制 DLL 到 `dist/native`。
4. MSBuild 构建 `native/eui_native.sln`（Win32）：`eide_bridge.fne`、`eui_runtime.dll`、`native_tests.exe`、`eui_preview.exe`。
5. 把 `eui_runtime.dll` 同步到测试目录，避免 `native_tests.exe` 加载到旧 DLL。

---

## 4. 关键设计点与安全边界

| 主题 | 做法 |
|---|---|
| 不模拟输入 | `scripts/check-no-simulation.ps1` 扫描 `native/**/*.cpp,h` 禁止 `SendInput / mouse_event / keybd_event / SetCursorPos`；CI 校验 |
| 不逆向 IDE | 只通过官方 `PFN_NOTIFY_SYS / NES_RUN_FUNC` 和 `ADD_TAB_INF`、`LPPARAM` 等公开结构 |
| 不改 `.e` 二进制 | 界面数据放同名 `.eui.json`；代码修改走官方单元格 API |
| 线程模型 | 管道线程 → `SendMessage` 到 IDE UI 线程执行官方 API |
| 并发写保护 | 代码用 FNV-1a revision、界面用 sha256 revision，全部“读时取号、写时校验” |
| 失败回滚 | 代码批操作 `FN_UNDO` 回滚；界面 `.eui.json` 临时文件 + 原子 rename |
| 工程切换无弹窗 | 切换/保存前先 `FN_SAVE_FILE`，并先探测工程目录可写 |
| 管道安全 | `PIPE_REJECT_REMOTE_CLIENTS` + SDDL 仅 `SYSTEM` 与 `Owner` |
| 明文安全 | 密码用 PBKDF2/Argon2id；AES-256-GCM 随机 nonce + 认证标签；Ed25519/X25519/TOTP |
| 资源上限 | 请求 8MB、解压 8MB、递归最多 10 万文件、图片目录最多 2000 张、事件追踪 4MB 自动截断 |
| 只读诊断 | 编译输出靠枚举 IDE 子控件读取，不做 GUI 自动化兜底 |

---

## 5. 一次典型调用的数据流

### 例：`code_apply_current`（修改代码）

```
模型 → MCP Server tools.ts code_apply_current(expectedRevision, edits)
  → IdeBridgeClient.call("code.applyCurrent", {...})
  → 命名管道 "\\.\pipe\e-language-mcp" 发送 {id,method,params}\n
  → pipe_server 读一行 → SendMessage 到 IDE UI 线程
  → ide_api DispatchRequest("code.applyCurrent")
       ├─ ReadAndVerifyCodeRevision(): 读全表 + FNV revision，与 expectedRevision 比对
       ├─ VerifyCellKind()（若带 expectedKind）
       ├─ SetProgramCellText(): FN_MOVE_CARET → FN_SET_AND_COMPILE_PRG_ITEM_TEXT → 回读校验
       ├─ 任一失败：RollBackToRevision() 连续 FN_UNDO
       └─ 返回 {revision, cells?, caret}
  → 响应 {id, ok:true, result} 原路返回
  → MCP 返回 text(JSON) 给模型
```

### 例：`ui_apply_batch`（改界面）

```
TS 端读 .eui.json → 校验 sha256 revision → 应用 upsert/remove/bind → 原子写回
  → client.call("ui.open", {path}) 通知 IDE 设计器重新加载并刷新
```

### 例：`build_run`（运行）

```
tools.ts → deployRuntime()（把 eui_runtime.dll 复制到工程目录）
  → client.call("build.run", {expectedRevision})
  → ide_api: VerifyCodeRevision → FN_COMPILE_AND_RUN
  → 生成的 .e 里 EUI_RunA 加载 .eui.json，创建 Win32 窗口
  → 事件回调写 %TEMP%\eui-runtime-events.jsonl
  → 模型可再用 ui_get_event_trace 验证事件是否真正触发
```

---

## 6. 总结

该项目的“原理”可归纳为四层解耦：

1. **协议层**：标准 MCP（stdio + JSON-RPC 工具注册）。
2. **通信层**：Windows 命名管道承载自定义 JSON 请求，隔离 Node 与 IDE 进程。
3. **IDE 操作层**：注入式 C++ 支持库，只用官方 SDK 接口操作 IDE，配合 revision + 回读 + 撤销保证安全。
4. **能力扩展层**：`.eui.json` 旁路文档 + `eui_runtime.dll` 运行库实现可视化界面；x86 Rust cdylib 通过一层 C++ 适配把 222 条现代工具命令（加密/压缩/正则/网络/图片…）接入易语言。

因此它既不是“键鼠脚本”，也不是“二进制逆向”，而是一套**官方 API + 独立数据文件 + 原生扩展**的工程化集成方案。

---

## 7. 专题：代码是怎么写入的（深入）

> 一句话：**不写 `.e` 文件，也不做整段文本导入；而是把易语言“代码表”当成一个行列网格，先把 IDE 光标移动到目标单元格，再调用官方“设置当前单元格文本”接口，最后回读校验。**

### 7.1 代码表模型（行列网格）

`FN_GET_PRG_TEXT` 读出来的每个 `ProgramCell` 有：`row`、`column`、`type`、`title`、`text`。

- 行 = 逻辑代码行；列 = 该行的语义槽位（列 0 一般是名字/结构关键字，后面列放返回类型、参数类型、语句等）。
- `type` 是易语言 SDK 的 `VT_*` 常量，表示该槽位的语义：
  - 结构名：`VT_MOD_NAME`(模块)、`VT_SUB_NAME`(子程序)、`VT_DLL_CMD_NAME`(DLL 命令)
  - 子项：`VT_SUB_ARG_NAME`(参数名)、`VT_SUB_VAR_NAME`(局部变量)、`VT_GLOBAL_VAR_NAME`(全局变量)、`VT_SUB_PRG_ITEM`(语句)
  - 字段：`VT_SUB_RET_TYPE`(返回值类型)、`VT_DLL_CMD_RET_TYPE`、`VT_DLL_LIB_FILE_NAME`、`VT_DLL_CMD_IN_LIB_NAME`、`VT_DLL_CMD_ARG_NAME/TYPE`
- 读取要**两次调用** `FN_GET_PRG_TEXT`：第一次 `m_pBuf=null, m_nBufSize=0` 只问“需要多大缓冲”，分配缓冲后第二次才把文本读出来；同时得到 `m_nType`、`m_blIsTitle`(是否标题行)。

### 7.2 写入原语：定位光标 + 官方设置文本

```cpp
void SetProgramCellText(int row, int column, const std::string& utf8_text, bool compile) {
    const auto wide_text = eui::Utf8ToWide(utf8_text);   // UTF-8 -> UTF-16
    const auto ansi_text = eui::WideToAnsi(wide_text);   // UTF-16 -> GBK(CP_ACP)
    if (!MoveCaretToCell(row, column)) throw ...;        // 1) 先把光标移到目标格
    if (!RunIdeFunction(FN_SET_AND_COMPILE_PRG_ITEM_TEXT, // 2) 官方接口写“当前格”
            (DWORD)ansi_text.c_str(), compile ? TRUE : FALSE)) throw ...;
    PumpIdeMessages();                                   // 3) 泵 IDE 消息，让界面刷新
    // 4) 回读该格，文本不一致就报错
    const auto cells = ReadProgramRow(row);
    const auto* applied = FindCell(cells, column);
    if (!applied || eui::WideToUtf8(eui::AnsiToWide(applied->text)) != utf8_text) throw ...;
}
```

**为什么必须先定位光标**：`FN_SET_AND_COMPILE_PRG_ITEM_TEXT` 的语义是“设置**当前光标所在**代码项的文本”，它不接受行列参数。所以要写某个格子，等价于“把光标移过去 + 写”。

`MoveCaretToCell` 的稳健做法：

1. 先试 `FN_MOVE_CARET(row, col)`，然后校验光标确实到达、且该行第一格 `type != 0`；
2. 不行就 `FN_MOVE_TOP` 回到顶部，再循环 `FN_MOVE_DOWN` 逐行走，走到目标行附近再 `FN_MOVE_CARET`。

> 原因：5.95 的代码网格只“物化”当前页附近的行，绝对跳转目标在当前页之外时可能失败，所以要用官方的“置顶 + 逐行下移”导航。

### 7.3 结构插入：官方插入命令 + 相对偏移填充

不能凭空写一个模块/子程序，必须先让 IDE 用官方命令建出空结构行：

```cpp
DWORD InsertFunctionForKind(kind) {
  module        -> FN_INSERT_NEW_MOD
  subprogram    -> FN_INSERT_NEW_SUB
  dllCommand    -> FN_INSERT_NEW_DLL_CMD
  argument      -> FN_INSERT_NEW_ARG
  localVariable -> FN_INSERT_NEW_LOCAL_VAR
  globalVariable-> FN_INSERT_NEW_GLOBAL_VAR
  statement     -> FN_INSERT_NEW
  statementAfter-> FN_INSERT_NEW_AT_NEXT
}
```

插入后光标停在新行，`code.batch` 就以它为基准，用 `rowOffset` / `column` **相对偏移**把名字、返回类型、参数名、参数类型等一格一格 `SetProgramCellText` 填进去。`InsertStructure` 还会对比插入前后，找出“新出现的、类型匹配的、空的”那一行，避免填错对象。

### 7.4 并发的三道保险

1. **修订号（乐观锁）**：`RevisionForCells()` 用 **FNV-1a 64 位**把整张代码表每个格子的 `text/type/title/坐标` 混成一个 16 位十六进制串。MCP 写工具都要求带 `expectedRevision`；`ReadAndVerifyCodeRevision()` 先读全表比对，不一致直接拒绝。
2. **写后回读**：每次 `Set` 后立刻读回，防止“IDE 没生效 / 光标跑偏”。
3. **失败整体回滚**：`code.batch` / `code.applyCurrent` 记录 `mutation_count`，任一步失败或回读不一致就 `RollBackToRevision()` 连续 `FN_UNDO` 回到初始 revision；回滚不彻底会明确报错。

### 7.5 类型校验

`VerifyCellKind(row, col, kind)` 把逻辑类型映射到 `VT_*` 后再比较：

```
module          -> VT_MOD_NAME
subprogram      -> VT_SUB_NAME
dllCommand      -> VT_DLL_CMD_NAME
argument        -> VT_SUB_ARG_NAME
localVariable   -> VT_SUB_VAR_NAME
globalVariable  -> VT_GLOBAL_VAR_NAME
statement/After -> VT_SUB_PRG_ITEM
```

类型不匹配就拒绝写，防止“往参数名格里写语句”这类越界。

### 7.6 MCP 侧的两个写入口

- `code_apply_current`：`edits:[{row,column,text,expectedKind?}]` → `code.applyCurrent`，按**绝对行列**改。
- `code_batch`：`operations:[{action:"edit",row,column,text,expectedKind?} | {action:"insert",kind,edits:[{rowOffset,column,text}]}]` → `code.batch`，支持“插结构 + 填内容”一次完成。
- `ui_sync_code` **不做文本导入**：它用 `code.findUnit("__EUI_生成")` / `code.findSymbol("_启动子程序")` 校验脚手架，再用 `code.applyCurrent` 把启动语句里的界面文件名改成当前 `.eui.json`。生成的 `.eui.generated.txt` 只是旁路产物，不会被导入 `.e`。

### 7.7 小结

写入 = **`FN_SET_AND_COMPILE_PRG_ITEM_TEXT`（改单元格文本）+ `FN_INSERT_NEW_*`（建结构）+ `FN_MOVE_*`/`FN_MOVE_CARET`（定位光标）+ `FN_GET_PRG_TEXT`（读取/回读）+ `FN_UNDO`（回滚）**，用 FNV-1a revision 做并发保护。全程操作的是 IDE 内存里的代码表，不碰 `.e` 二进制文件。

---

## 8. 官方支持库机制 & 已知不足

### 8.1 这确实走的是易语言「官方支持库」机制

是。它不是外挂，而是标准的易语言**支持库（FNE 插件）**：

- 用的是易语言 5.95 自带 SDK：`<EasyLangRoot>\sdk\cpp\elib\` 下的 `lib2.h`、`PublicIDEFunctions.h`、`lang.h`（`build-native.ps1` 从 GBK 转成 UTF-8 后编译）。
- `LIB_INFO` 里用 `LBS_IDE_PLUGIN` 标记自己是 **IDE 插件型支持库**，并通过 `PFN_NOTIFY_SYS` / `NES_RUN_FUNC` 调用官方 IDE 功能号（`FN_*`）。
- 安装到易语言 `lib\eide_bridge.fne`，用户在「工具 → 支持库配置」里手动勾选后由 IDE 加载。
- 所以它才能**不逆向、不模拟输入**地操作 IDE。

但要注意：官方 SDK 暴露的是**有状态的、偏底层**的接口（很多依赖“当前光标”“当前活动页”），并不是为外部自动化设计的稳定 API。代码里大量 `before/after` 对比、`TryInsertStructure` 重试、`FN_UNDO` 回滚，就是在给这些不确定行为兜底。

### 8.2 已知不足与缺点

#### A. 版本 / 平台强绑定
- 只针对 **易语言 5.95** + **Windows x86**（Rust 目标 `i686-pc-windows-msvc`）。换版本或换 64 位 IDE 就失效。
- 单个**已保存的活动工程**、单个启动窗口；管道名固定，无法同时连多个 IDE 实例。
- 从源码构建需 VS x86 Build Tools + Windows SDK + Rust；安装需一次管理员权限并手动勾选支持库。

#### B. 依赖“有状态光标”的固有缺陷
- 官方写接口只作用于**当前光标**，所以“写第 N 格”必须先移光标：读全表要 `FN_MOVE_TOP` + 逐行 `FN_MOVE_DOWN`（20 行/步），**慢**，且会**临时抢走用户光标**。
- 绝对行列不稳定：文档只物化当前页附近，跨页跳转可能失败；插入/删除会让行号漂移。
- 列号写死 `0..15`，依赖固定列布局。

#### C. 并发与一致性
- revision 是**整张代码表的 FNV-1a 哈希**：任何一处变化都让 revision 失效，写前必须重读全表；用户在 IDE 里手改一下，后续写就被拒。
- 没有真正的事务：回滚靠连续 `FN_UNDO`，如果用户中途编辑或撤销栈被干扰，回滚可能不彻底（代码会报错，但状态需要人工确认）。
- 同一时刻只能串行操作一个活动工程。

#### D. 不能做官方 API 没暴露的事
- 不做整段文本导入；**已有普通工程不能注入 UI 脚手架**，`ui_sync_code` 会直接拒绝，必须用 `windows-ui` 模板新建。
- `code_compact_current`（删空行）只给**只读预览**，因为官方撤销无法保证整批回滚，所以宁可不做。
- `structuredUiSync` 能力标记为 `false`。

#### E. 诊断弱
- 编译错误靠 `EnumChildWindows` 找 `edit/richedit` 子控件、取最长的 5 段文本，控件识别不了时只能返回编译成败，无 GUI 自助兜底。
- 工程路径靠解析 IDE 窗口标题（`ProjectPathFromTitle()`），未保存/标题格式不同就识别不了，需要 `E_LANGUAGE_ACTIVE_PROJECT` 环境变量兜底。

#### F. 编码边界
- MCP 侧 UTF-8 ↔ 易语言 ABI 侧 **GB18030(54936)/GBK(936)** ↔ Rust 侧 UTF-16/UTF-8。GB18030 无法表示的字符会被 `?` 替换，存在有损风险；Rust 也有 `from_utf16_lossy`。

#### G. UI 是“两套模型”
- 可视化界面用的是旁路文档 `.eui.json` + 自绘 Win32 运行库 `eui_runtime.dll`，**不是易语言原生窗口设计器**。
- 只支持 6 种控件（label/button/text/textarea/checkbox/combobox）和有限事件类型；外观/行为与原生组件不完全一致；`.eui.json` 与 `.e` 里的原生窗口可能不同步。

#### H. 安全 / 信任面
- FNE 是**注入 IDE 进程的原生 DLL**，拥有 IDE 全部权限；Rust 引擎从 FNE 同目录 `LoadLibraryW` 加载，存在 DLL 替换/劫持面。
- 命名管道仅用 SDDL 限制 SYSTEM+Owner，**同一用户下任意进程都可发请求**触发 IDE 操作，协议本身无额外鉴权/token。
- “写操作需批准”只是 Codex 的 `default_tools_approval_mode = "writes"` 配置，不是硬隔离。

#### I. 性能与可维护性
- 读一格要调两次 `FN_GET_PRG_TEXT`；读全表分页 + 每次写前重算 revision，大工程会明显变慢。
- `rust_common_support.cpp` 是 2000+ 行手写 FFI 样板 + 手写 `CMD_INFO` 表；C++ 侧还手写 `EscapeJson`。虽用 `static_assert` 保证 222 条数量一致，但易错、维护成本高。
- 引擎约 7000 行单文件 `lib.rs`，模块化偏弱。

#### J. 依赖 IDE 消息泵
- 管道请求通过 `SendMessage` 回到 IDE **UI 线程**执行。IDE 弹模态对话框/卡住时，调用会 10s 超时（`project.new` 用队列方式规避弹窗阻塞）。

### 8.3 一句话评价

这套方案的**最大优点**是“官方、可审查、不改二进制”；**最大代价**是绑死在易语言 5.95 的有状态官方接口上：慢、光标敏感、并发弱、能力受限于官方暴露的函数，并且需要用大量重试/回读/回滚来弥补 API 的不确定性。

---

## 9. 如果要写一套更优的方案（易语言闭源前提）

### 9.0 先认清约束：闭源下只有三类“合法入口”

1. **官方支持库/插件 SDK**（本项目走的路：`lib2.h` / `PublicIDEFunctions.h` / `FN_*`）。
2. **官方文本导入/导出**（是否存在且稳定需要验证；本项目把 `textProgramImport` 标成 `false`，很可能就是踩过坑）。
3. **官方编译器 / 易模块（`.ec`）**（本项目已在用：`easy-module/eui_module.txt` → `.e8` → `FN_COMPILE_WINDOWS_ECOM` → `eui.ec`）。

> 任何绕过这三条的路（逆向 `.e` 格式、Hook IDE、读内存、UIA/键鼠自动化）都属于“非官方”：能更强，但稳定性、安全性、合规性都会崩。

### 9.1 在官方入口内把架构做对（性价比最高）

#### 1. 从“无状态逐格操作”升级为“有状态文档模型”
- 现状：每次操作都重新读全表、移光标、写、回读、回滚。
- 更优：在 FNE 内维护一份代码表快照 + 增量模型，只在必要时刷新脏块。
- 收益：性能、并发粒度、可预测性全面改善。

#### 2. 分级 revision（Merkle / 分段哈希）替代整表 FNV-1a
- 现状：整表一个 hash，改一个字全表失效。
- 更优：按“模块/子程序”分段哈希再组合成树。
- 收益：冲突粒度到某个子程序，误报少，支持局部重读。

#### 3. 事务化：把一批操作合成一次 undo
- 现状：回滚靠连续 N 次 `FN_UNDO`，用户中途编辑会错乱。
- 更优：利用易语言已有的 block/undo 作用域（代码里已用 `FN_BLK_ADD_DEF`/`FN_BLK_CLEAR_ALL_DEF` 做行级操作），把整个 batch 包成一个块。
- 收益：真原子性、回滚可靠、`Ctrl+Z` 语义一致。

#### 4. 幂等 compare-and-set 写
- 现状：写后回读，不一致就报错，重试不安全。
- 更优：每格 CAS（带上期望旧值），重试天然安全。

#### 5. 操作规划：AST diff → 最小有序操作集
- 现状：调用方给绝对 `row/column`，插入/删除后行号漂移。
- 更优：把期望代码建成 AST，与当前模型 diff，生成“按行升序、移动最少”的计划，一次自顶向下扫描执行。
- 收益：减少光标移动与写次数，天然处理行漂移。

#### 6. 统一编码管线
- 现状：UTF-8→UTF-16→GBK，不可表示字符变 `?` 静默丢失。
- 更优：内部统一 UTF-8/UTF-16，只在边界转 GB18030；不可表示**显式报错**，不静默替换。

#### 7. 认证管道 + 版本协商 + 多实例
- 现状：管道名固定，SDDL 只限 SYSTEM/Owner，无 token，只能连一个 IDE。
- 更优：握手带随机 token/会话密钥；`protocolVersion` 能力协商；管道名带实例 ID 支持多 IDE。

#### 8. 引擎加载加固
- 现状：从 FNE 同目录 `LoadLibraryW`，存在 DLL 替换/劫持风险。
- 更优：绝对路径 + 哈希/签名校验后再加载。

#### 9. 多版本适配层
- 现状：硬编码 5.95。
- 更优：把 `FN_*` 差异封在 versioned adapter，声明能力矩阵，不支持的优雅降级。

#### 10. 更好的诊断
- 现状：`EnumChildWindows` 找 `edit` 控件读文本。
- 更优：若官方有“编译消息”回调就用回调；否则用稳定窗口类 + UIA **只读**；输出结构化的行/列/错误码。

### 9.2 单一真相源 + 代码生成，消灭 222 条命令的样板

把 222 条命令定义成**一份 IDL/manifest**（中文名、英文符号、参数类型、返回类型、Rust 符号、分类），用生成器产出：

- C++ `CMD_INFO`/`ARG_INFO` 表 + `extern "C"` 适配函数
- Rust `extern "system"` 导出与参数解包
- 文档（`扩展命令-使用说明.md`）

收益：消灭 `rust_common_support.cpp` 2000+ 行手写样板和“两边签名漂移”这类 bug；`static_assert` 只能保证数量一致，代码生成才能保证语义一致。

### 9.3 换一条更“干净”的路线：文本中间层 / 易模块

思路：**不“编辑代码表”，而“生成源码 → 编译产物”**。

- 利用官方的**文本 → 易模块（`.ec`）编译链**（项目已用它编译 222 命令模块），把业务代码也做成可生成的模块，用户工程只**引用**而不被逐格改写。
- UI 也统一：把 `.eui.json` **生成成易语言原生窗口代码**，丢掉并行的 `eui_runtime.dll` 自绘模型，消除“两套界面模型不同步”。
- 收益：可单测、可复现、可 diff、无光标依赖、速度快。
- 障碍：要验证官方文本导入是否无损/稳定（`textProgramImport=false` 很可能就是在避坑），以及有没有编译器 CLI。

### 9.4 越界方案：能做，但要付代价

| 方案 | 能获得什么 | 代价 |
|---|---|---|
| 逆向 `.e` 二进制格式 | 直接读写、可 headless、无需 IDE、速度最快 | 版本相关、易碎、法律/合规灰色、AV 误报 |
| 读取/Hook IDE 内存 | 拿到内部代码模型 | 极不稳定、随版本失效、被 AV 杀 |
| UIA / MSAA / 键鼠自动化 | 泛化好、不依赖插件 | 脆弱、慢、被本项目明确禁止 |
| 自写编译器/IDE | 完全可控 | 工程量巨大，需兼容 `.e` 生态 |

### 9.5 推荐演进路线

1. **短期（ROI 最高）**：官方通道内做 **增量模型 + 分级 revision + 事务化 + 幂等 CAS + 认证管道 + 加载加固**。
2. **中期**：**代码生成器**统一 222 条绑定；把引擎抽成可独立测试的 DLL/CLI（脱离 IDE 也能跑单测）。
3. **长期**：若官方文本导入 / 编译器 CLI 可用，转向 **headless “源码 → 编译产物”**，IDE 降级为可选预览；UI 改成生成原生窗口代码。

### 9.6 一句话

> 闭源下“更优”的正确方向不是“更巧妙地模拟”，而是：**把有状态、光标驱动的官方 API 包成一层“有文档模型、有事务、有分级版本、可重试”的抽象，并把能下沉的（222 命令、代码生成、UI 生成）尽量下沉到 IDE 之外、可测试的地方。**

---

## 10. 关于那 222 条扩展命令：到底干什么、有没有用

### 10.1 它们是什么

它们是给**易语言程序**用的一套“标准库”，以支持库命令形式暴露（左侧中文命令树，分 21 类）：文本/JSON/CSV/INI/TOML/YAML/文件/目录/路径/系统/时间/网络/压缩/正则/密码与密钥/TOTP/媒体/图片/工具。

代表命令：`文件_取SHA256`、`文本_取BLAKE3`、`密码_生成Argon2id`、`文本_AES256加密`、`文本_JWT_HS256生成`、`TOTP_取当前验证码`、`图片_生成二维码PNG`、`图片_取感知哈希`、`目录_查找相似图片JSON`、`文本_取字素数`、`文本_Unicode标准化NFC`、`JSON_生成差异补丁`、`文本_ZSTD压缩`、`工具_生成雪花ID`……

### 10.2 对“控制 IDE / MCP 桥接”来说：基本没用

驱动 IDE 只需要 `Codex_桥接状态` + 一批 `FN_*` 调用。把这 222 条全删掉，MCP 照样能读写代码、设计界面、编译运行。**它们与核心目标正交。**

### 10.3 对“用 AI 写易语言程序”来说：有用，且是刻意卖点

易语言生态的短板正好是这些：

- **现代密码学**（Argon2id/PBKDF2/AES-GCM/Ed25519/X25519/JWT/TOTP）：易语言圈里这类 DLL 多来源不明、不可审计，用 Rust 实现是实打实的加分。
- **Unicode 正确性**（字素/NFC/NFKC/单词边界）：易语言原生文本处理容易出错。
- **图片/二维码/感知哈希/相似图去重、Zstd、JSON pointer/patch/canonical/MessagePack/CBOR**：原生没有或很弱。

所以它是一套“batteries included”，让 AI 生成的程序能直接调用这些能力，README 也拿它当亮点。

### 10.4 但里面掺水不少

- 基本大小写/trim、简单路径/文件操作：易语言本来就有。
- 媒体播放：只是 MCI 包一层。
- CSV/INI/TOML/YAML：可留可去。
- MD5/SHA1：文档自己写了“只兼容、不用于安全”，属历史包袱。

高价值子集其实是：**密码学 + Unicode + 图片/二维码 + 压缩 + JSON**。

### 10.5 工程上的真正问题

1. **与核心目标耦合**：为了 222 条命令，桥接库必须捆绑 7000 行 Rust + 2000 行 C++ 适配，IDE 插件体积/审查面/构建复杂度都上去了。
2. **维护成本**：222×2 手写绑定（C++ 表 + Rust 导出），签名漂移风险，应用代码生成。
3. **攻击面**：222 个函数（含网络/文件/ZIP 解压/密码学）全部跑在 IDE 进程内，任一漏洞影响 IDE。
4. **定位模糊**：它本质上是一个独立的“易语言扩展标准库（`.ec`）”，却被塞进了 IDE 桥接支持库。

### 10.6 建议

- 只做 IDE 控制 → 砍掉 222 条，桥接更小更安全。
- 想兼做“AI 写易语言” → 保留高价值子集，**拆成独立的 `.ec` 模块 / 独立支持库**，与桥接解耦，独立版本、独立测试。
- 用一份 IDL 生成 C++/Rust 双端绑定（见 9.2）。

> 结论：“没用”对**桥接本身**成立；对**产品卖点**不成立。它更像一个捆绑销售的标准库，价值真实但放错了位置。

---

## 9. 如果要写一套更优的方案（易语言闭源前提下）

### 9.0 先认清：闭源下只有三条“官方通道”

1. **官方支持库 / IDE 插件 SDK**（本项目走的路：`lib2.h` / `PublicIDEFunctions.h` / `FN_*`）。
2. **官方文本导入 / 导出**（若存在且稳定；本项目把 `textProgramImport` 标为 `false`，说明它知道这个能力但有意不用）。
3. **官方编译器 / 易模块（`.ec`）产出**（本项目已用：`easy-module/eui_module.txt` → `.e8` → `FN_COMPILE_WINDOWS_ECOM` → `eui.ec`）。

> 闭源意味着：**任何绕过这三条的方案（逆向 `.e` 格式、读内存、Hook、UIA/键鼠自动化）都是“非官方”的——能力可能更强，但稳定性、安全性、可维护性、合规性都会大幅下降。**

### 9.1 在“官方通道”内把架构做对（收益最大、风险最低）

| 改进 | 现状问题 | 更优做法 |
|---|---|---|
| **增量文档模型** | 每次写前重读全表 | FNE 内缓存代码表，监听/标记脏区，只重读改动块 |
| **分级 revision（Merkle）** | 整表 FNV-1a，一处改动全表失效 | 按“模块/子程序”分块哈希再组合；冲突粒度到代码单元 |
| **操作计划（AST diff）** | 逐格 row/col，绝对行号 | 把目标代码建成 AST，与当前模型 diff，生成**最小、按行升序**的操作序列，单次自上而下扫描完成 |
| **事务化** | 失败靠 N 次 `FN_UNDO` | 用官方 undo 块（`FN_BLK_ADD_DEF`/`FN_BLK_CLEAR_ALL_DEF` 已存在）包住整批，回滚 = 一次 Undo |
| **幂等 CAS 写** | 写后回读报错，无法安全重试 | 每格 `compare-and-set`（带上期望旧值），重试天然安全 |
| **统一编码管线** | GB18030 不可表示会用 `?` 静默丢失 | 内部统一 UTF-8/UTF-16，边界转 GB18030；不可表示就**显式报错**而不是替换 |
| **认证管道 + 版本协商** | SDDL 仅限 Owner，无 token | 握手带随机 token/会话密钥，做 `protocolVersion`/能力协商，优雅降级 |
| **单实例 + 多工程** | 管道名固定，只能一个 IDE | 管道名带 PID/实例 ID，支持多实例路由 |
| **引擎加载加固** | 同目录 `LoadLibraryW`，可被替换 | 绝对路径 + 哈希/签名校验后再加载 |
| **多版本适配层** | 硬绑 5.95 | 把 `FN_*` 差异封在 versioned adapter 里 |
| **更好的诊断** | 枚举 edit 控件取最长 5 段 | 若官方有编译消息回调就用回调；否则用稳定窗口类 + UIA **只读**；输出结构化到行/列/错误码 |

### 9.2 代码生成的“单一真相源”与代码生成（高价值）

- 把 222 条命令定义成**一份 IDL/清单**（中文名、英文名、参数类型、Rust 符号、分类），用代码生成器同时产出：
  - C++ `CMD_INFO`/`ARG_INFO` 表 + `extern "C"` 适配函数
  - Rust `extern "system"` 导出与参数解包
  - 文档（`扩展命令-使用说明.md`）
- 收益：消灭 `rust_common_support.cpp` 2000+ 行手写样板和“两边签名漂移”的整类 bug；`static_assert` 只能保证数量，生成器能保证一致性。

### 9.3 换一条更“干净”的路线：文本中间层 / 易模块

思路：**不再“编辑代码表”，而是“生成源码 → 编译成产物”**。

- 利用官方的**文本 → 易模块（`.ec`）编译链路**（项目已用它编译 222 命令模块），把业务代码也做成可生成的模块，用户工程只“引用”而不被逐格改写。
- 用目标工程模板 + 生成的模块/启动代码，而不是增量单元编辑。
- UI 也统一：把 `.eui.json` **生成成易语言原生窗口代码**，丢掉并行的 `eui_runtime.dll` 自绘模型（消除“两套界面模型不同步”）。
- 好处：可单元测试、可复现、可 diff、无光标依赖、速度快。
- 障碍：要验证官方文本导入是否无损/稳定，以及是否有可用的编译器 CLI；若文本导入是“陷阱”（本项目把 `textProgramImport=false` 很可能就是因为踩过坑），则只在模块编译这条链路上做。

### 9.4 越界方案（能做，但要付代价）

| 方案 | 能获得什么 | 代价 |
|---|---|---|
| 逆向 `.e` 二进制格式 | 直接读写、可 headless、无需 IDE、速度最快 | 版本相关、易碎、法律/合规灰色、AV 误报 |
| 读取/Hook IDE 内存 | 拿到内部代码模型 | 极不稳定、随版本失效、被 AV 杀 |
| UIA / MSAA / 键鼠自动化 | 泛化好、不依赖插件 | 脆弱、慢、被本项目明确禁止 |
| 自写编译器/IDE | 完全可控 | 工程量巨大，需兼容 `.e` 生态 |

### 9.5 推荐的演进路线

1. **短期（ROI 最高）**：官方通道内做 **增量模型 + 分级 revision + 事务化 + 幂等 CAS + 认证管道 + 加载加固**。
2. **中期**：**代码生成器**统一 222 条绑定；把引擎抽成可独立测试的 DLL/CLI（脱离 IDE 也能跑单测）。
3. **长期**：若官方文本导入 / 编译器 CLI 可用，转向 **headless “源码 → 编译产物”**，IDE 降级为可选预览；UI 改成生成原生窗口代码。

### 9.6 一句话

> 闭源下“更优”的正确方向不是“更巧妙地模拟”，而是：**把有状态、光标驱动的官方 API 包成一层“有文档模型、有事务、有分级版本、可重试”的抽象**，并把能下沉的（222 命令、代码生成、UI 生成）尽量下沉到 IDE 之外、可测试的地方。
