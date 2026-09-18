// 把 .ec 的分析结果（字符串+偏移、完整 hex）写到一个 txt 文件，供离线分析。
// 用法：node scripts/dump-ecom-analysis.mjs [path.ec]
//   不传路径时默认分析 D:\software\eyy\ecom\外部控件操作类.ec
import net from "node:net";
import { writeFileSync } from "node:fs";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const DEFAULT_PATH = "D:\\software\\eyy\\ecom\\外部控件操作类.ec";
const path = process.argv[2] ?? DEFAULT_PATH;
const OUT = "ecom-analysis.txt";

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

const lines = [];
lines.push(`FILE ${path}`);

const strings = await call("lib.readEcomStrings", { path, minChars: 2, maxStrings: 20000 });
lines.push(`SIZE ${strings.fileSize}  MODE ${strings.mode}  RECORDS ${strings.count}  IDENTIFIERS ${strings.identifierCount}`);
lines.push("");
lines.push("=== RECORDS (offset/text) ===");
for (const record of strings.records ?? []) {
  const off = "0x" + Number(record.offset).toString(16).toUpperCase().padStart(6, "0");
  lines.push(`${off}  ${record.text}`);
}

lines.push("");
lines.push("=== HEX (whole file) ===");
const hex = await call("lib.inspectEcom", { path, needle: "", context: 16384 });
for (const line of hex.dump ?? []) lines.push(line);

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(`已写入 ${OUT}（${lines.length} 行）。把这个文件交给助手分析。`);
