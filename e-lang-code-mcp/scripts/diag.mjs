// 快速诊断：活动工程、编译输出、当前代码表。
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
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

console.log("== 活动工程 ==");
console.log(JSON.stringify(await call("project.getActive"), null, 2));

if (process.argv[3] === "run") {
  console.log("\n== 停止并重新运行 ==");
  console.log(JSON.stringify(await call("build.stop")));
  await new Promise((r) => setTimeout(r, 800));
  const active = await call("project.getActive");
  console.log(JSON.stringify(await call("build.run", { expectedRevision: active.revision })));
  await new Promise((r) => setTimeout(r, 4000));
  const diag2 = await call("build.getDiagnostics", {});
  console.log((diag2.output ?? "").split("\n").slice(-25).join("\n"));
}

console.log("\n== 编译输出 ==");
const diag = await call("build.getDiagnostics", {});
console.log(JSON.stringify(diag, null, 2).slice(0, 4000));

const prefix = process.argv[2];
if (prefix) {
  console.log(`\n== 切到「${prefix}」并 dump ==`);
  console.log(JSON.stringify(await call("code.activateDocument", { titlePrefix: prefix })));
  const cells = (await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true })).cells ?? [];
  for (const cell of cells) {
    if (![580, 686, 740, 741, 851].includes(cell.type)) continue;
    console.log(`${String(cell.row).padStart(4)}  ${String(cell.column).padStart(3)}  ${String(cell.type).padStart(5)}  ${cell.title ? "Y" : "N"}  ${JSON.stringify(cell.text ?? "")}`);
  }
}
