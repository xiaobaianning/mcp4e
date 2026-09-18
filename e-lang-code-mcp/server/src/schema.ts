import { z } from "zod";

/** 支持的控件类型（运行时由 eui_runtime.dll 渲染为原生 Win32 控件）。 */
export const controlTypes = [
  "label",
  "button",
  "text",
  "textarea",
  "checkbox",
  "combobox",
] as const;

/** 支持的事件类型。 */
export const eventTypes = [
  "created",
  "closing",
  "timer",
  "click",
  "textChanged",
  "checkedChanged",
  "selectionChanged",
] as const;

export const eventBindingSchema = z.object({
  event: z.enum(eventTypes),
  handler: z.string().min(1).max(128),
});

export const controlSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).describe("稳定字符串 ID（字母开头）"),
  runtimeId: z.number().int().min(1000).max(65534).describe("运行时控件编号（唯一）"),
  type: z.enum(controlTypes),
  name: z.string().min(1).max(64),
  text: z.string().max(4096).default(""),
  variant: z.enum(["default", "title", "section", "muted", "accent", "primary"]).default("default"),
  x: z.number().int().min(0).max(16384),
  y: z.number().int().min(0).max(16384),
  width: z.number().int().min(16).max(16384),
  height: z.number().int().min(16).max(16384),
  visible: z.boolean().default(true),
  enabled: z.boolean().default(true),
  tabIndex: z.number().int().min(0).max(32767).default(0),
  checked: z.boolean().optional(),
  items: z.array(z.string().max(512)).max(1000).optional(),
  selectedIndex: z.number().int().min(-1).max(999).optional(),
  events: z.array(eventBindingSchema).default([]),
});

export const themeSchema = z.object({
  background: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F5F5F2"),
  surface: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#FFFFFF"),
  text: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#1D1D1F"),
  muted: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6E6E73"),
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#167D76"),
  border: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#D7D7D2"),
  fontFace: z.string().min(1).max(64).default("Microsoft YaHei UI"),
  fontSize: z.number().int().min(8).max(24).default(10),
});

export const defaultTheme = {
  background: "#F5F5F2",
  surface: "#FFFFFF",
  text: "#1D1D1F",
  muted: "#6E6E73",
  accent: "#167D76",
  border: "#D7D7D2",
  fontFace: "Microsoft YaHei UI",
  fontSize: 10,
};

export const uiDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(0),
    form: z.object({
      id: z.literal("main"),
      title: z.string().min(1).max(256),
      width: z.number().int().min(240).max(7680),
      height: z.number().int().min(160).max(4320),
      resizable: z.boolean().default(true),
      events: z.array(eventBindingSchema).default([]),
    }),
    theme: themeSchema.default(defaultTheme),
    controls: z.array(controlSchema).max(512),
  })
  .superRefine((document, context) => {
    const stringIds = new Set<string>();
    const runtimeIds = new Set<number>();
    const formEvents = new Set<string>();
    for (const [index, binding] of document.form.events.entries()) {
      if (binding.event !== "created" && binding.event !== "closing" && binding.event !== "timer") {
        context.addIssue({ code: "custom", message: `窗体不支持事件 ${binding.event}`, path: ["form", "events", index, "event"] });
      }
      if (formEvents.has(binding.event)) {
        context.addIssue({ code: "custom", message: `窗体事件重复: ${binding.event}`, path: ["form", "events", index, "event"] });
      }
      formEvents.add(binding.event);
    }

    const eventsByType: Record<(typeof controlTypes)[number], readonly string[]> = {
      label: [],
      button: ["click"],
      text: ["textChanged"],
      textarea: ["textChanged"],
      checkbox: ["checkedChanged"],
      combobox: ["selectionChanged"],
    };

    for (const [index, control] of document.controls.entries()) {
      if (stringIds.has(control.id)) {
        context.addIssue({ code: "custom", message: `控件 id 重复: ${control.id}`, path: ["controls", index, "id"] });
      }
      if (runtimeIds.has(control.runtimeId)) {
        context.addIssue({ code: "custom", message: `runtimeId 重复: ${control.runtimeId}`, path: ["controls", index, "runtimeId"] });
      }
      stringIds.add(control.id);
      runtimeIds.add(control.runtimeId);

      const boundEvents = new Set<string>();
      for (const [eventIndex, binding] of control.events.entries()) {
        if (!eventsByType[control.type].includes(binding.event)) {
          context.addIssue({
            code: "custom",
            message: `${control.type} 不支持事件 ${binding.event}`,
            path: ["controls", index, "events", eventIndex, "event"],
          });
        }
        if (boundEvents.has(binding.event)) {
          context.addIssue({ code: "custom", message: `控件事件重复: ${binding.event}`, path: ["controls", index, "events", eventIndex, "event"] });
        }
        boundEvents.add(binding.event);
      }

      if (control.type === "combobox" && control.selectedIndex !== undefined && control.selectedIndex >= (control.items?.length ?? 0)) {
        context.addIssue({ code: "custom", message: "组合框 selectedIndex 超出 items", path: ["controls", index, "selectedIndex"] });
      }
    }
  });

export type Control = z.infer<typeof controlSchema>;
export type UiDocument = z.infer<typeof uiDocumentSchema>;
export type EventType = (typeof eventTypes)[number];

export function createDefaultDocument(title: string): UiDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    form: { id: "main", title, width: 720, height: 480, resizable: true, events: [] },
    theme: { ...defaultTheme },
    controls: [],
  };
}

export function nextRuntimeId(document: UiDocument): number {
  return document.controls.reduce((next, control) => Math.max(next, control.runtimeId + 1), 1000);
}
