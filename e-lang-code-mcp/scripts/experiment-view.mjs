// 实验：找出「切换到程序集(代码)视图」的可靠办法。
// 用法：node scripts/experiment-view.mjs <工程路径>
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2];
if (!projectPath) {
  console.error("用法: node scripts/experiment-view.mjs <工程路径>");
  process.exit(1);
}

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 60000);
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

// 与 PublicIDEFunctions.h 对齐的功能号
const FNT_MOVE = 0x01000000, FNT_EDIT = 0x02000000, FNT_OTHER = 0x04000000;
const FNST_MOVE_CARET = FNT_MOVE | 0x010000;
const FNST_MODIFY = FNT_EDIT | 0x020000;
const FNST_OTHER = FNT_OTHER | 0x020000;
const F = {
  MOVE_UP: FNST_MOVE_CARET | 1,
  MOVE_DOWN: FNST_MOVE_CARET | 2,
  MOVE_TOP: FNST_MOVE_CARET | 3,
  MOVE_BOTTOM: FNST_MOVE_CARET | 4,
  MOVE_PREV_UNIT: FNST_MOVE_CARET | 45,
  MOVE_NEXT_UNIT: FNST_MOVE_CARET | 46,
  MOVE_SPEC_SUB: FNST_MOVE_CARET | 47,
  MOVE_OPEN_SPEC_SUB: FNST_MOVE_CARET | 48,
  MOVE_CLOSE_SPEC_SUB: FNST_MOVE_CARET | 49,
  MOVE_OPEN_SPEC_SUB_GRP: FNST_MOVE_CARET | 50,
  MOVE_BACK_SUB: FNST_MOVE_CARET | 67,
  VIEW_DATA_TYPE_TAB: FNST_OTHER | 8,
  VIEW_GLOBAL_VAR_TAB: FNST_OTHER | 9,
  VIEW_DLLCMD_TAB: FNST_OTHER | 10,
  VIEW_CONST_TAB: FNST_OTHER | 11,
  VIEW_PIC_TAB: FNST_OTHER | 12,
  VIEW_SOUND_TAB: FNST_OTHER | 13,
  EXTEND_ALL_SUB: FNST_OTHER | 57,
  GOTO_LAST_MODI_PLACE: FNST_OTHER | 51,
};

const type = async () => (await call("debug.callIdeFunction", { fn: F.MOVE_TOP })).activeWindowType;
const probe = async (name) => `${name}=${(await call("debug.callIdeFunction", { fn: F.MOVE_TOP })).activeWindowType}`;
const press = async (fn) => (await call("debug.callIdeFunction", { fn })).activeWindowType;

console.log(`打开工程: ${projectPath}`);
await call("project.open", { path: projectPath, saveCurrent: false });
await new Promise((r) => setTimeout(r, 1500));
console.log(`打开后窗口类型: ${await type()}   (1=程序集 4=DLL命令 5=窗体 2=数据类型 3=全局变量 6=常量)`);
console.log("");

console.log("A) FN_MOVE_NEXT_UNIT x12:");
let seq = [];
for (let i = 0; i < 12; i += 1) seq.push(await press(F.MOVE_NEXT_UNIT));
console.log(`   ${seq.join(",")}`);

console.log("B) FN_MOVE_PREV_UNIT x12:");
seq = [];
for (let i = 0; i < 12; i += 1) seq.push(await press(F.MOVE_PREV_UNIT));
console.log(`   ${seq.join(",")}`);

console.log("C) 先切到全局变量表，再 NEXT_UNIT x12:");
await press(F.VIEW_GLOBAL_VAR_TAB);
console.log(`   切后=${await type()}`);
seq = [];
for (let i = 0; i < 12; i += 1) seq.push(await press(F.MOVE_NEXT_UNIT));
console.log(`   ${seq.join(",")}`);

console.log("D) 先切到数据类型表，再 NEXT_UNIT x12:");
await press(F.VIEW_DATA_TYPE_TAB);
console.log(`   切后=${await type()}`);
seq = [];
for (let i = 0; i < 12; i += 1) seq.push(await press(F.MOVE_NEXT_UNIT));
console.log(`   ${seq.join(",")}`);

console.log("E) FN_MOVE_SPEC_SUB / OPEN_SPEC_SUB / BACK_SUB:");
console.log(`   SPEC_SUB=${await press(F.MOVE_SPEC_SUB)} OPEN_SPEC_SUB=${await press(F.MOVE_OPEN_SPEC_SUB)} BACK_SUB=${await press(F.MOVE_BACK_SUB)}`);

console.log("F) 重新打开工程 (FN_OPEN_FILE2):");
await call("project.open", { path: projectPath, saveCurrent: false });
await new Promise((r) => setTimeout(r, 1500));
console.log(`   重开后=${await type()}`);

console.log("G) GOTO_LAST_MODI_PLACE / EXTEND_ALL_SUB:");
console.log(`   GOTO_LAST_MODI=${await press(F.GOTO_LAST_MODI_PLACE)} EXTEND_ALL_SUB=${await press(F.EXTEND_ALL_SUB)}`);

console.log("");
console.log("H) 各视图功能号回显:");
for (const key of ["VIEW_DATA_TYPE_TAB", "VIEW_GLOBAL_VAR_TAB", "VIEW_DLLCMD_TAB", "VIEW_CONST_TAB", "VIEW_PIC_TAB", "VIEW_SOUND_TAB"]) {
  const t = await press(F[key]);
  console.log(`   ${key} -> ${t}`);
}
