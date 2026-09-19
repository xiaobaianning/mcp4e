# 易语言 MCP（MVP）

让任意 MCP 客户端（Codex / Claude Desktop / Cursor 等）**读取和修改易语言 5.95 工程里的代码**。

- 只走**官方支持库（FNE）+ 官方 IDE 功能号（`FN_*`）**，不逆向、不模拟键鼠、不改 `.e` 二进制。
- 极简实现，只做「读代码 + 写代码 + 保存/编译/运行」，不含 UI 设计器，也不含那 222 条扩展命令。
- 目标易语言版本：本机 `D:\software\eyy`（5.95）。SDK 头文件以本机 `sdk\cpp\elib` 为准。

---

## 架构

```
MCP 客户端
   │ stdio + MCP JSON-RPC
   ▼
server/  (Node.js + TypeScript, @modelcontextprotocol/sdk)
   │ Windows 命名管道 \\.\pipe\e-lang-code-mcp，每行一条 JSON
   ▼
fne/  (C++ 支持库 elang_mcp.fne，注入易语言 IDE 进程)
   │ 官方 PFN_NOTIFY_SYS / NES_RUN_FUNC
   ▼
易语言代码表（FN_GET_PRG_TEXT 读 / FN_SET_AND_COMPILE_PRG_ITEM_TEXT 写）
```

关键点：IDE 的 `FN_*` 只能在 **UI 线程**调用，所以管道线程收到请求后用
`SendMessage` 把请求派发回 UI 线程上的隐藏窗口执行。

---

## 目录结构

```
e-lang-code-mcp/
├─ fne/                         # C++ 支持库（VS 工程，Win32）
│  ├─ elang_mcp.sln / .vcxproj
│  ├─ elang_mcp.def
│  ├─ generated-sdk/            # 构建时由 SDK 头文件生成（UTF-8）
│  └─ src/
│     ├─ mini_json.hpp          # 自带的极简 JSON（无需第三方库）
│     ├─ bridge.cpp             # GetNewInf / LIB_INFO / 命令表 / IDE 通知
│     ├─ pipe_server.cpp        # 命名管道 + UI 线程派发
│     ├─ ide_api.cpp            # 读/写/导航/保存/编译/诊断
│     └─ ide_api.h
├─ server/                      # MCP 服务（TypeScript）
│  ├─ package.json / tsconfig.json
│  └─ src/
│     ├─ index.ts
│     ├─ pipe-client.ts
│     └─ tools.ts
└─ scripts/
   ├─ build-native.ps1          # 转换 SDK 头文件 + 编译 FNE
   └─ install.ps1               # 安装支持库 + 注册 MCP
```

---

## 环境要求

- Windows 10/11 x64
- 易语言 5.95（本机 `D:\software\eyy`），且包含 `sdk\cpp\elib\lib2.h`、`PublicIDEFunctions.h`、`lang.h`
- Visual Studio 2019/2022，勾选 **“使用 C++ 的桌面开发”**（必须含 **x86** 工具集，因为易语言是 32 位）
- Node.js 20+
- 一个 MCP 客户端（Codex CLI / Claude Desktop / Cursor 等）

> `fne` 必须编成 **Win32（x86）**，否则易语言无法加载。

---

## 构建与安装

### 0. 一键安装（推荐）

双击 **`e-lang-code-mcp\一键构建安装.bat`**，它会依次完成：

1. 编译支持库（`fne\dist\elang_mcp.fne` + `eui_runtime.dll`）
2. `npm install` + 打包 MCP 服务（`server\dist\server.mjs`）
3. 安装到易语言 `lib\`，并注册 MCP 服务（`e-lang`）

> ⚠ 运行前请**保存并关闭易语言**（`lib\elang_mcp.fne` 被占用时无法覆盖）。

安装完还需要**一次性手工操作**：

- 打开易语言 → **工具 → 支持库配置** → 勾选 **「易语言 MCP 桥接支持库」** → 重启易语言
- （如果要让 AI 新建界面工程）确认 `templates\windows-ui.e` 存在 —— 缺了就按 [`templates/README.md`](templates/README.md) 两分钟做一个

### 1. 手动分步安装

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File .\scripts\build-native.ps1 -EasyLangRoot "D:\software\eyy"
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1   -EasyLangRoot "D:\software\eyy"
```

> 安装前先保存并关闭易语言（`lib\elang_mcp.fne` 被占用时无法覆盖）。
> 覆盖已有文件需加 `-Force`。若 VS 平台工具集不是 v143，改 `fne\elang_mcp.vcxproj` 里的 `<PlatformToolset>`。

然后打开易语言 → **工具 → 支持库配置** → 勾选 **“易语言 MCP 桥接支持库”** → 重启易语言。

### 2. 构建 MCP 服务

```powershell
cd server
npm install
npm run bundle     # 生成 dist\server.mjs（单文件）
```

### 3. 注册到 MCP 客户端

Codex CLI：

```powershell
codex mcp add e-lang -- node "E:\mcp4e\e-lang-code-mcp\server\dist\server.mjs"
```

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "e-lang": { "command": "node", "args": ["E:\\mcp4e\\e-lang-code-mcp\\server\\dist\\server.mjs"] }
  }
}
```

---

## 提供的 MCP 工具

| 工具 | 作用 |
|---|---|
| `ide_status` | 桥接是否连上 IDE |
| `project_get_active` | 当前工程路径 + 代码修订号 |
| `code_read_current` | 读取当前代码表 |
| `code_read_range` | 读取指定行范围 |
| `code_apply_current` | 按行列修改代码（带 revision 校验 + 回滚） |
| `code_batch` | 批量“结构插入 + 单元格修改”（失败整批回滚） |
| `code_undo` | 撤销上一次代码改动（官方 `FN_UNDO`） |
| `code_move` | 移动代码光标（官方导航接口） |
| `project_save` | 官方保存 |
| `build_compile` / `build_run` / `build_stop` | 编译 / 运行 / 停止 |
| `build_get_diagnostics` | 只读采集编译输出（含 `output` 全文与 `newOutput` 本次增量） |
| **`lib_find_command`** | **★ 写代码前先调这个**：一次同时搜 `.fne` 支持库 + `.ec` 易模块，返回可直接抄写的命令签名 |
| `lib_search_commands` | 按关键词搜 **`.fne` 支持库**命令（命令名 + 参数 + 类型） |
| `lib_search_ecom_commands` | 按关键词搜 **`.ec` 易模块**命令，返回现成签名 + 参数 + 类型 |
| `lib_list_libraries` / `lib_list_ecoms` | 列出已加载的支持库 / 易模块 |
| `lib_list_trees` / `debug_dump_windows` / `lib_inspect_ecom` | 调试：命令树、窗口树、`.ec` 十六进制 |
| `code_undo` | 撤销上一次代码改动 |

### 推荐工作流（AI 视角）

```
0. 写任何功能代码之前 —— 先 lib_find_command 搜现成命令        ← 第一原则
1. 新建界面工程      project_new { type: "windows-ui", path: "E:\\work\\app.e" }
2. 设计界面          ui_apply_batch     （控件 + 事件绑定 handler）
3. 自动接线          ui_sync_code       （DLL 声明 / 脚手架 / 事件分派 / handler 空子程序）
4. 跑起来            ui_run             （部署 DLL → 编译 → 运行）
5. 只填业务逻辑      code_apply_current / code_batch（往 handler 里写）
```

> 第 0 步是**硬规则**，已写进 MCP 的 `initialize.instructions`：
> 优先调用支持库 / 已导入易模块里的现成命令，确实搜不到才自己写（兜底）。
> 新加的工具 `lib_find_command` 一次同时搜 `.fne` + `.ec`，把“守规则”的成本降到一次调用。

### 典型用法

1. `project_get_active` 拿到 `revision`。
2. `code_read_current` 读取代码（也会返回 `revision`）。
3. 用 `code_apply_current` / `code_batch` 修改，**必须带上刚读到的 `expectedRevision`**。
4. `project_save` 或 `build_run`。

---

## UI 界面（阶段 1：界面文档管理）

原生窗体设计器**无法**通过官方 API 增删控件，因此界面走**平行系统**：

```
<工程>.eui.json   ← 声明式界面文档（UTF-8，可审查，与 .e 同目录）
      │
      ├─ MCP 工具读写（阶段 1，已完成）
      └─ eui_runtime.dll 运行时渲染窗口（阶段 2，待做）
```

支持的控件：`label` / `button` / `text` / `textarea` / `checkbox` / `combobox`；事件：`created` / `closing` / `timer` / `click` / `textChanged` / `checkedChanged` / `selectionChanged`。

### 阶段 1 工具（纯 TypeScript，已可用）

| 工具 | 作用 |
|---|---|
| `ui_get_document` | 读取 `.eui.json` + 修订号（sha256） |
| `ui_attach` | 为当前工程创建同名 `.eui.json` |
| `ui_set_form` | 改窗体标题/尺寸/可缩放 |
| `ui_upsert_control` | 新增/更新一个控件 |
| `ui_apply_batch` | 批量 增/改/删 + 绑事件 |
| `ui_remove_control` | 删控件 |
| `ui_bind_event` | 把控件事件绑到处理子程序 |
| `ui_sync_code` | 一键写脚手架：DLL 声明 + 启动/回调子程序 + 入口调用 + 按 `.eui.json` **自动生成事件分派** |
| `ui_run` | 部署 `eui_runtime.dll`（IDE 目录 + 工程目录）→ 编译 → 运行 |
| `project_new` | 从 `windows-ui.e` 模板新建工程（**不往已有老工程注入脚手架**） |

用法：`ui_attach` → `ui_get_document` 拿 `revision` → `ui_apply_batch`（带 `expectedRevision`）。

### 逄段进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | `.eui.json` 界面文档管理 | ✅ |
| 2 | `eui_runtime.dll`：读 `.eui.json` → 建 Win32 窗口与控件 → 事件回调 | ✅ |
| 3 | `ui_sync_code`：一键写入启动/事件回调子程序 + 参数 + 语句（幂等） | ✅ |
| 4 | `ui_run`：部署 `eui_runtime.dll` + 编译 + 运行 | ✅ |
| 5 | `project_new`：从 `windows-ui.e` 模板新建工程（不注入已有工程） | 🚧 代码已写，模板待制作 |

### 阶段 3 用法

`ui_sync_code`（桥接 `code.syncUiScaffold`）在**当前程序集**里确保存在：

- 子程序 `EUI_启动界面`，内含一行
  `EUI_MCP_RunA (取运行目录 () ＋ “\<工程名>.eui.json”, &EUI_事件回调)`
- 子程序 `EUI_事件回调`，含 3 个整数型参数：`控件编号` / `事件代码` / `事件文本指针`
- 入口子程序（`_启动子程序` 或 `__启动窗口_创建完毕`）里的一行 `EUI_启动界面 ()`

已存在则改写而不是插第二条（幂等）。
**DLL 声明默认不写**（`syncDllCommands` 默认 `false`）—— 原因见下一节。

若结构写入失败，结果里会带 `codeError` + `manualSteps`。

---

## 结构插入 API 的真实语义（实测，重要）

易语言的 `FN_INSERT_NEW_*` **和文档描述不一致**，以下是踩坑结论：

- ✅ **`FN_INSERT_NEW`（`FNST_MODIFY|1`）才是好用的那个**：语义是
  *“在光标所在行插入一个与当前行**同类型**的新单元，光标留在新单元上，下面的行整体下移”*。
  - 在 851（语句）行上插入 → 新的空白 851；在 686（子程序）行上插入 → 新的 686。
  - 所以**锚点行必须是目标同类型行**。
- ⚠️ **新子单元不是空文本**：新子程序默认叫 `子程序`，新参数也有默认名。
  所以判定“插入成功”要依据 **类型匹配 + 表格行数确实增加**，不能用“文本为空”。
- ❌ **`FN_INSERT_NEW_MOD` / `FN_INSERT_NEW_SUB` 在某些上下文里会静默失败，并把光标甩到第 0 行**。
  失败后如果只在循环外定位一次光标，后续尝试就全在错误位置 —— 必须在**每次尝试前重新定位光标**。
- ❌ **`FN_IS_FUNC_ENABLED` 报可用 ≠ 真的能用**：`insertNewMod` 报 1，实际插不出程序集。
- ℹ️ **新参数插在参数区最上面**，所以要**倒序插入**才能得到期望的顺序。
- ℹ️ **`FN_EXTEND_ALL_SUB`（`FNST_OTHER|57`）**：子程序默认是**收缩**的（看不到参数区），
  必须先展开才能拿到“参数标题行”，然后在标题行上插入参数。
- ℹ️ 读全表（`ReadCurrentCells`）会移动光标；**插入后不要立即做全表读取**，直接用光标位置写入。

结论：本项目**不新建程序集**（复用工程里已有的第一个），
只用 `FN_INSERT_NEW` 在同类锚点行上插入子程序 / 语句 / 参数。

---

## 活动视图：必须停在「程序集」（重要）

所有代码表操作（`FN_GET_PRG_TEXT` / `FN_SET_AND_COMPILE_PRG_ITEM_TEXT` / `FN_MOVE_*`）都作用于
**当前活动文档**。如果活动文档是 `DLL命令` / `数据类型` / `常量` 等，代码操作**全部失效**
（表现为“当前工程里没有任何程序集”）。

实测结果：

- ✅ `FN_VIEW_DATA_TYPE_TAB`(=2) / `FN_VIEW_GLOBAL_VAR_TAB`(=3) / `FN_VIEW_DLLCMD_TAB`(=4) /
  `FN_VIEW_CONST_TAB`(=6) / `FN_VIEW_PIC_TAB`(=7) / `FN_VIEW_SOUND_TAB`(=8) 都能**可靠切换**。
- ❌ **官方没有 `FN_VIEW_PRG_TAB`**（程序集=1、窗体设计=5），也没有其它 API 能切回去：
  `FN_MOVE_NEXT_UNIT` / `FN_MOVE_PREV_UNIT` / `FN_MOVE_SPEC_SUB` / `FN_MOVE_BACK_SUB` /
  `FN_MOVE_OPEN_SPEC_SUB` / `FN_RELINK` / `FN_GOTO_LAST_MODI_PLACE` /
  `FN_CLOSE_FILE` + `FN_OPEN_FILE2` —— 实测**全部无效**。
- 视图是**全局**的（不是每个工程一份），且会跨 IDE 重启保留。

因此本项目采取三条约束：

1. `SyncUiScaffold` 开头调 `EnsureCodeView()`（用 `FN_MOVE_NEXT/PREV_UNIT` 尽力而为），
   拿不到「程序集」就 **明确报错**，绝不静默失败。
2. **默认不写 DLL 命令表**（`syncDllCommands` 默认 `false`）—— 因为 `SyncDllCommands`
   会把视图切到 DLL 命令表且**无法自动切回**。DLL 声明交给 `windows-ui.e` 模板一次性写好。
3. 确实要写时显式传 `syncDllCommands: true`，并接受“之后需手动点回「程序」标签”。

> 实践结论：打开易语言后让它停在「程序」标签（视图会被记住），之后所有工具都不会再把视图切走。

---

## 代码写入原理（一句话）

不写 `.e` 文件，而是：**先把光标移到目标单元格（官方 `FN_MOVE_CARET`），
再调用官方 `FN_SET_AND_COMPILE_PRG_ITEM_TEXT` 写入该格文本，然后回读校验**；
插入结构用官方 `FN_INSERT_NEW_*`；并发用代码表 FNV-1a 修订号保护；失败用 `FN_UNDO` 回滚。

---

## 本机 SDK 适配说明

`FN_*` 都是宏，直接用头文件里的名字，不需要硬编码数字。当前 5.95 头文件推导出的
`VT_*` 单元格类型（用于 `expectedKind` 校验）：

| 含义 | 常量 | 值 |
|---|---|---|
| 模块名 | `VT_MOD_NAME` | 580 |
| 子程序名 | `VT_SUB_NAME` | 686 |
| 子程序返回值类型 | `VT_SUB_RET_TYPE` | 687 |
| 参数名 | `VT_SUB_ARG_NAME` | 740 |
| 参数类型 | `VT_SUB_ARG_TYPE` | 741 |
| 局部变量 | `VT_SUB_VAR_NAME` | 796 |
| 全局变量 | `VT_GLOBAL_VAR_NAME` | 367 |
| 语句 | `VT_SUB_PRG_ITEM` | 851 |
| DLL 命令名 | `VT_DLL_CMD_NAME` | 51 |

关键功能号（供排查用）：

| 功能 | 宏 |
|---|---|
| 读单元格 | `FN_GET_PRG_TEXT`（`FNST_ADDIN | 10`） |
| 写当前单元格 | `FN_SET_AND_COMPILE_PRG_ITEM_TEXT`（`FNST_MODIFY | 113`） |
| 光标行列 | `FN_GET_CARET_ROW_INDEX` / `FN_GET_CARET_COL_INDEX` |
| 移动光标 | `FN_MOVE_CARET` / `FN_MOVE_TOP` / `FN_MOVE_DOWN` |
| 插入结构 | `FN_INSERT_NEW_MOD/SUB/DLL_CMD/ARG/LOCAL_VAR/GLOBAL_VAR/NEW/NEW_AT_NEXT` |
| 撤销 | `FN_UNDO` |
| 保存/打开 | `FN_SAVE_FILE` / `FN_OPEN_FILE2` |
| 编译/运行/停止 | `FN_COMPILE` / `FN_COMPILE_STATIC` / `FN_COMPILE_AND_RUN` / `FN_END_RUN` |

---

## `.ec` 易模块格式（逆向解析说明，供以后维护）

`.ec` 是易语言**私有二进制格式**，官方未公开；为了读取易模块（如精易模块）的**命令与参数**，本项目按下面的结构解析（已验证于易语言 5.95）。

- **字节序**：小端。文件以魔数 `CNWTEPRG` 开头。
- **普通字符串**：`[4 字节长度 L][L 字节 GBK 文本]`。
- **参数记录**：`[4 字节长度 L][4 字节类型码][3 字节][名字(L-9 字节)][2 字节]`。
  - 名字紧跟在 `L 字段 + 4 + 3` 之后，长度固定为 `L - 9`。
  - 例：`11 00 00 00 | 01 03 00 80 | 00 00 00 | B6 D4 CF F3 BE E4 B1 FA | 00 00` = 参数 `对象句柄 : 整数型`。
- **命令记录**：命令名本身是普通字符串，且其 **长度字段之前 4 字节是返回类型码**（据此识别为命令）。
- **命令/参数归属**：按文件顺序 —— 参数记录紧跟在其命令之后（中间可能隔着说明文本）。

### 类型码（`SDT_*`）

易语言 `SDT_*` 为 `MAKELONG(MAKEWORD(a,b), 0x8000)`：

| 类型 | 值 | 类型 | 值 |
|---|---|---|---|
| 字节型 | `0x80000101` | 逻辑型 | `0x80000002` |
| 短整数型 | `0x80000201` | 日期时间型 | `0x80000003` |
| 整数型 | `0x80000301` | 文本型 | `0x80000004` |
| 长整数型 | `0x80000401` | 字节集 | `0x80000005` |
| 小数型 | `0x80000501` | 子程序指针 | `0x80000006` |
| 双精度小数型 | `0x80000601` | 语句 | `0x80000008` |

### 文本校验（过滤噪声）

`.ec` 的代码段可能被加密/压缩，随机字节会被误当成 GBK 汉字。因此只接受：

- ASCII 可打印字符，或
- **GB2312 常用汉字**：引导字节 `0xA1–0xF7`，尾字节 `0xA1–0xFE`（GBK 扩展区的生僻字一律拒绝）。

### 能力边界

- 能可靠拿到：**命令名、参数名、参数类型、说明、引用的 DLL 命令**。
- 拿不到：命令的**实现代码**（若在加密段），以及模块的完整调用顺序细节。
- 换易语言大版本时，类型码或记录布局可能变化，需重新校准。

对应实现：`fne/src/ide_api.cpp` 中的 `ReadEcomStrings`（结构解析）与 `SearchEcomCommands`（搜索/归组/生成签名）。

---

## 已知限制

- 只针对易语言 **5.95** + **Windows x86**，换版本可能要改 `FN_*`/`VT_*`。
- 官方接口是**有状态、光标驱动**的，所以写代码会移动光标；大量改动较慢。
- 代码表只“物化”当前页附近的行，读全表要分页扫描。
- 编码边界是 GBK/GB18030，无法表示的字符会被替换。
- 编译诊断靠枚举 IDE 子控件文本，不总是可靠。
- 不管并发编辑：写操作靠 `expectedRevision` 拒绝过期覆盖。

---

## 排错

| 现象 | 处理 |
|---|---|
| `ENOENT` / “桥接调用超时” | 易语言没开，或没勾选支持库，或改了管道名 |
| `No such file ... elang_mcp.fne` | 未运行 `install.ps1`，或易语言 `lib` 目录不对 |
| 编译报头文件错误 | 先运行 `build-native.ps1` 生成 `generated-sdk`；确认 VS 是 x86 工具集 |
| `revision mismatch` | 期间有人在 IDE 里改了代码，重新读一次再写 |
| DLL 被占用无法覆盖 | 关闭易语言后重装 |
