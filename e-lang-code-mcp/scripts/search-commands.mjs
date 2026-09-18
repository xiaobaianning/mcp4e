// 按关键词搜索已加载支持库/易模块提供的命令。
// 用法：
//   node scripts/search-commands.mjs SHA
//   node scripts/search-commands.mjs 文本
//   node scripts/search-commands.mjs "" 100      (留空 => 前 100 条)
//
// 注意：PowerShell 直接传中文参数可能乱码，中文关键词建议通过 MCP 客户端调用 lib_search_commands。
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const keyword = process.argv[2] ?? "";
const limit = Number(process.argv[3] ?? "50");

function call(method, params = {}) {
  const id = 1;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 30000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.ok) finish(undefined, response.result);
        else finish(new Error(response.error));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => {
      finish(new Error(error.code === "ENOENT"
        ? "命名管道不存在：易语言没运行，或「易语言 MCP 桥接支持库」未启用。"
        : error.message));
    });
  });
}

const result = await call("lib.searchCommands", { keyword, limit });
console.log(`关键词: "${keyword}"  匹配 ${result.totalMatches} 条，返回 ${result.returned} 条\n`);
for (const command of result.commands ?? []) {
  const params = (command.args ?? []).map((a) => `${a.name}: ${a.type}`).join(", ");
  console.log(`${command.name}(${params})`);
  console.log(`    [${command.library}] ${String(command.explain ?? "").replace(/\s+/g, " ").slice(0, 80)}`);
}
