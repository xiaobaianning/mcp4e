// 打印当前代码表所有单元格（row / column / type / title / text），用于学习代码表布局。
// 需要易语言开着、支持库已启用。
// 用法：node scripts/dump-code-cells.mjs
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

const project = await call("project.getActive");
console.log(`工程: ${project.projectPath}  revision: ${project.revision}\n`);

const result = await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true });
const cells = result.cells ?? [];
console.log(`共 ${cells.length} 个单元格：\n`);
console.log("row  col  type  title  text");
for (const cell of cells) {
  const text = JSON.stringify(cell.text ?? "");
  console.log(`${String(cell.row).padStart(3)}  ${String(cell.column).padStart(3)}  ${String(cell.type).padStart(4)}  ${cell.title ? "Y" : "N"}      ${text}`);
}
