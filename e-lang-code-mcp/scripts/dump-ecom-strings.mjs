// 解析 .ec 易模块：输出命令/说明/参数(带类型)。
// 用法：node scripts/dump-ecom-strings.mjs [path.ec]
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const DEFAULT_PATH = "D:\\software\\eyy\\ecom\\外部控件操作类.ec";

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

async function dump(path) {
  console.log(`\n===== ${path} =====`);
  const result = await call("lib.readEcomStrings", { path, minChars: 2, maxStrings: 20000 });
  console.log(`文件 ${result.fileSize} 字节，${result.count} 条记录\n`);
  for (const record of result.records ?? []) {
    const off = "0x" + Number(record.offset).toString(16).toUpperCase().padStart(6, "0");
    if (record.kind === "param") {
      console.log(`${off}  [参数] ${record.text} : ${record.type}`);
    } else {
      console.log(`${off}  [文本] ${record.text}`);
    }
  }
}

await dump(process.argv[2] ?? DEFAULT_PATH);
