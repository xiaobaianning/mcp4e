// 十六进制查看 .ec 文件的结构，帮助分析字符串表。
// 用法：
//   node scripts/inspect-ecom.mjs "D:\path\xxx.ec"            （看文件开头 1KB）
//   node scripts/inspect-ecom.mjs "D:\path\xxx.ec" 打开进程    （看某命令附近）
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

const path = process.argv[2];
if (!path) {
  console.error("用法: node scripts/inspect-ecom.mjs <path.ec> [needle]");
  process.exit(1);
}
const needle = process.argv[3] ?? "";

const result = await call("lib.inspectEcom", { path, needle, context: needle ? 320 : 1024 });
if (needle && result.found === false) {
  console.log(`没有找到 "${needle}"`);
  process.exit(2);
}
console.log(`文件: ${path}`);
if (result.offset !== undefined) console.log(`"${needle}" 位于偏移 0x${Number(result.offset).toString(16).toUpperCase()}`);
console.log(`范围: 0x${Number(result.start).toString(16).toUpperCase()} .. 0x${Number(result.end).toString(16).toUpperCase()}\n`);
for (const line of result.dump ?? []) console.log(line);
