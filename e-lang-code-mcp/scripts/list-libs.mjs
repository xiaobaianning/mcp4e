// 列出当前工程已加载的支持库与易模块。
// 用法：node scripts/list-libs.mjs
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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 20000);
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
      if (error.code === "ENOENT") {
        finish(new Error(`命名管道不存在：易语言没运行，或「易语言 MCP 桥接支持库」未启用。`));
      } else {
        finish(new Error(error.message));
      }
    });
  });
}

console.log("==== 支持库 (lib.listLibraries) ====");
console.log(JSON.stringify(await call("lib.listLibraries"), null, 2));
console.log("\n==== 易模块 (lib.listEcoms) ====");
console.log(JSON.stringify(await call("lib.listEcoms"), null, 2));
