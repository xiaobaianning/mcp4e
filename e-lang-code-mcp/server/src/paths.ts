import path from "node:path";

const easyProjectExtensions = new Set([".e", ".e8"]);

/** 校验并规范化活动工程路径（.e / .e8）。 */
export function assertEasyProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  if (!easyProjectExtensions.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`活动工程不是 .e/.e8 文件: ${resolved}`);
  }
  return resolved;
}

/** 由工程路径推导同名旁路界面文档：<目录>/<工程名>.eui.json */
export function sidecarPath(projectPath: string): string {
  const resolved = assertEasyProjectPath(projectPath);
  return path.join(
    path.dirname(resolved),
    `${path.basename(resolved, path.extname(resolved))}.eui.json`,
  );
}

/** 确认候选路径仍位于工程目录内，避免路径逃逸。 */
export function assertInsideProject(projectPath: string, candidatePath: string): string {
  const root = `${path.resolve(path.dirname(projectPath))}${path.sep}`.toLowerCase();
  const candidate = path.resolve(candidatePath);
  if (!`${candidate}${path.sep}`.toLowerCase().startsWith(root)) {
    throw new Error(`路径逃出了工程目录: ${candidate}`);
  }
  return candidate;
}
