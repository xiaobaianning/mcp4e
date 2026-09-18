// 阶段 1 离线自测：验证 .eui.json 的创建/改控件/批量/绑定/窗体/修订冲突。
// 需要先构建 server（cd server && npm run build）。
// 用法：node scripts/test-ui.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDocument,
  readDocument,
  upsertControl,
  bindEvent,
  applyUiOperations,
  removeControl,
  updateForm,
} from "../server/dist/ui-store.js";

const dir = await mkdtemp(path.join(tmpdir(), "eui-"));
const file = path.join(dir, "demo.eui.json");
const short = (value) => value.slice(0, 12);

let { revision } = await createDocument(file, "测试窗口");
console.log(`create       revision=${short(revision)} controls=0`);

let versioned = await upsertControl(file, revision, {
  id: "btn_open",
  type: "button",
  name: "btn_open",
  text: "选择文件",
  x: 20,
  y: 20,
  width: 120,
  height: 28,
});
revision = versioned.revision;
console.log(`upsert       revision=${short(revision)} controls=${versioned.document.controls.length}`);

versioned = await applyUiOperations(file, revision, [
  { action: "upsert", control: { id: "edit_file", type: "text", name: "edit_file", text: "", x: 20, y: 60, width: 400, height: 28 } },
  { action: "upsert", control: { id: "txt_result", type: "textarea", name: "txt_result", text: "", x: 20, y: 100, width: 600, height: 300 } },
  { action: "bind", controlId: "btn_open", event: "click", handler: "_按钮_选择文件_被单击" },
]);
revision = versioned.revision;
console.log(`batch        revision=${short(revision)} controls=${versioned.document.controls.length}`);

versioned = await updateForm(file, revision, { title: "文件哈希工具", width: 800 });
revision = versioned.revision;
console.log(`set_form     revision=${short(revision)} title=${versioned.document.form.title}`);

const read = await readDocument(file);
if (read.revision !== revision) throw new Error("读回修订号不一致");
console.log(`read         revision=${short(read.revision)} OK`);

console.log("\n--- 生成的 .eui.json ---");
console.log(JSON.stringify(read.document, null, 2).split("\n").slice(0, 40).join("\n"));

let rejected = false;
try {
  await removeControl(file, "deadbeefdeadbeef", "btn_open");
} catch {
  rejected = true;
}
if (!rejected) throw new Error("过期修订号本应被拒绝，但没有");
console.log("\n修订号冲突检测 OK（过期修订号被拒绝）");

await rm(dir, { recursive: true, force: true });
console.log("\n✅ 阶段 1（UI 文档管理）测试通过");
