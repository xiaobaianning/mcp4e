// 直接以 MCP 协议驱动服务器，验证 instructions 与新工具。
// 用法：node scripts/test-mcp.mjs [关键词]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyword = process.argv[2] ?? "文本";

const child = spawn(process.execPath, [path.join(repoRoot, "server", "dist", "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch {
      // 忽略非 JSON 输出
    }
  }
});

let nextId = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "probe", version: "1" },
});
console.log("=== initialize.instructions ===");
console.log(init.result?.instructions ?? "(无)");
notify("notifications/initialized", {});

const tools = await request("tools/list", {});
const names = (tools.result?.tools ?? []).map((tool) => tool.name);
console.log(`\n=== 工具 ${names.length} 个 ===`);
console.log(names.join(", "));
console.log(`\nlib_find_command 存在: ${names.includes("lib_find_command") ? "✅" : "❌"}`);

console.log(`\n=== 调用 lib_find_command("${keyword}") ===`);
const call = await request("tools/call", { name: "lib_find_command", arguments: { keyword, limit: 5 } });
const text = call.result?.content?.[0]?.text ?? JSON.stringify(call.error ?? call.result);
console.log(text.slice(0, 2500));

child.kill();
process.exit(0);
