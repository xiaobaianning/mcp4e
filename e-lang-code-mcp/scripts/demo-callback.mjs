// 给 uitest 工程写入事件回调演示代码：按钮/事件发生时把信息写进文本框。
// 用法：node scripts/demo-callback.mjs <工程路径> [run]
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2];
const runFlag = process.argv[3];
if (!projectPath) {
  console.error("用法: node scripts/demo-callback.mjs <工程路径> [run]");
  process.exit(1);
}

// 演示语句（硬编码在这里，避免 shell 引号把全文引号吃掉）
// 写成单行：任何事件都把事件信息写到文本框，能直观证明回调真的被调了。
const STATEMENTS = [
  "EUI_MCP_SetTextA (1003, “事件代码：” ＋ 到文本 (事件代码) ＋ “，控件编号：” ＋ 到文本 (控件编号) ＋ “，文本：” ＋ 指针到文本 (事件文本指针))",
];

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 180000);
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

try { await call("build.stop"); } catch {}
await sleep(800);
console.log(JSON.stringify(await call("project.open", { path: projectPath, saveCurrent: true })));
await sleep(1200);
console.log(JSON.stringify(await call("code.activateDocument", { titlePrefix: "程序集:" })));

const cells = (await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true })).cells ?? [];
const sub = cells.find((c) => c.type === 686 && !c.title && c.text === "EUI_事件回调");
if (!sub) throw new Error("找不到 EUI_事件回调");
const nextSub = cells.filter((c) => c.type === 686 && !c.title && c.row > sub.row).sort((a, b) => a.row - b.row)[0];
const endRow = nextSub ? nextSub.row : 999999;
const statements = cells
  .filter((c) => c.type === 851 && !c.title && c.row > sub.row && c.row < endRow)
  .sort((a, b) => a.row - b.row);
console.log(`EUI_事件回调 现有语句行: ${statements.map((c) => `${c.row}=${JSON.stringify(c.text)}`).join(", ")}`);

// 用前 N 行（优先空白行）写入演示代码
const edits = [];
const available = statements.filter((c) => c.text === "");
const pool = available.length >= STATEMENTS.length ? available : statements;
for (let i = 0; i < STATEMENTS.length; i += 1) {
  const slot = pool[i];
  if (!slot) throw new Error(`语句行不够（需要 ${STATEMENTS.length} 行，只有 ${pool.length} 行）`);
  edits.push({ row: slot.row, column: 0, text: STATEMENTS[i] });
}
console.log("将写入:");
for (const edit of edits) console.log(`  row=${edit.row}  ${edit.text}`);

const active = await call("project.getActive");
console.log(JSON.stringify(await call("code.applyCurrent", { expectedRevision: active.revision, edits })));
console.log(JSON.stringify(await call("project.save", { expectedRevision: (await call("project.getActive")).revision })));

if (runFlag === "run") {
  console.log("\n运行...");
  console.log(JSON.stringify(await call("build.run", { expectedRevision: (await call("project.getActive")).revision })));
}
