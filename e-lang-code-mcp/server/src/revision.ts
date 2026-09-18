import { createHash } from "node:crypto";
import type { UiDocument } from "./schema.js";

/** 稳定序列化：固定 2 空格缩进 + 末尾换行。 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 文档修订号 = 规范 JSON 的 sha256。 */
export function documentRevision(document: UiDocument): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

/** 乐观并发校验：实际修订号必须等于调用方读到的修订号。 */
export function assertRevision(actual: string, expected: string, resourceName: string): void {
  if (actual !== expected) {
    throw new Error(`${resourceName} 已变化（修订号不匹配）；expected ${expected}, actual ${actual}`);
  }
}
