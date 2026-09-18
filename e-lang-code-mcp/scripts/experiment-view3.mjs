// 实验 3：关闭/重开文件能否重置到「程序集」视图。
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2] ?? "E:\\mcp4e\\testmcp\\demo3.e";

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 30000);
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

const FNT_MOVE = 0x01000000, FNT_DOCUMENT = 0x03000000, FNT_OTHER = 0x04000000;
const FNST_MOVE_CARET = FNT_MOVE | 0x010000;
const FNST_FILE = FNT_DOCUMENT | 0x010000;
const FNST_OTHER = FNT_OTHER | 0x020000;
const F = {
  MOVE_TOP: FNST_MOVE_CARET | 3,
  NEW_FILE: FNST_FILE | 1,
  CLOSE_FILE: FNST_FILE | 3,
  SAVE_FILE: FNST_FILE | 4,
  OPEN_FILE2: FNST_FILE | 8,
  VIEW_DLLCMD_TAB: FNST_OTHER | 10,
  VIEW_SOUND_TAB: FNST_OTHER | 13,
  VIEW_CONST_TAB: FNST_OTHER | 11,
};

const step = async (label, fn) => {
  const result = await call("debug.callIdeFunction", { fn });
  console.log(`  ${label}: handled=${result.handled} type=${result.activeWindowType}`);
  return result.activeWindowType;
};

console.log(`当前: ${(await call("debug.callIdeFunction", { fn: F.MOVE_TOP })).activeWindowType}`);

console.log("\n先切到声音资源表制造'非程序集'状态：");
await step("VIEW_SOUND_TAB", F.VIEW_SOUND_TAB);

console.log("\nA) CLOSE_FILE -> OPEN_FILE2:");
await step("CLOSE_FILE", F.CLOSE_FILE);
await new Promise((r) => setTimeout(r, 800));
await call("project.open", { path: projectPath, saveCurrent: false });
await new Promise((r) => setTimeout(r, 1500));
console.log(`  OPEN_FILE2 后 type=${(await call("debug.callIdeFunction", { fn: F.MOVE_TOP })).activeWindowType}`);

console.log("\nB) 切到常量表 -> CLOSE -> OPEN:");
await step("VIEW_CONST_TAB", F.VIEW_CONST_TAB);
await step("CLOSE_FILE", F.CLOSE_FILE);
await new Promise((r) => setTimeout(r, 800));
await call("project.open", { path: projectPath, saveCurrent: false });
await new Promise((r) => setTimeout(r, 1500));
console.log(`  重开后 type=${(await call("debug.callIdeFunction", { fn: F.MOVE_TOP })).activeWindowType}`);
