import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, constants, copyFile, mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeClient } from "./pipe-client.js";
import { assertEasyProjectPath, sidecarPath } from "./paths.js";
import { controlSchema, eventTypes } from "./schema.js";
import {
  applyUiOperations,
  bindEvent,
  createDocument,
  documentExists,
  readDocument,
  removeControl,
  updateForm,
  upsertControl,
  type UiBatchOperation,
} from "./ui-store.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const execute = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const codeCellKinds = [
  "module",
  "subprogram",
  "dllCommand",
  "argument",
  "localVariable",
  "globalVariable",
  "statement",
] as const;

function output(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

// 取当前活动工程的 .eui.json 路径。
async function activeUiPath(client: BridgeClient): Promise<string> {
  const project = await client.call<{ projectPath: string }>("project.getActive");
  return sidecarPath(project.projectPath);
}

// 控件输入（runtimeId 可选，新增时自动分配）。
const controlInputSchema = controlSchema.omit({ runtimeId: true }).extend({
  runtimeId: z.number().int().min(1000).max(65534).optional(),
});

// 界面脚手架需要的 EUI 运行时 DLL 声明。
const euiDllCommands = [
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

// 工程模板类型（模板文件为 templates/<type>.e）。
const projectTemplateTypes = ["windows-window", "windows-console", "windows-ui"] as const;

// 依次尝试内置/环境变量指定的模板目录。
async function findTemplateDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.E_LANGUAGE_PROJECT_TEMPLATE_DIR,
    path.join(moduleDirectory, "templates"),
    path.join(moduleDirectory, "..", "templates"),
    path.join(moduleDirectory, "..", "..", "templates"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return path.resolve(candidate);
    } catch {
      // 试下一个候选目录
    }
  }
  throw new Error(
    "找不到工程模板目录：请把模板 .e 放到 server/templates/，或设置环境变量 E_LANGUAGE_PROJECT_TEMPLATE_DIR。",
  );
}

export function registerTools(server: McpServer, client: BridgeClient): void {
  server.registerTool(
    "ide_status",
    {
      title: "易语言 IDE 桥接状态",
      description: "读取易语言 IDE 桥接是否已连接，不修改工程。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => output(await client.call("ide.status")),
  );

  server.registerTool(
    "project_get_active",
    {
      title: "读取活动易语言工程",
      description: "返回 IDE 当前打开且已保存的 .e/.e8 工程路径与代码修订号。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => output(await client.call("project.getActive")),
  );

  server.registerTool(
    "project_new",
    {
      title: "从模板新建易语言工程",
      description:
        "把内置 .e 模板复制到目标路径并由 IDE 打开（目标已存在则拒绝），随后创建同名 .eui.json 并写入界面脚手架。不修改任何已有工程；推荐用 windows-ui 模板。",
      inputSchema: {
        type: z.enum(projectTemplateTypes).default("windows-ui"),
        path: z.string().min(1).describe("目标 .e 工程的完整路径"),
        saveCurrent: z.boolean().default(true).describe("打开前先保存当前工程，避免弹保存确认框"),
        uiTitle: z.string().min(1).max(256).optional().describe("窗体标题；默认用工程名"),
      },
      annotations: write,
    },
    async ({ type, path: targetPath, saveCurrent, uiTitle }) => {
      const resolved = assertEasyProjectPath(targetPath);
      if (path.extname(resolved).toLowerCase() !== ".e") {
        throw new Error(`模板式新建目前只支持 .e 工程: ${resolved}`);
      }
      const directory = await findTemplateDirectory();
      const templatePath = path.join(directory, `${type}.e`);
      await access(templatePath, constants.R_OK).catch(() => {
        throw new Error(`模板不存在: ${templatePath}`);
      });
      await mkdir(path.dirname(resolved), { recursive: true });
      await copyFile(templatePath, resolved, constants.COPYFILE_EXCL);
      try {
        const opened = await client.call("project.open", { path: resolved, saveCurrent });
        const uiPath = sidecarPath(resolved);
        if (!(await documentExists(uiPath))) {
          await createDocument(uiPath, uiTitle ?? path.basename(resolved, ".e"));
        }
        const scaffold = await client.call<Record<string, unknown>>("code.syncUiScaffold", {
          documentName: path.basename(uiPath),
          commands: euiDllCommands,
        });
        return output({ template: templatePath, projectPath: resolved, opened, uiPath, scaffold });
      } catch (error) {
        await rm(resolved, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  );

  // ------------------------------------------------------------------ UI 文档
  server.registerTool(
    "ui_get_document",
    {
      title: "读取界面文档",
      description: "读取当前工程的 .eui.json 界面文档与修订号（不修改）。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const filePath = await activeUiPath(client);
      const { document, revision } = await readDocument(filePath);
      return output({ path: filePath, revision, document });
    },
  );

  server.registerTool(
    "ui_attach",
    {
      title: "创建界面文档",
      description: "为当前工程创建同名 .eui.json 界面文档（已存在则直接返回，不覆盖）。",
      inputSchema: { title: z.string().min(1).max(256).optional().describe("窗体标题；默认用工程名") },
      annotations: write,
    },
    async ({ title }) => {
      const project = await client.call<{ projectPath: string; projectTitle: string }>("project.getActive");
      const filePath = sidecarPath(project.projectPath);
      if (await documentExists(filePath)) {
        const { document, revision } = await readDocument(filePath);
        return output({ path: filePath, revision, document, created: false });
      }
      const fallbackTitle = title ?? path.basename(project.projectPath, path.extname(project.projectPath));
      const { document, revision } = await createDocument(filePath, fallbackTitle);
      return output({ path: filePath, revision, document, created: true });
    },
  );

  server.registerTool(
    "ui_set_form",
    {
      title: "设置窗体",
      description: "修改窗体标题 / 尺寸 / 是否可缩放（带修订号校验）。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        title: z.string().min(1).max(256).optional(),
        width: z.number().int().min(240).max(7680).optional(),
        height: z.number().int().min(160).max(4320).optional(),
        resizable: z.boolean().optional(),
      },
      annotations: write,
    },
    async ({ expectedRevision, ...patch }) => {
      const filePath = await activeUiPath(client);
      const versioned = await updateForm(filePath, expectedRevision, patch);
      return output({ path: filePath, revision: versioned.revision, form: versioned.document.form });
    },
  );

  server.registerTool(
    "ui_upsert_control",
    {
      title: "新增或更新界面控件",
      description: "按稳定控件 ID 新增或更新一个控件（label/button/text/textarea/checkbox/combobox），带修订号校验。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        control: controlInputSchema,
      },
      annotations: write,
    },
    async ({ expectedRevision, control }) => {
      const filePath = await activeUiPath(client);
      const versioned = await upsertControl(
        filePath,
        expectedRevision,
        control as Omit<import("./schema.js").Control, "runtimeId"> & { runtimeId?: number | undefined },
      );
      return output({ path: filePath, revision: versioned.revision, document: versioned.document });
    },
  );

  server.registerTool(
    "ui_apply_batch",
    {
      title: "批量修改界面",
      description: "一次提交多个控件新增/更新/删除与事件绑定，只写一次文档并返回新修订号。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        operations: z
          .array(
            z.discriminatedUnion("action", [
              z.object({ action: z.literal("upsert"), control: controlInputSchema }),
              z.object({ action: z.literal("remove"), controlId: z.string().min(1) }),
              z.object({
                action: z.literal("bind"),
                controlId: z.string().min(1),
                event: z.enum(eventTypes),
                handler: z.string().min(1).max(128),
              }),
            ]),
          )
          .min(1)
          .max(1000),
      },
      annotations: write,
    },
    async ({ expectedRevision, operations }) => {
      const filePath = await activeUiPath(client);
      const versioned = await applyUiOperations(filePath, expectedRevision, operations as UiBatchOperation[]);
      return output({ path: filePath, revision: versioned.revision, document: versioned.document });
    },
  );

  server.registerTool(
    "ui_remove_control",
    {
      title: "删除界面控件",
      description: "按控件 ID 删除控件（带修订号校验）。",
      inputSchema: { expectedRevision: z.string().min(8), controlId: z.string().min(1) },
      annotations: write,
    },
    async ({ expectedRevision, controlId }) => {
      const filePath = await activeUiPath(client);
      const versioned = await removeControl(filePath, expectedRevision, controlId);
      return output({ path: filePath, revision: versioned.revision, document: versioned.document });
    },
  );

  server.registerTool(
    "ui_bind_event",
    {
      title: "绑定控件事件",
      description: "把控件事件（click/textChanged/…）绑定到易语言处理子程序；窗体用 controlId=\"main\"。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        controlId: z.string().min(1),
        event: z.enum(eventTypes),
        handler: z.string().min(1).max(128),
      },
      annotations: write,
    },
    async ({ expectedRevision, controlId, event, handler }) => {
      const filePath = await activeUiPath(client);
      const versioned = await bindEvent(filePath, expectedRevision, controlId, event, handler);
      return output({ path: filePath, revision: versioned.revision, document: versioned.document });
    },
  );

  server.registerTool(
    "ui_sync_code",
    {
      title: "写入界面脚手架代码",
      description:
        "把 EUI 运行时 DLL 声明、启动子程序（EUI_启动界面，含 EUI_MCP_RunA 调用）、事件回调（EUI_事件回调，含 3 个整数型参数）与入口调用写入当前工程已有的程序集；已存在则跳过（幂等）。需先 ui_attach 创建 .eui.json。",
      inputSchema: {},
      annotations: write,
    },
    async () => {
      const project = await client.call<{ projectPath: string }>("project.getActive");
      const filePath = sidecarPath(project.projectPath);
      const documentName = path.basename(filePath);
      const result = await client.call<Record<string, unknown>>("code.syncUiScaffold", {
        documentName,
        commands: euiDllCommands,
      });
      return output({ path: filePath, documentName, ...result });
    },
  );

  server.registerTool(
    "ui_run",
    {
      title: "部署并运行界面程序",
      description:
        "一键：部署 eui_runtime.dll（IDE 目录 + 工程目录）→ 写入脚手架 → 编译 → 运行。需先 ui_attach。",
      inputSchema: {
        expectedRevision: z.string().min(8).optional(),
        syncScaffold: z.boolean().default(true),
        compileOnly: z.boolean().default(false),
        waitMs: z.number().int().min(0).max(60_000).default(3_000),
      },
      annotations: execute,
    },
    async ({ expectedRevision, syncScaffold, compileOnly, waitMs }) => {
      const project = await client.call<{ projectPath: string; revision: string }>("project.getActive");
      const filePath = sidecarPath(project.projectPath);
      if (!(await documentExists(filePath))) {
        throw new Error(`界面文档不存在，请先 ui_attach：${filePath}`);
      }
      const deploy = await client.call("code.deployRuntime", {
        projectDir: path.dirname(project.projectPath),
      });
      const scaffold = syncScaffold
        ? await client.call<Record<string, unknown>>("code.syncUiScaffold", {
            documentName: path.basename(filePath),
            commands: euiDllCommands,
          })
        : null;
      const revision = expectedRevision ?? project.revision;
      const compiled = await client.call("build.compile", { expectedRevision: revision, waitMs });
      let run: unknown = null;
      if (!compileOnly) {
        const afterCompile = await client.call<{ revision: string }>("project.getActive");
        run = await client.call("build.run", { expectedRevision: afterCompile.revision });
      }
      return output({ path: filePath, projectPath: project.projectPath, deploy, scaffold, compile: compiled, run });
    },
  );

  server.registerTool(
    "code_read_current",
    {
      title: "读取当前代码单元",
      description: "通过官方 FN_GET_PRG_TEXT 读取当前活动代码表，并返回修订号。",
      inputSchema: {
        maxRows: z.number().int().min(1).max(20_000).default(5_000),
        includeEmptyCells: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("code.readCurrent", params)),
  );

  server.registerTool(
    "code_read_range",
    {
      title: "读取易语言代码范围",
      description: "读取指定绝对行范围的代码，不修改工程，适合大代码表的精确定位。",
      inputSchema: {
        startRow: z.number().int().min(0).max(20_000),
        rowCount: z.number().int().min(1).max(5_000).default(128),
        maxRows: z.number().int().min(1).max(20_000).default(5_000),
        includeEmptyCells: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("code.readRange", params)),
  );

  server.registerTool(
    "code_apply_current",
    {
      title: "修改当前代码单元",
      description:
        "按行列修改当前代码表；修订冲突、目标类型不符或写后回读不一致时拒绝并自动回滚。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        edits: z
          .array(
            z.object({
              row: z.number().int().min(0),
              column: z.number().int().min(0).max(15),
              text: z.string().max(32_768),
              expectedKind: z.enum(codeCellKinds).optional(),
            }),
          )
          .min(1)
          .max(1_000),
      },
      annotations: write,
    },
    async (params) => output(await client.call("code.applyCurrent", params)),
  );

  server.registerTool(
    "code_batch",
    {
      title: "批量编辑原生易语言代码",
      description:
        "一次提交多项结构插入与单元格修改；严格校验代码单元类型，失败时自动撤销整批。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        operations: z
          .array(
            z.discriminatedUnion("action", [
              z.object({
                action: z.literal("edit"),
                row: z.number().int().min(0),
                column: z.number().int().min(0).max(15),
                text: z.string().max(32_768),
                expectedKind: z.enum(codeCellKinds).optional(),
              }),
              z.object({
                action: z.literal("insert"),
                kind: z.enum([
                  "module",
                  "subprogram",
                  "dllCommand",
                  "argument",
                  "localVariable",
                  "globalVariable",
                  "statement",
                  "statementAfter",
                ]),
                edits: z
                  .array(
                    z.object({
                      rowOffset: z.number().int().min(-32).max(32).default(0),
                      column: z.number().int().min(0).max(15),
                      text: z.string().min(1).max(32_768),
                    }),
                  )
                  .min(1)
                  .max(32),
              }),
            ]),
          )
          .min(1)
          .max(2_000),
      },
      annotations: write,
    },
    async (params) => output(await client.call("code.batch", params)),
  );

  server.registerTool(
    "code_move",
    {
      title: "移动代码光标",
      description: "通过官方导航接口移动代码表光标，不模拟键鼠输入。",
      inputSchema: {
        direction: z.enum(["top", "bottom", "up", "down", "row", "previousUnit", "nextUnit"]),
        row: z.number().int().min(0).max(20_000).optional(),
        column: z.number().int().min(0).max(15).default(0),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("code.move", params)),
  );

  server.registerTool(
    "code_undo",
    {
      title: "撤销上一次代码改动",
      description: "通过官方 FN_UNDO 撤销一次代码修改，并返回新的修订号。",
      inputSchema: {},
      annotations: write,
    },
    async () => output(await client.call("code.undo")),
  );

  server.registerTool(
    "project_save",
    {
      title: "保存易语言工程",
      description: "通过官方 FN_SAVE_FILE 保存当前工程。",
      inputSchema: { expectedRevision: z.string().min(8) },
      annotations: write,
    },
    async (params) => output(await client.call("project.save", params)),
  );

  server.registerTool(
    "build_compile",
    {
      title: "编译易语言工程",
      description: "先保存再编译当前工程，并返回只读采集的诊断文本。编译是异步的，可用 waitMs 等待后再采集。",
      inputSchema: {
        expectedRevision: z.string().min(8),
        staticBuild: z.boolean().default(false),
        waitMs: z.number().int().min(0).max(60_000).default(0),
      },
      annotations: execute,
    },
    async (params) => output(await client.call("build.compile", params)),
  );

  server.registerTool(
    "build_run",
    {
      title: "编译运行易语言工程",
      description: "通过官方 FN_COMPILE_AND_RUN 编译并运行当前工程。",
      inputSchema: { expectedRevision: z.string().min(8) },
      annotations: execute,
    },
    async (params) => output(await client.call("build.run", params)),
  );

  server.registerTool(
    "build_stop",
    {
      title: "停止易语言程序",
      description: "通过官方 FN_END_RUN 停止当前调试程序。",
      inputSchema: {},
      annotations: execute,
    },
    async () => output(await client.call("build.stop")),
  );

  server.registerTool(
    "build_get_diagnostics",
    {
      title: "读取编译诊断",
      description: "只读采集易语言 IDE 输出控件文本，不发送窗口输入。可用 waitMs 等待编译完成后再采集。",
      inputSchema: {
        waitMs: z.number().int().min(0).max(60_000).default(0),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("build.getDiagnostics", params)),
  );

  server.registerTool(
    "lib_list_libraries",
    {
      title: "列出已加载的支持库",
      description: "列出当前工程已选择的支持库及其信息文本（官方 FN_GET_NUM_LIB / FN_GET_LIB_INFO_TEXT）。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => output(await client.call("lib.listLibraries")),
  );

  server.registerTool(
    "lib_list_ecoms",
    {
      title: "列出已加载的易模块",
      description: "列出当前工程已使用的易模块 .ec 文件（官方 FN_GET_NUM_ECOM / FN_GET_ECOM_FILE_NAME）。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => output(await client.call("lib.listEcoms")),
  );

  server.registerTool(
    "lib_search_commands",
    {
      title: "搜索支持库命令",
      description:
        "按关键词按需搜索已加载支持库/易模块提供的命令，返回命令名、参数名与参数类型。写代码前需要确认某类命令时再调用，避免一次拉取全部命令浪费上下文。",
      inputSchema: {
        keyword: z.string().default("").describe("关键词，匹配命令名（中/英）；留空则返回前 limit 条"),
        limit: z.number().int().min(1).max(500).default(50),
        searchExplain: z.boolean().default(false).describe("是否同时匹配命令说明"),
        includeTree: z.boolean().default(true).describe("是否同时包含 IDE 支持库命令树（可搜到 .ec 易模块命令）"),
        treeIndex: z.number().int().min(-1).default(-1).describe("限定某个命令树索引；-1 表示全部"),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("lib.searchCommands", params)),
  );

  server.registerTool(
    "lib_read_ecom_strings",
    {
      title: "抽取易模块(.ec)字符串",
      description:
        "读取 .ec 文件并从二进制里抽取 GBK 明文字符串（通常是命令名/类型名）。属于半逆向，用于了解易模块提供了哪些命令。传 path 或先调用 lib_list_ecoms 获取已加载模块路径。",
      inputSchema: {
        path: z.string().min(1).describe(".ec 文件的完整路径"),
        minChars: z.number().int().min(1).max(100).default(2),
        maxStrings: z.number().int().min(1).max(50_000).default(5_000),
        mode: z.enum(["anchored", "blind"]).default("anchored").describe("anchored=按 [长度][字节] 结构解析（推荐）；blind=盲扫"),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("lib.readEcomStrings", params)),
  );

  server.registerTool(
    "lib_search_ecom_commands",
    {
      title: "搜索易模块(.ec)命令",
      description:
        "解析易模块 .ec 里的命令与参数（含类型），返回可直接使用的签名（如 `文本_取随机字符 (长度, 类型) -> 文本型`）。默认搜当前工程加载的所有 .ec；写代码需要用到易模块命令时再调用。",
      inputSchema: {
        keyword: z.string().default("").describe("关键词，匹配命令名/参数名；留空返回前 limit 条"),
        limit: z.number().int().min(1).max(1000).default(100),
        path: z.string().default("").describe("可选：指定某个 .ec 文件；留空则用当前工程加载的所有 .ec"),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("lib.searchEcomCommands", params)),
  );

  server.registerTool(
    "lib_inspect_ecom",
    {
      title: "十六进制查看 .ec（调试）",
      description: "导出 .ec 文件指定位置（或某字符串附近）的十六进制转储，用于分析字符串表结构。",
      inputSchema: {
        path: z.string().min(1),
        needle: z.string().default("").describe("定位到包含该文本的位置；留空则从文件开头"),
        context: z.number().int().min(16).max(16384).default(256),
      },
      annotations: readOnly,
    },
    async (params) => output(await client.call("lib.inspectEcom", params)),
  );

  server.registerTool(
    "lib_list_trees",
    {
      title: "列出 IDE 命令树（调试）",
      description: "列出 IDE 里的所有 SysTreeView32 命令树及其条目数与样例，用于确认哪个是“支持库”树。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => output(await client.call("lib.listTrees")),
  );

  server.registerTool(
    "debug_dump_windows",
    {
      title: "导出 IDE 窗口树（调试）",
      description: "枚举易语言 IDE 的所有子窗口（类名/标题/文本长度），用于定位“输出”面板等控件。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => output(await client.call("debug.dumpWindows")),
  );
}
