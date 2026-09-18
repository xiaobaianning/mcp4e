# 易语言 MCP（mcp4e）

让任意 MCP 客户端（Codex / Claude Desktop / Cursor 等）**直接读写易语言 5.95 的代码，并用平行体系跑界面**。

- 只走**官方支持库（FNE）+ 官方 IDE 功能号（`FN_*`）**：不模拟键鼠、不逆向 `.e` 二进制、不 hook。
- 界面走 `.eui.json` 旁路文档 + `eui_runtime.dll` 运行时渲染（原生窗体设计器没有可用的增删控件 API）。
- 极简实现：C++ 只编一个支持库，服务端是单文件 Node.js bundle。

---

## 目录结构

```
mcp4e/
├─ e-lang-code-mcp/                # 项目本体
│  ├─ fne/                         # C++ 支持库（VS 工程，Win32 x86）
│  │  ├─ src/ide_api.cpp           # 读/写/导航/结构插入/脚手架
│  │  ├─ src/bridge.cpp            # GetNewInf / LIB_INFO / 命令表 / IDE 通知
│  │  ├─ src/pipe_server.cpp       # 命名管道 + UI 线程派发
│  │  ├─ src/eui_runtime.cpp       # 界面运行时（读 .eui.json 建 Win32 窗口）
│  │  └─ elang_mcp.sln
│  ├─ server/                      # MCP 服务（TypeScript）
│  ├─ scripts/                     # 构建 / 安装 / 调试脚本
│  ├─ templates/                   # 工程模板（project_new 用，见目录内 README）
│  └─ *.bat                        # 一键构建、桥接测试、dump 代码表等
├─ MCP工具实现原理.md               # 实现原理与踩坑记录
└─ 易语言MCP从零实现指南.md
```

---

## 快速开始

```powershell
# 1) 编译支持库 + 打服务端 bundle + 安装（需要先关闭易语言）
cd e-lang-code-mcp
.\一键构建安装.bat

# 2) 打开易语言 → 工具 → 支持库配置 → 勾选「易语言 MCP 桥接支持库」

# 3) 注册到 MCP 客户端（install.ps1 已自动注册 Codex）
codex mcp add e-lang -- node "E:\mcp4e\e-lang-code-mcp\server\dist\server.mjs"
```

---

## 提供的 MCP 工具

| 分类 | 工具 |
|---|---|
| 状态 | `ide_status`、`project_get_active`、`project_new` |
| 代码 | `code_read_current`、`code_read_range`、`code_apply_current`、`code_batch`、`code_move`、`code_undo` |
| 编译 | `build_compile`、`build_run`、`build_stop`、`build_get_diagnostics` |
| **库搜索** | `lib_search_commands`（`.fne`）、`lib_search_ecom_commands`（`.ec`）、`lib_list_libraries`、`lib_list_ecoms`、`lib_inspect_ecom` |
| 界面 | `ui_attach`、`ui_get_document`、`ui_set_form`、`ui_upsert_control`、`ui_apply_batch`、`ui_remove_control`、`ui_bind_event`、`ui_sync_code`、`ui_run` |

亮点是**按需搜索**：`.fne` 支持库命令、以及**字节级解析 `.ec` 易模块**拿到命令名/参数名/参数类型，不用把整库塞进上下文。

---

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | `.eui.json` 界面文档管理 | ✅ |
| 2 | `eui_runtime.dll` 运行时渲染 + 事件回调 | ✅ |
| 3 | `ui_sync_code` 一键写脚手架（幂等） | ✅ |
| 4 | `ui_run`：部署 DLL + 编译 + 运行 | ✅ |
| 5 | `project_new` + `windows-ui` 模板 | 🚧 |

---

## 已知限制

- 只针对易语言 **5.95** + **Windows x86**。
- 官方接口是**有状态、光标驱动**的；结构插入 API 的语义与文档不符（详见 `README` 与 `MCP工具实现原理.md` 的踩坑记录）。
- 易语言**没有"切换到程序集"的功能号**：若视图停在 DLL 命令表等，需要人工点回「程序」标签。
