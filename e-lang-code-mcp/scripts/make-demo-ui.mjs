// 生成一个演示用 .eui.json（4 个控件 + 按钮绑定 click）。
// 用法：node scripts/make-demo-ui.mjs [目标路径]
//   默认写到 E:\mcp4e\testmcp\demo.eui.json
import { rm } from "node:fs/promises";
import { createDocument, applyUiOperations, readDocument } from "../server/dist/ui-store.js";

const file = process.argv[2] ?? "E:\\mcp4e\\testmcp\\demo.eui.json";

await rm(file, { force: true });

let versioned = await createDocument(file, "MCP 界面测试");
versioned = await applyUiOperations(file, versioned.revision, [
  {
    action: "upsert",
    control: {
      id: "label_title", type: "label", name: "label_title",
      text: "这是由 MCP 生成的界面", variant: "title",
      x: 24, y: 20, width: 500, height: 36,
    },
  },
  {
    action: "upsert",
    control: {
      id: "edit_input", type: "text", name: "edit_input", text: "",
      x: 24, y: 70, width: 400, height: 30,
    },
  },
  {
    action: "upsert",
    control: {
      id: "btn_hello", type: "button", name: "btn_hello", text: "点我",
      variant: "primary",
      x: 440, y: 70, width: 120, height: 30,
    },
  },
  {
    action: "upsert",
    control: {
      id: "txt_log", type: "textarea", name: "txt_log", text: "",
      x: 24, y: 120, width: 536, height: 260,
    },
  },
  { action: "bind", controlId: "btn_hello", event: "click", handler: "_按钮_点我_被单击" },
]);

const read = await readDocument(file);
console.log(`已生成: ${file}`);
console.log(`控件数: ${read.document.controls.length}  revision: ${read.revision.slice(0, 12)}`);
for (const control of read.document.controls) {
  console.log(`  - ${control.id} (runtimeId=${control.runtimeId}, ${control.type})`);
}
