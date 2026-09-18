// 测试 code.syncUiScaffold：一键往当前工程写入界面脚手架（DLL声明+模块+子程序+语句+参数）。
// 用法：node scripts/test-sync-scaffold.mjs
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

const commands = [
  { name: "EUI_MCP_RunA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_RunA",
    args: [{ name: "界面文件", type: "文本型" }, { name: "事件回调", type: "子程序指针" }] },
  { name: "EUI_MCP_Close", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_Close", args: [] },
  { name: "EUI_MCP_SetTextA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetTextA",
    args: [{ name: "控件编号", type: "整数型" }, { name: "文本", type: "文本型" }] },
  { name: "EUI_MCP_GetTextPtrA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_GetTextPtrA",
    args: [{ name: "控件编号", type: "整数型" }] },
];

const project = await call("project.getActive");
const documentName = project.projectPath.split("\\").pop().replace(/\.[^.]+$/, "") + ".eui.json";
console.log(`工程: ${project.projectPath}`);
console.log(`界面文档: ${documentName}\n`);

console.log("写入脚手架 ...");
const result = await call("code.syncUiScaffold", { documentName, commands });
console.log(JSON.stringify(result, null, 2));

console.log("\n回读程序代码表（只显示结构/语句/参数）：");
const cells = await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true });
const wanted = new Set([580, 686, 851, 740, 741, 796]);
console.log("row  col  type  text");
for (const cell of cells.cells ?? []) {
  if (!wanted.has(cell.type)) continue;
  console.log(`${String(cell.row).padStart(3)}  ${String(cell.column).padStart(3)}  ${String(cell.type).padStart(4)}  ${JSON.stringify(cell.text ?? "")}`);
}
