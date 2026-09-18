// 验证 IDE 支持库树里是否包含 .ec 易模块的命令。
// 关键词硬编码在脚本里，避开 PowerShell 中文参数编码问题。
// 用法：node scripts/check-tree.mjs
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 60000);
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

const keywords = ["精易", "精易模块", "模块", "系统核心支持库", "编码", "正则", "文本_取"];

for (const keyword of keywords) {
  const result = await call("lib.searchCommands", { keyword, limit: 8 });
  console.log(`\n===== 关键词 "${keyword}" : 匹配 ${result.totalMatches} 条 =====`);
  for (const command of result.commands ?? []) {
    const where = command.source === "tree" ? `[tree] ${command.path}` : `[lib] ${command.library}`;
    console.log(`  ${command.name}    ${where}`);
  }
  if (!(result.commands ?? []).length) console.log("  (无匹配)");
}
