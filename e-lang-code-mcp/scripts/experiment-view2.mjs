// 实验 2：找回到「程序集(代码)」视图的通道。
// 用法：node scripts/experiment-view2.mjs <工程路径>
import net from "node:net";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const projectPath = process.argv[2];

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 60000);
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

const FNT_MOVE = 0x01000000, FNT_OTHER = 0x04000000;
const FNST_MOVE_CARET = FNT_MOVE | 0x010000;
const FNST_OTHER = FNT_OTHER | 0x020000;
const F = {
  MOVE_TOP: FNST_MOVE_CARET | 3,
  MOVE_PREV_UNIT: FNST_MOVE_CARET | 45,
  MOVE_NEXT_UNIT: FNST_MOVE_CARET | 46,
  MOVE_SPEC_SUB: FNST_MOVE_CARET | 47,
  MOVE_OPEN_SPEC_SUB: FNST_MOVE_CARET | 48,
  MOVE_CLOSE_SPEC_SUB: FNST_MOVE_CARET | 49,
  MOVE_OPEN_SPEC_SUB_GRP: FNST_MOVE_CARET | 50,
  MOVE_BACK_SUB: FNST_MOVE_CARET | 67,
  VIEW_DLLCMD_TAB: FNST_OTHER | 10,
  RELINK: FNST_OTHER | 50,
  GOTO_LAST_MODI_PLACE: FNST_OTHER | 51,
};

const type = async () => (await call("debug.callIdeFunction", { fn: F.MOVE_TOP })).activeWindowType;
const press = async (fn) => (await call("debug.callIdeFunction", { fn })).activeWindowType;

await call("project.open", { path: projectPath, saveCurrent: false });
await new Promise((r) => setTimeout(r, 1500));
console.log(`打开工程后: ${await type()}`);

console.log("\n把光标放到 DLL 表第 1 行（EUI_MCP_RunA），然后试各种跳转：");
for (const row of [1, 10, 17, 24]) {
  await call("code.move", { direction: "row", row, column: 0 });
  const spec = await press(F.MOVE_SPEC_SUB);
  const back = await press(F.MOVE_BACK_SUB);
  const open = await press(F.MOVE_OPEN_SPEC_SUB);
  const grp = await press(F.MOVE_OPEN_SPEC_SUB_GRP);
  const relink = await press(F.RELINK);
  console.log(`  row=${row}: SPEC_SUB=${spec} BACK_SUB=${back} OPEN_SPEC_SUB=${open} OPEN_GRP=${grp} RELINK=${relink}`);
}

console.log("\n回到 DLL 表后再试 UNIT 系列：");
await press(F.VIEW_DLLCMD_TAB);
console.log(`  起点=${await type()}`);
for (const name of ["MOVE_TOP", "MOVE_PREV_UNIT", "MOVE_NEXT_UNIT", "MOVE_OPEN_SPEC_SUB", "MOVE_CLOSE_SPEC_SUB", "MOVE_BACK_SUB"]) {
  console.log(`  ${name} -> ${await press(F[name])}`);
}

console.log("\n反复 NEXT_UNIT 看是否最终到 1：");
await press(F.VIEW_DLLCMD_TAB);
const seq = [];
for (let i = 0; i < 20; i += 1) seq.push(await press(F.MOVE_NEXT_UNIT));
console.log(`  ${seq.join(",")}`);
