// 把当前工程代码表全部单元格导出到 code-cells-output.txt（UTF-8），便于排查。
// 用法：node scripts/dump-cells.mjs  （或双击 查看代码表.bat）
import net from "node:net";
import fs from "node:fs";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const OUT = new URL("../code-cells-output.txt", import.meta.url);

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

const lines = [];
try {
  const project = await call("project.getActive");
  lines.push(`工程: ${project.projectPath}`);
  lines.push(`当前活动窗口类型: ${project.activeWindowType}  (1=程序集, 4=DLL命令, 5=窗体设计)`);
  if (project.activeWindowType !== 1) {
    lines.push("⚠ 警告：当前不是「程序集」窗口，读到的是别的表！请回易语言点「程序」标签页后重跑。");
  }
  lines.push("");

  const result = await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true });
  const cells = result.cells ?? [];
  lines.push(`共 ${cells.length} 个单元格：`);
  lines.push("row  col  type  title  text");
  for (const cell of cells) {
    lines.push(`${String(cell.row).padStart(3)}  ${String(cell.column).padStart(3)}  ${String(cell.type).padStart(5)}  ${cell.title ? "Y" : "N"}      ${JSON.stringify(cell.text ?? "")}`);
  }
} catch (error) {
  lines.push(`错误: ${error.message}`);
}

const text = lines.join("\n");
fs.writeFileSync(OUT, text, "utf8");
console.log(text);
