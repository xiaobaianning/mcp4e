import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertRevision, canonicalJson, documentRevision } from "./revision.js";
import {
  createDefaultDocument,
  nextRuntimeId,
  uiDocumentSchema,
  type Control,
  type EventType,
  type UiDocument,
} from "./schema.js";

export interface VersionedDocument {
  document: UiDocument;
  revision: string;
}

export type UiBatchOperation =
  | { action: "upsert"; control: Omit<Control, "runtimeId"> & { runtimeId?: number | undefined } }
  | { action: "remove"; controlId: string }
  | { action: "bind"; controlId: string; event: EventType; handler: string };

export async function documentExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readDocument(filePath: string): Promise<VersionedDocument> {
  const source = await readFile(filePath, "utf8");
  const document = uiDocumentSchema.parse(JSON.parse(source));
  return { document, revision: documentRevision(document) };
}

export async function createDocument(filePath: string, title: string): Promise<VersionedDocument> {
  const document = createDefaultDocument(title);
  await writeDocumentAtomic(filePath, document);
  return { document, revision: documentRevision(document) };
}

export async function mutateDocument(
  filePath: string,
  expectedRevision: string,
  mutate: (document: UiDocument) => UiDocument,
): Promise<VersionedDocument> {
  const current = await readDocument(filePath);
  assertRevision(current.revision, expectedRevision, path.basename(filePath));
  const next = uiDocumentSchema.parse(mutate(structuredClone(current.document)));
  next.revision = current.document.revision + 1;
  await writeDocumentAtomic(filePath, next);
  return { document: next, revision: documentRevision(next) };
}

function applyControlUpsert(
  document: UiDocument,
  control: Omit<Control, "runtimeId"> & { runtimeId?: number | undefined },
): void {
  const index = document.controls.findIndex((entry) => entry.id === control.id);
  const existing = index >= 0 ? document.controls[index] : undefined;
  const normalized = {
    ...control,
    events: control.events ?? [],
    runtimeId: control.runtimeId ?? existing?.runtimeId ?? nextRuntimeId(document),
  } as Control;
  if (index >= 0) document.controls[index] = normalized;
  else document.controls.push(normalized);
}

function applyBind(document: UiDocument, controlId: string, event: EventType, handler: string): void {
  if (controlId === document.form.id) {
    if (event !== "created" && event !== "closing" && event !== "timer") {
      throw new Error(`窗体不支持事件 ${event}`);
    }
    document.form.events = document.form.events.filter((binding) => binding.event !== event);
    document.form.events.push({ event, handler });
    return;
  }
  const control = document.controls.find((entry) => entry.id === controlId);
  if (!control) throw new Error(`找不到控件: ${controlId}`);
  control.events = (control.events ?? []).filter((binding) => binding.event !== event);
  control.events.push({ event, handler });
}

export async function upsertControl(
  filePath: string,
  expectedRevision: string,
  control: Omit<Control, "runtimeId"> & { runtimeId?: number | undefined },
): Promise<VersionedDocument> {
  return mutateDocument(filePath, expectedRevision, (document) => {
    applyControlUpsert(document, control);
    return document;
  });
}

export async function removeControl(
  filePath: string,
  expectedRevision: string,
  controlId: string,
): Promise<VersionedDocument> {
  return mutateDocument(filePath, expectedRevision, (document) => {
    const before = document.controls.length;
    document.controls = document.controls.filter((control) => control.id !== controlId);
    if (document.controls.length === before) throw new Error(`找不到控件: ${controlId}`);
    return document;
  });
}

export async function bindEvent(
  filePath: string,
  expectedRevision: string,
  controlId: string,
  event: EventType,
  handler: string,
): Promise<VersionedDocument> {
  return mutateDocument(filePath, expectedRevision, (document) => {
    applyBind(document, controlId, event, handler);
    return document;
  });
}

export async function applyUiOperations(
  filePath: string,
  expectedRevision: string,
  operations: UiBatchOperation[],
): Promise<VersionedDocument> {
  return mutateDocument(filePath, expectedRevision, (document) => {
    for (const operation of operations) {
      if (operation.action === "upsert") {
        applyControlUpsert(document, operation.control);
      } else if (operation.action === "remove") {
        const before = document.controls.length;
        document.controls = document.controls.filter((entry) => entry.id !== operation.controlId);
        if (document.controls.length === before) throw new Error(`找不到控件: ${operation.controlId}`);
      } else {
        applyBind(document, operation.controlId, operation.event, operation.handler);
      }
    }
    return document;
  });
}

export async function updateForm(
  filePath: string,
  expectedRevision: string,
  patch: { title?: string | undefined; width?: number | undefined; height?: number | undefined; resizable?: boolean | undefined },
): Promise<VersionedDocument> {
  return mutateDocument(filePath, expectedRevision, (document) => {
    if (patch.title !== undefined) document.form.title = patch.title;
    if (patch.width !== undefined) document.form.width = patch.width;
    if (patch.height !== undefined) document.form.height = patch.height;
    if (patch.resizable !== undefined) document.form.resizable = patch.resizable;
    return document;
  });
}

async function writeDocumentAtomic(filePath: string, document: UiDocument): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, canonicalJson(document), "utf8");
  await rename(temporaryPath, filePath);
}
