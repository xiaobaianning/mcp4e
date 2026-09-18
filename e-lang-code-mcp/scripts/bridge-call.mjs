// 直接调用易语言 IDE 桥接的调试脚本（不经过 MCP 客户端）。
//
// 用法：
//   node scripts/bridge-call.mjs ide.status
//   node scripts/bridge-call.mjs project.getActive
//   node scripts/bridge-call.mjs code.readCurrent "{\"maxRows\":200}"
//   node scripts/bridge-call.mjs code.move "{\"direction\":\"top\"}"
//
// 管道名可用环境变量覆盖：E_LANG_MCP_PIPE
import net from "node:net";

const method = process.argv[2] ?? "ide.status";
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const id = 1;

const socket = net.createConnection(PIPE);
let buffer = "";
let settled = false;

const finish = (code, text) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (text !== undefined) (code === 0 ? console.log(text) : console.error(text));
  socket.destroy();
  process.exit(code);
};

const timer = setTimeout(() => finish(1, `桥接调用超时: ${method}`), 15000);

socket.setEncoding("utf8");
socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
socket.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  try {
    const response = JSON.parse(buffer.slice(0, newline));
    finish(response.ok ? 0 : 2, JSON.stringify(response, null, 2));
  } catch (error) {
    finish(1, String(error));
  }
});
socket.on("error", (error) => {
  const hint = error.message.includes("ENOENT")
    ? `\n提示: 易语言没运行，或没在“支持库配置”里勾选桥接支持库，或管道名不对 (${PIPE})`
    : "";
  finish(1, error.message + hint);
});
