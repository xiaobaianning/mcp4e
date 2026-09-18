# 工程模板目录

`project_new` 工具会从这里取模板：把 `templates/<type>.e` 复制到目标路径，再由 IDE 打开。

支持的类型（对应文件名）：

| 类型 | 文件 | 说明 |
|---|---|---|
| `windows-window` | `windows-window.e` | 普通 Windows 窗口程序 |
| `windows-console` | `windows-console.e` | 控制台程序 |
| `windows-ui` | `windows-ui.e` | **MCP 界面专用**：已内置 DLL 声明 + 脚手架 + 入口调用 |

搜索顺序：环境变量 `E_LANGUAGE_PROJECT_TEMPLATE_DIR` → `server/dist/templates` → `server/templates` → 仓库根 `templates`。

> 模板是**二进制 `.e` 文件**，只能在易语言里做出来（无法凭空生成）。

---

## 制作 `windows-ui.e`（一次性，约 2 分钟）

1. 打开易语言 → **文件 → 新建 → Windows 窗口程序** → 确定
2. **文件 → 另存为** → 存到这个目录，文件名填 `windows-ui.e`
   （完整路径：`E:\mcp4e\e-lang-code-mcp\templates\windows-ui.e`）
3. **保持这个工程打开**，双击仓库根目录的 `test-sync-scaffold.bat`
   → 它会往当前工程写入：6 个 `EUI_MCP_*` DLL 声明、`EUI_启动界面`、`EUI_事件回调`（3 个整数型参数）、以及入口调用 `EUI_启动界面 ()`
4. 回到易语言按 **Ctrl+S** 保存
5. 删掉这个目录里可能生成的 `windows-ui.eui.json`（新工程会自己生成）

完成后 `templates/windows-ui.e` 就是"**新建出来直接能跑 `.eui.json` 界面**"的工程。

## 制作另外两个（可选）

`windows-window.e` / `windows-console.e` 只要第 1、2 步（新建后另存为），
不需要跑脚手架 —— 它们是给"我要一个普通易语言工程"用的。

---

## 为什么用模板，而不是往已有工程里注入

- **不碰你的代码**：新建工程 = 一次文件复制，绝不修改你正在编辑的工程。
- **不依赖插入 API**：易语言的 `FN_INSERT_NEW_*` 在上下文不对时会静默失败、甚至把光标甩到第 0 行（踩坑记录见根目录 `README.md`）。
- **可重复**：模板是固定产物，结果稳定。

> 注意：模板 `.e` 是本机易语言 5.95 生成的。换大版本后建议重新制作。
