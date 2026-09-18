// 端到端测试「从模板新建工程 → 部署运行时 → 编译 → 运行」。
// 用法：node scripts/test-new-ui-project.mjs [目标工程路径]
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PIPE = process.env.E_LANG_MCP_PIPE ?? "\\\\.\\pipe\\e-lang-code-mcp";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(repoRoot, "templates", "windows-ui.e");
const targetPath = process.argv[2] ?? `E:\\mcp4e\\testmcp\\uitest_${Date.now()}.e`;

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

// 1) 从模板复制出新工程（用新文件名，不删 IDE 可能正打开的文件）
if (fs.existsSync(targetPath)) {
  throw new Error(`目标已存在，请换个路径（避免删除 IDE 正在打开的文件）: ${targetPath}`);
}
fs.copyFileSync(templatePath, targetPath);
console.log(`[1] 从模板新建: ${targetPath}  (${fs.statSync(targetPath).size} bytes)`);

// 2) 让 IDE 打开（saveCurrent 必须先保存，否则易语言会弹“是否保存”模态框卡住）
console.log("[2] 打开工程");
try {
  await call("build.stop");
} catch (error) {
  console.log(`  (停止旧程序失败: ${error.message})`);
}
await sleep(800);
console.log(JSON.stringify(await call("project.open", { path: targetPath, saveCurrent: true })));
await sleep(1500);

// 3) 生成同名 .eui.json
const uiPath = path.join(path.dirname(targetPath), `${path.basename(targetPath, ".e")}.eui.json`);
if (!fs.existsSync(uiPath)) {
  const { createDocument, applyUiOperations } = await import("../server/dist/ui-store.js");
  let versioned = await createDocument(uiPath, "MCP 界面测试");
  versioned = await applyUiOperations(uiPath, versioned.revision, [
    { action: "upsert", control: { id: "label_title", type: "label", name: "label_title", text: "这是由 MCP 生成的界面", variant: "title", x: 24, y: 20, width: 500, height: 36 } },
    { action: "upsert", control: { id: "edit_input", type: "text", name: "edit_input", text: "", x: 24, y: 70, width: 400, height: 30 } },
    { action: "upsert", control: { id: "btn_hello", type: "button", name: "btn_hello", text: "点我", variant: "primary", x: 440, y: 70, width: 120, height: 30 } },
    { action: "upsert", control: { id: "txt_log", type: "textarea", name: "txt_log", text: "", x: 24, y: 120, width: 536, height: 260 } },
    { action: "bind", controlId: "btn_hello", event: "click", handler: "_按钮_点我_被单击" },
  ]);
  console.log(`[3] 生成界面文档: ${uiPath}  (${versioned.document.controls.length} 个控件)`);
} else {
  console.log(`[3] 界面文档已存在: ${uiPath}`);
}

// 4) 写脚手架（会把语句里的文档名改成新工程的）
console.log("[4] 写脚手架");
console.log(JSON.stringify(await call("code.syncUiScaffold", {
  documentName: path.basename(uiPath),
  commands,
}), null, 2));

// 5) 部署运行时
console.log("\n[5] 部署 eui_runtime.dll");
console.log(JSON.stringify(await call("code.deployRuntime", { projectDir: path.dirname(targetPath) }), null, 2));

// 6) 编译
const active = await call("project.getActive");
console.log("\n[6] 编译");
const compiled = await call("build.compile", { expectedRevision: active.revision, waitMs: 6000 });
console.log(JSON.stringify(compiled, null, 2));

// 7) 运行
console.log("\n[7] 运行");
const after = await call("project.getActive");
console.log(JSON.stringify(await call("build.run", { expectedRevision: after.revision }), null, 2));
console.log("\n如果窗口弹出来了 → 阶段 4 完成 ✅");
