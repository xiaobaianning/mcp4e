// 列出 IDE 里的命令树（SysTreeView32），确认哪个是“支持库”树。
// 用法：node scripts/list-trees.mjs
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

const result = await call("lib.listTrees");
console.log(`共 ${result.treeCount} 个命令树\n`);
for (const tree of result.trees ?? []) {
  console.log(`#${tree.index}  entries=${tree.count}  hwnd=${tree.handle}`);
  if ((tree.topLevel ?? []).length) {
    console.log(`   顶层库: ${tree.topLevel.join(" | ")}`);
  }
  for (const sample of tree.samples ?? []) {
    console.log(`     ${sample}`);
  }
  console.log("");
}
