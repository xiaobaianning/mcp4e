// 端到端验证 ui_sync_code（脚手架）：
//   - 自动打开工程、切到程序集视图
//   - 连续写入 N 次，验证【幂等】（不重复插子程序/语句/参数/DLL 声明）
//   - dump 程序代码表与 DLL 命令表，并统计是否有重名
// 用法：node scripts/verify-scaffold.mjs <工程路径> [次数]
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
if (!projectPath) {
  console.error("用法: node scripts/verify-scaffold.mjs <工程路径> [次数]");
  process.exit(1);
}

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 300000);
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
        ? `命名管道不存在：易语言没运行，或「易语言 MCP 桥接支持库」未启用 (${PIPE})`
        : error.message));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const lines = [];
const log = (text = "") => { lines.push(text); console.log(text); };
const documentName = path.basename(projectPath).replace(/\.[^.]+$/, "") + ".eui.json";

function dumpCells(cells, wantedTypes, label) {
  log(`--- ${label} (${cells.length} 个单元格) ---`);
  log("row  col  type  title  text");
  for (const cell of cells) {
    if (!wantedTypes.has(cell.type)) continue;
    log(`${String(cell.row).padStart(4)}  ${String(cell.column).padStart(3)}  ${String(cell.type).padStart(5)}  ${cell.title ? "Y" : "N"}      ${JSON.stringify(cell.text ?? "")}`);
  }
}

try {
  log(`=== 打开工程：${projectPath} ===`);
  log(JSON.stringify(await call("project.open", { path: projectPath, saveCurrent: false })));
  await sleep(1200);

  log("");
  log("=== 切到程序集(代码)视图 ===");
  log(JSON.stringify(await call("code.ensureCodeView")));

  for (let index = 1; index <= runs; index += 1) {
    log("");
    log(`=== 第 ${index} 次写入脚手架 ===`);
    const result = await call("code.syncUiScaffold", { documentName, commands });
    log(JSON.stringify(result, null, 2));
  }

  // 程序代码表
  log("");
  await call("code.ensureCodeView");
  const code = await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true });
  const codeCells = code.cells ?? [];
  dumpCells(codeCells, new Set([580, 686, 740, 741, 851]), "程序代码表");

  const runAStatements = codeCells.filter((cell) => cell.type === 851 && (cell.text ?? "").startsWith("EUI_MCP_RunA"));
  const callStatements = codeCells.filter((cell) => cell.type === 851 && (cell.text ?? "").includes("EUI_启动界面 ()"));
  const subprograms = codeCells.filter((cell) => cell.type === 686 && !cell.title).map((cell) => cell.text);
  const args = codeCells.filter((cell) => cell.type === 740 && !cell.title).map((cell) => cell.text);

  log("");
  log("=== 程序代码表统计 ===");
  log(`子程序: ${JSON.stringify(subprograms)}`);
  log(`参数:   ${JSON.stringify(args)}`);
  log(`EUI_MCP_RunA 语句条数: ${runAStatements.length}  ${runAStatements.length === 1 ? "✅" : "❌ 重复了"}`);
  log(`EUI_启动界面 () 入口调用条数: ${callStatements.length}  ${callStatements.length === 1 ? "✅" : "❌ 缺失或重复"}`);

  // DLL 命令表（用 activateDocument 按标题切过去）
  log("");
  log("=== 切到 DLL 命令表 ===");
  log(JSON.stringify(await call("code.activateDocument", { titlePrefix: "Dll命令定义表" })));
  const dll = await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true });
  const dllCells = dll.cells ?? [];
  dumpCells(dllCells, new Set([51, 52, 104, 155, 206, 207]), "DLL 命令表");

  const dllNames = dllCells.filter((cell) => cell.type === 51 && !cell.title).map((cell) => cell.text);
  const counts = new Map();
  for (const name of dllNames) {
    const key = name || "<空名>";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  log("");
  log("=== DLL 命令表统计 ===");
  let duplicates = 0;
  for (const [name, count] of counts) {
    const flag = count > 1 ? "❌ 重复" : "✅";
    if (count > 1) duplicates += 1;
    log(`  ${JSON.stringify(name)} x${count}  ${flag}`);
  }
  log(`重名条数: ${duplicates}  ${duplicates === 0 ? "✅ 无重复" : "❌ 有重复"}`);

  log("");
  log("=== 结论 ===");
  log(`幂等: ${runAStatements.length === 1 && duplicates === 0 ? "✅ 通过" : "❌ 未通过"}`);

  await call("code.ensureCodeView");
} catch (error) {
  log("");
  log(`!!! 出错: ${error.message}`);
} finally {
  fs.writeFileSync(new URL("../verify-output.txt", import.meta.url), lines.join("\n"), "utf8");
  console.log("\n输出已写入 verify-output.txt");
}
