// 往指定工程的指定子程序里写一条语句（用于演示事件回调）。
// 用法：node scripts/set-statement.mjs <工程路径> <子程序名> <语句文本> [run]
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const [projectPath, subprogramName, statementText, runFlag] = process.argv.slice(2);
if (!projectPath || !subprogramName || !statementText) {
  console.error("用法: node scripts/set-statement.mjs <工程路径> <子程序名> <语句文本> [run]");
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
const sub = cells.find((c) => c.type === 686 && !c.title && c.text === subprogramName);
if (!sub) throw new Error(`找不到子程序 ${subprogramName}`);
const nextSub = cells.filter((c) => c.type === 686 && !c.title && c.row > sub.row).sort((a, b) => a.row - b.row)[0];
const endRow = nextSub ? nextSub.row : 999999;
const statements = cells.filter((c) => c.type === 851 && !c.title && c.row > sub.row && c.row < endRow).sort((a, b) => a.row - b.row);
const blank = statements.find((c) => c.text === "");
console.log(`${subprogramName} 里有 ${statements.length} 条语句，空白行: ${blank ? blank.row : "无"}`);

const target = blank ?? statements[statements.length - 1];
if (!target) throw new Error("没有可写的语句行");
console.log(`写入 row=${target.row}: ${statementText}`);
const active = await call("project.getActive");
console.log(JSON.stringify(await call("code.applyCurrent", {
  expectedRevision: active.revision,
  edits: [{ row: target.row, column: 0, text: statementText }],
})));
console.log(JSON.stringify(await call("project.save", { expectedRevision: (await call("project.getActive")).revision })));

if (runFlag === "run") {
  console.log("\n运行...");
  console.log(JSON.stringify(await call("build.run", { expectedRevision: (await call("project.getActive")).revision })));
}
