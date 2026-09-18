// 导出易语言 IDE 的窗口树，帮助定位“输出/编译结果”面板。
// 用法：node scripts/dump-windows.mjs
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
    socket.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(new Error(
          `命名管道不存在 (${PIPE})：易语言没运行，或「易语言 MCP 桥接支持库」未启用，或装完没重启易语言。`,
        ));
      } else {
        finish(new Error(error.message));
      }
    });
  });
}

const result = await call("debug.dumpWindows");
const entries = result.entries ?? [];
console.log(`IDE 子窗口总数: ${result.count}，其中有文本的 ${entries.filter((e) => e.length > 0).length} 个\n`);

const withText = entries
  .filter((entry) => entry.length > 0)
  .sort((a, b) => b.length - a.length);

console.log("有文本的窗口（按文本长度降序，最多 60 个）:");
console.log("len   depth  class                              title");
for (const entry of withText.slice(0, 60)) {
  const cls = String(entry.className ?? "").slice(0, 34).padEnd(34);
  const title = String(entry.title ?? "").replace(/\s+/g, " ").slice(0, 60);
  console.log(`${String(entry.length).padStart(4)}  ${String(entry.depth).padStart(5)}  ${cls} ${title}`);
}

console.log("\n疑似输出面板的编辑类控件:");
for (const entry of entries.filter((e) => /edit|richedit|output|log/i.test(e.className ?? ""))) {
  console.log(`  class=${entry.className} len=${entry.length} visible=${entry.visible} ${String(entry.title ?? "").replace(/\s+/g, " ").slice(0, 80)}`);
}
