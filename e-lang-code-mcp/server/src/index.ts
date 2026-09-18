#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "./pipe-client.js";
import { registerTools } from "./tools.js";

const server = new McpServer(
  {
    name: "e-lang-mcp",
    title: "易语言 MCP",
    version: "0.1.0",
    description: "让 AI 读取和修改易语言 5.95 工程代码（只走官方 IDE 接口，不改 .e 二进制）。",
  },
  {
    instructions: [
      "易语言 MCP：通过官方支持库 API 操作易语言 5.95。不改 .e 二进制、不模拟键鼠。",
      "",
      "【第一原则：先搜库，再写码】",
      "实现任何功能之前，必须先在「已加载支持库(.fne)」和「已导入易模块(.ec)」里找现成命令：",
      "  1. 调用 lib_find_command 一次搜两处（返回命令名 / 参数名 / 参数类型 / 所属库）；",
      "  2. 需要精确检索时用 lib_search_commands（.fne）或 lib_search_ecom_commands（.ec）；",
      "  3. 搜到就用现成命令（返回的 signature 可以直接抄进代码）；",
      "  4. 确实搜不到，才自己写代码实现 —— 这是兜底方案。",
      "不要一上手就手写文本/编码/正则/JSON/加密/压缩 之类的轮子，易语言生态里大概率已有现成实现。",
      "",
      "【其它约定】",
      "- 读代码前先调 project_get_active 拿工程路径与 revision；写代码必须带 expectedRevision。",
      "- 新建界面工程用 project_new（windows-ui 模板），不要往已有的老工程里注入脚手架。",
      "- 界面改动走 .eui.json（ui_* 工具），运行时由 eui_runtime.dll 渲染，并回调易语言的 EUI_事件回调。",
      "- build_compile 是预编译（不产 exe、不弹对话框）；build_run 才会真实运行。",
    ].join("\n"),
  },
);

registerTools(server, new BridgeClient());

await server.connect(new StdioServerTransport());
