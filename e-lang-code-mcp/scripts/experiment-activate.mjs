// 实验 4：按标题前缀激活 IDE 子窗口，尝试回到「程序集」视图。
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2] ?? "E:\\mcp4e\\testmcp\\demo3.e";

function call(method, params = {}) {
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
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
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
    socket.on("error", (error) => finish(new Error(error.message)));
  });
}

await call("project.open", { path: projectPath, saveCurrent: false });
await new Promise((r) => setTimeout(r, 1500));

const before = await call("debug.activateWindowByTitle", { titlePrefix: "__不存在的标题__" });
console.log(`当前活动窗口类型: ${before.activeWindowType}`);

for (const prefix of ["程序集", "程序集: 窗口程序集_启动窗口 / _启动窗口", "程序集: __EUI_生成", "窗口:"]) {
  const result = await call("debug.activateWindowByTitle", { titlePrefix: prefix });
  console.log(`\n前缀 "${prefix}" ->`, JSON.stringify(result));
}
