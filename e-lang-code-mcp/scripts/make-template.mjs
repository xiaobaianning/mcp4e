// 制作 windows-ui.e 模板：
//   1) 删掉 EUI_启动界面 里自递归的 "EUI_启动界面 ()" 语句
//   2) 删掉 DLL 命令表里的垃圾命令（形如 DLL命令N / 空名）
//   3) 激活目标程序集，跑一次脚手架（入口调用会落进 __启动窗口_创建完毕）
//   4) 保存并复制成模板
// 用法：node scripts/make-template.mjs <源工程> [目标程序集标题前缀] [模板输出路径]
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const source = process.argv[2];
const targetProgramSet = process.argv[3] ?? "程序集: 窗口程序集_启动窗口";
const output = process.argv[4] ?? "E:\\mcp4e\\e-lang-code-mcp\\templates\\windows-ui.e";
if (!source) {
  console.error("用法: node scripts/make-template.mjs <源工程> [程序集前缀] [输出模板路径]");
  process.exit(1);
}

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 300000);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const commands = [
  { name: "EUI_MCP_RunA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_RunA",
    args: [{ name: "界面文件", type: "文本型" }, { name: "事件回调", type: "子程序指针" }] },
  { name: "EUI_MCP_Close", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_Close", args: [] },
  { name: "EUI_MCP_SetTextA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetTextA",
    args: [{ name: "控件编号", type: "整数型" }, { name: "文本", type: "文本型" }] },
  { name: "EUI_MCP_GetTextPtrA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_GetTextPtrA",
    args: [{ name: "控件编号", type: "整数型" }] },
  { name: "EUI_MCP_SetVisible", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetVisible",
    args: [{ name: "控件编号", type: "整数型" }, { name: "可视", type: "逻辑型" }] },
  { name: "EUI_MCP_SetEnabled", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetEnabled",
    args: [{ name: "控件编号", type: "整数型" }, { name: "可用", type: "逻辑型" }] },
];

const readCells = async () => (await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true })).cells ?? [];

console.log(`打开源工程: ${source}`);
try {
  console.log("停止可能正在运行的程序: " + JSON.stringify(await call("build.stop")));
} catch (error) {
  console.log(`  (停止失败: ${error.message})`);
}
await sleep(1000);
await call("project.open", { path: source, saveCurrent: false });
await sleep(1500);

// ---- 1) 删掉 EUI_启动界面 里自递归的 EUI_启动界面 () ----
console.log("\n[1] 检查自递归语句");
console.log(JSON.stringify(await call("code.activateDocument", { titlePrefix: "程序集" })));
let cells = await readCells();
const startupSub = cells.find((c) => c.type === 686 && !c.title && c.text === "EUI_启动界面");
if (startupSub) {
  const nextSub = cells.filter((c) => c.type === 686 && !c.title && c.row > startupSub.row).sort((a, b) => a.row - b.row)[0];
  const endRow = nextSub ? nextSub.row : 999999;
  const bogus = cells
    .filter((c) => c.type === 851 && !c.title && c.row > startupSub.row && c.row < endRow && c.text === "EUI_启动界面 ()")
    .map((c) => c.row)
    .sort((a, b) => b - a);
  if (bogus.length === 0) console.log("  没有自递归语句 ✅");
  for (const row of bogus) {
    console.log(`  删除 row=${row}`);
    await call("code.removeRowRange", { top: row, bottom: row });
  }
} else {
  console.log("  没找到 EUI_启动界面（跳过）");
}

// ---- 2) 删掉 DLL 命令表里的垃圾命令 ----
console.log("\n[2] 清理 DLL 命令表");
console.log(JSON.stringify(await call("code.activateDocument", { titlePrefix: "Dll命令定义表" })));
cells = await readCells();
const nameRows = cells.filter((c) => c.type === 51 && !c.title).map((c) => ({ row: c.row, text: c.text }));
const titleRows = cells.filter((c) => c.type === 51 && c.title).map((c) => c.row).sort((a, b) => a - b);
const maxRow = cells.reduce((max, c) => Math.max(max, c.row), 0);
const junk = nameRows.filter((n) => n.text === "" || /^DLL命令\d*$/.test(n.text));
if (junk.length === 0) {
  console.log("  没有垃圾命令 ✅");
} else {
  const blocks = junk
    .map((n) => {
      const titles = titleRows.filter((t) => t <= n.row);
      const title = titles.length ? titles[titles.length - 1] : n.row;
      const next = titleRows.find((t) => t > n.row);
      return { title, end: (next ?? maxRow + 1) - 1, name: n.text };
    })
    .filter((b) => b.title > 0)
    .sort((a, b) => b.title - a.title);
  for (const block of blocks) {
    console.log(`  删除块 [${block.title}, ${block.end}]  ${JSON.stringify(block.name)}`);
    await call("code.removeRowRange", { top: block.title, bottom: block.end });
  }
}

// ---- 3) 在目标程序集里跑脚手架 ----
console.log(`\n[3] 激活目标程序集并写脚手架: ${targetProgramSet}`);
console.log(JSON.stringify(await call("code.activateDocument", { titlePrefix: targetProgramSet })));
const documentName = path.basename(source).replace(/\.[^.]+$/, "") + ".eui.json";
const scaffold = await call("code.syncUiScaffold", { documentName, commands });
console.log(JSON.stringify(scaffold, null, 2));

// ---- 4) 保存 + 复制成模板（有 codeError 就不保存，避免污染源工程）----
if (scaffold.codeError) {
  console.error(`\n[4] 脚手架失败，**不保存**以免污染源工程：${scaffold.codeError}`);
  process.exit(2);
}
console.log("\n[4] 保存并复制模板");
const active = await call("project.getActive");
console.log(JSON.stringify(await call("project.save", { expectedRevision: active.revision })));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(source, output);
console.log(`模板已生成: ${output}  (${fs.statSync(output).size} bytes)`);
