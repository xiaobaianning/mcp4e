// 测试阶段 4：部署 eui_runtime.dll → 写脚手架 → 编译 → 运行。
// 用法：node scripts/test-ui-run.mjs （或双击 test-ui-run.bat）
import net from "node:net";
import path from "node:path";
import { existsSync } from "node:fs";

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
    const timer = setTimeout(() => finish(new Error(`调用超时: ${method}`)), 180000);
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

const project = await call("project.getActive");
const projectDir = path.dirname(project.projectPath);
const documentName = path.basename(project.projectPath).replace(/\.[^.]+$/, "") + ".eui.json";
const filePath = path.join(projectDir, documentName);
console.log(`工程: ${project.projectPath}`);
console.log(`界面文档: ${documentName}`);
console.log(`revision: ${project.revision}\n`);

if (!existsSync(filePath)) {
  console.log(`界面文档不存在，生成演示文档: ${filePath}`);
  const { createDocument, applyUiOperations } = await import("../server/dist/ui-store.js");
  let versioned = await createDocument(filePath, "MCP 界面测试");
  versioned = await applyUiOperations(filePath, versioned.revision, [
    { action: "upsert", control: { id: "label_title", type: "label", name: "label_title", text: "这是由 MCP 生成的界面", variant: "title", x: 24, y: 20, width: 500, height: 36 } },
    { action: "upsert", control: { id: "edit_input", type: "text", name: "edit_input", text: "", x: 24, y: 70, width: 400, height: 30 } },
    { action: "upsert", control: { id: "btn_hello", type: "button", name: "btn_hello", text: "点我", variant: "primary", x: 440, y: 70, width: 120, height: 30 } },
    { action: "upsert", control: { id: "txt_log", type: "textarea", name: "txt_log", text: "", x: 24, y: 120, width: 536, height: 260 } },
    { action: "bind", controlId: "btn_hello", event: "click", handler: "_按钮_点我_被单击" },
  ]);
  console.log(`已生成，控件数: ${versioned.document.controls.length}\n`);
}

console.log("1) 部署 eui_runtime.dll ...");
console.log(JSON.stringify(await call("code.deployRuntime", { projectDir }), null, 2));

console.log("\n2) 写入脚手架 ...");
console.log(JSON.stringify(await call("code.syncUiScaffold", { documentName, commands }), null, 2));

console.log("\n3) 编译 ...");
console.log(JSON.stringify(await call("build.compile", { expectedRevision: project.revision, waitMs: 5000 }), null, 2));

console.log("\n4) 运行 ...");
const after = await call("project.getActive");
console.log(JSON.stringify(await call("build.run", { expectedRevision: after.revision }), null, 2));
