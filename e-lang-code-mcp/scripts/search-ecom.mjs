// 搜索易模块(.ec)里的命令，输出“命令 + 参数 + 现成签名”。
// 用法：node scripts/search-ecom.mjs             （列出前 100 条）
//       node scripts/search-ecom.mjs 取随机
//       node scripts/search-ecom.mjs "" "D:\path\xxx.ec"
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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 120000);
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

const keyword = process.argv[2] ?? "";
const path = process.argv[3] ?? "";
const result = await call("lib.searchEcomCommands", { keyword, limit: 100, path });
console.log(`模块数 ${result.moduleCount}，匹配 ${result.totalMatches} 条命令，返回 ${result.returned} 条\n`);
for (const command of result.commands ?? []) {
  const file = String(command.module ?? "").split("\\").pop();
  const ret = command.returnType ? ` -> ${command.returnType}` : "";
  console.log(`${command.signature}${ret}   [${file}]`);
  for (const p of command.params ?? []) {
    console.log(`    .${p.name} : ${p.type}`);
  }
}
