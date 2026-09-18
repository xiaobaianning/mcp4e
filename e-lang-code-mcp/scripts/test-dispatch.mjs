// 验证事件分发骨架：读 .eui.json 的绑定 → 传给 syncUiScaffold → 生成分派 + handler 子程序
// → 给 handler 写一个可观测的实现 → 运行 → 点按钮 → 读文本框内容。
// 用法：node scripts/test-dispatch.mjs
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(repoRoot, "templates", "windows-ui.e");
const targetPath = path.join("E:\\mcp4e\\testmcp", `dispatch_${Date.now()}.e`);

const eventCodes = { created: 1, closing: 2, click: 100, textChanged: 200, checkedChanged: 300, selectionChanged: 400, timer: 500 };

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 300000);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readCells = async () => (await call("code.readCurrent", { maxRows: 5000, includeEmptyCells: true })).cells ?? [];

const commands = [
  { name: "EUI_MCP_RunA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_RunA",
    args: [{ name: "界面文件", type: "文本型" }, { name: "事件回调", type: "子程序指针" }] },
  { name: "EUI_MCP_Close", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_Close", args: [] },
  { name: "EUI_MCP_SetTextA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetTextA",
    args: [{ name: "控件编号", type: "整数型" }, { name: "文本", type: "文本型" }] },
  { name: "EUI_MCP_GetTextPtrA", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_GetTextPtrA",
    args: [{ name: "控件编号", type: "整数型" }] },
  { name: "EUI_MCP_SetVisible", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetVisible",
    args: [{ name: "控件编号", type: "整数型" }, { name: "可视", type: "逻辑型" }] },
  { name: "EUI_MCP_SetEnabled", returnType: "整数型", library: "eui_runtime.dll", entryPoint: "EUI_SetEnabled",
    args: [{ name: "控件编号", type: "整数型" }, { name: "可用", type: "逻辑型" }] },
];

try { await call("build.stop"); } catch {}
await sleep(800);

// 1) 从模板新建
fs.copyFileSync(templatePath, targetPath);
console.log(`[1] 从模板新建 ${targetPath}`);
console.log(JSON.stringify(await call("project.open", { path: targetPath, saveCurrent: true })));
await sleep(1500);

// 2) 生成 .eui.json（按钮绑定 click → _按钮_点我_被单击）
const uiPath = targetPath.replace(/\.e$/, ".eui.json");
const { createDocument, applyUiOperations, readDocument } = await import("../server/dist/ui-store.js");
let versioned = await createDocument(uiPath, "分发骨架测试");
versioned = await applyUiOperations(uiPath, versioned.revision, [
  { action: "upsert", control: { id: "label_title", type: "label", name: "label_title", text: "事件分发测试", variant: "title", x: 24, y: 20, width: 500, height: 36 } },
  { action: "upsert", control: { id: "btn_hello", type: "button", name: "btn_hello", text: "点我", variant: "primary", x: 24, y: 70, width: 120, height: 30 } },
  { action: "upsert", control: { id: "txt_log", type: "textarea", name: "txt_log", text: "", x: 24, y: 120, width: 536, height: 260 } },
  { action: "bind", controlId: "btn_hello", event: "click", handler: "_按钮_点我_被单击" },
]);
console.log(`[2] 生成界面文档 (${versioned.document.controls.length} 控件)`);

// 3) 组装 events 并写脚手架
const document = (await readDocument(uiPath)).document;
const events = [
  ...document.form.events.map((b) => ({ runtimeId: 0, eventCode: eventCodes[b.event] ?? 0, handler: b.handler })),
  ...document.controls.flatMap((c) => c.events.map((b) => ({ runtimeId: c.runtimeId, eventCode: eventCodes[b.event] ?? 0, handler: b.handler }))),
];
console.log(`[3] events = ${JSON.stringify(events)}`);
const scaffold = await call("code.syncUiScaffold", { documentName: path.basename(uiPath), commands, events });
console.log(JSON.stringify(scaffold, null, 2));

// 4) 给 handler 写实现
console.log("\n[4] 给 handler 写实现");
await call("code.activateDocument", { titlePrefix: "程序集:" });
let cells = await readCells();
const handler = "_按钮_点我_被单击";
const handlerSub = cells.find((c) => c.type === 686 && !c.title && c.text === handler);
if (!handlerSub) throw new Error("分派骨架没有创建 handler 子程序");
const nextSub = cells.filter((c) => c.type === 686 && !c.title && c.row > handlerSub.row).sort((a, b) => a.row - b.row)[0];
const endRow = nextSub ? nextSub.row : 999999;
const slot = cells.find((c) => c.type === 851 && !c.title && c.row > handlerSub.row && c.row < endRow && c.text === "");
if (!slot) throw new Error("handler 里没有空白语句行");
const logTarget = document.controls.find((c) => c.id === "txt_log")?.runtimeId ?? 1002;
console.log(`文本框控件编号 = ${logTarget}`);
console.log(JSON.stringify(await call("code.applyCurrent", {
  expectedRevision: (await call("project.getActive")).revision,
  edits: [{ row: slot.row, column: 0, text: `EUI_MCP_SetTextA (${logTarget}, “分发成功：handler 被调用了”)` }],
})));

// 5) 部署 + 编译 + 保存 + 运行
console.log("\n[5] 部署 + 编译 + 运行");
console.log(JSON.stringify(await call("code.deployRuntime", { projectDir: path.dirname(targetPath) })));
await call("project.save", { expectedRevision: (await call("project.getActive")).revision });
console.log(JSON.stringify(await call("build.compile", { expectedRevision: (await call("project.getActive")).revision, waitMs: 5000 })).slice(0, 400));
console.log(JSON.stringify(await call("build.run", { expectedRevision: (await call("project.getActive")).revision })));
console.log(`\n工程: ${targetPath}`);
