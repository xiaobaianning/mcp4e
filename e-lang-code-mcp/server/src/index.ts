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
      "易语言 MCP 通过官方支持库 API 操作易语言 5.95。",
      "读取代码前先调用 project_get_active 获取工程路径与 revision。",
      "写入代码必须带上读取时得到的 expectedRevision。",
    ].join("\n"),
  },
);

registerTools(server, new BridgeClient());

await server.connect(new StdioServerTransport());
