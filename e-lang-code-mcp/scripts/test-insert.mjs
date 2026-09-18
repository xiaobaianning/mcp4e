// 结构插入冒烟测试：在最后一条语句后插入新语句 → 读回校验 → 用 undo 还原。
// 用法：node scripts/test-insert.mjs
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
let nextId = 1;

function call(method, params = {}) {
  const id = nextId++;
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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 20000);
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
    socket.on("error", (error) => finish(new Error(error.message)));
  });
}

const MARK = "输出调试文本 (“MCP-INSERT”)";

const project = await call("project.getActive");
console.log(`工程:     ${project.projectPath}`);
console.log(`revision: ${project.revision}`);

const before = await call("code.readCurrent", { maxRows: 5000 });
const statements = before.cells.filter((cell) => cell.type === 851 && !cell.title);
if (!statements.length) {
  console.error("未找到语句单元格 (type=851)，终止。");
  process.exit(1);
}
const anchor = statements[statements.length - 1];
console.log(`锚点语句: row=${anchor.row}  ${anchor.text}`);

// 1. 把光标移到锚点语句
await call("code.move", { direction: "row", row: anchor.row, column: 0 });

// 2. 在该语句后插入一条新语句
const inserted = await call("code.batch", {
  expectedRevision: project.revision,
  operations: [
    {
      action: "insert",
      kind: "statementAfter",
      edits: [{ rowOffset: 0, column: 0, text: MARK }],
    },
  ],
});
console.log(`插入完成，新 revision: ${inserted.revision}`);

// 3. 读回校验
const after = await call("code.readCurrent", { maxRows: 5000 });
const found = after.cells.find((cell) => cell.type === 851 && cell.text === MARK);
if (!found) {
  console.error("读回失败：没有找到插入的语句。");
  console.error(JSON.stringify(after.cells.filter((c) => c.type === 851).map((c) => c.text), null, 2));
  process.exit(2);
}
console.log(`读回校验: row=${found.row}  ${found.text}`);

// 4. 用 undo 还原到初始 revision
let revision = inserted.revision;
for (let attempt = 0; attempt < 10 && revision !== project.revision; ++attempt) {
  const undone = await call("code.undo");
  revision = undone.revision;
}
if (revision !== project.revision) {
  console.error(`还原失败：revision 仍为 ${revision}，期望 ${project.revision}`);
  console.error("请手动删除插入的语句或用 Ctrl+Z 撤销。");
  process.exit(3);
}
console.log(`已还原到初始 revision: ${revision}`);
console.log("");
console.log("✅ 结构插入测试通过（插入 → 读回 → 撤销还原）");
