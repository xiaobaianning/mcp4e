// 写代码冒烟测试：挑最后一条语句 → 改写 → 读回校验 → 还原。
// 全程通过命名管道传 JSON，不经过命令行，避免中文被 shell 编码破坏。
//
// 用法：node scripts/test-write.mjs
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

function findLastStatement(cells) {
  const statements = cells.filter((cell) => cell.type === 851 && !cell.title);
  return statements.length ? statements[statements.length - 1] : undefined;
}

const project = await call("project.getActive");
console.log(`工程:     ${project.projectPath}`);
console.log(`revision: ${project.revision}`);

const before = await call("code.readCurrent", { maxRows: 5000 });
const target = findLastStatement(before.cells);
if (!target) {
  console.error("未找到语句单元格 (type=851)，终止。");
  process.exit(1);
}
console.log(`目标:     row=${target.row} column=${target.column}`);
console.log(`原文本:   ${target.text}`);

const newText =
  target.text === "输出调试文本 (“MCP-TEST”)" ? "输出调试文本 (“MCP-TEST-2”)" : "输出调试文本 (“MCP-TEST”)";

// --- 1. 写入 ---
const written = await call("code.applyCurrent", {
  expectedRevision: project.revision,
  edits: [{ row: target.row, column: target.column, text: newText, expectedKind: "statement" }],
});
console.log(`写入成功，新 revision: ${written.revision}`);

// --- 2. 读回校验 ---
const after = await call("code.readCurrent", { maxRows: 5000 });
const applied = after.cells.find((cell) => cell.row === target.row && cell.column === target.column);
if (!applied || applied.text !== newText) {
  console.error(`读回不一致！期望: ${newText} / 实际: ${applied ? applied.text : "(缺失)"}`);
  process.exit(2);
}
console.log(`读回校验: ${applied.text}`);

// --- 3. 还原 ---
await call("code.applyCurrent", {
  expectedRevision: written.revision,
  edits: [{ row: target.row, column: target.column, text: target.text, expectedKind: "statement" }],
});
const final = await call("code.readCurrent", { maxRows: 5000 });
const finalCell = final.cells.find((cell) => cell.row === target.row && cell.column === target.column);
if (!finalCell || finalCell.text !== target.text) {
  console.error(`还原失败！实际: ${finalCell ? finalCell.text : "(缺失)"}`);
  console.error(`请手动把第 ${target.row} 行改回: ${target.text}`);
  process.exit(3);
}
console.log(`已还原:   ${finalCell.text}`);
console.log("");
console.log("✅ 写代码测试通过（改写 → 读回校验 → 还原）");
