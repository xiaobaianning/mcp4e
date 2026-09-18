// 探针：往 _启动子程序 里塞一个信息框，判断程序入口到底有没有执行。
// 用法：node scripts/probe-entry.mjs <工程路径> [信息框文本]
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2];
const message = process.argv[3] ?? "入口在跑";

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 120000);
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
const entry = cells.find((c) => c.type === 686 && !c.title && c.text === "_启动子程序");
if (!entry) throw new Error("找不到 _启动子程序");
// 子程序内的第一条语句
const firstStatement = cells
  .filter((c) => c.type === 851 && !c.title && c.row > entry.row)
  .sort((a, b) => a.row - b.row)[0];
if (!firstStatement) throw new Error("_启动子程序 里没有语句");
console.log(`把 row=${firstStatement.row} 的语句改成信息框（原内容: ${JSON.stringify(firstStatement.text)}）`);

const active = await call("project.getActive");
console.log(JSON.stringify(await call("code.applyCurrent", {
  expectedRevision: active.revision,
  edits: [{ row: firstStatement.row, column: 0, text: `${message}` }],
})));
console.log(JSON.stringify(await call("project.save", { expectedRevision: (await call("project.getActive")).revision })));

console.log("\n运行（应弹出信息框）...");
console.log(JSON.stringify(await call("build.run", { expectedRevision: (await call("project.getActive")).revision })));
