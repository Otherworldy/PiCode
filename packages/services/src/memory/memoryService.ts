import {
  WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS,
  WORKSPACE_MEMORY_MAX_INDEX_BYTES,
  WORKSPACE_MEMORY_MAX_ITEM_BYTES,
  atomicWritePrivateTextFile,
  ensureWorkspaceMemoryRoot,
  isWorkspaceMemoryFileName,
  isWorkspaceMemorySupported,
  parseWorkspaceMemoryFrontmatter,
  readWorkspaceMemoryEnabled,
  readWorkspaceMemoryExpiryDays,
  readWorkspaceMemoryModel,
  reconcileWorkspaceMemoryIndex,
  resolveWorkspaceMemoryRoot,
  setWorkspaceMemoryEnabled as writeWorkspaceMemoryEnabled,
  setWorkspaceMemoryExpiryDays as writeWorkspaceMemoryExpiryDays,
  setWorkspaceMemoryModel as writeWorkspaceMemoryModel,
  type WorkspaceMemoryCategory,
} from "@zcode/shared/node";
import { lstat, readdir, readFile, realpath, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  IMemoryService,
  ProjectMemoryFileSummary,
  ProjectMemoryWorkspaceRef,
  ProjectMemoryWorkspaceSummary,
  WorkspaceMemoryModelRef,
} from "./memory.js";
import { readProjectMemoryFileFromStableHandle } from "#src/memory/projectMemoryStableRead.js";

const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const MEMORY_SCAN_CONCURRENCY = 8;

function workspaceKey(ref: ProjectMemoryWorkspaceRef): string {
  return ref.workspaceIdentity?.trim() || ref.workspacePath;
}

function workspaceLabel(ref: ProjectMemoryWorkspaceRef): string {
  return basename(resolve(ref.workspacePath)) || ref.workspacePath;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRegularFileLike(metadata: { isFile(): boolean; isSymbolicLink(): boolean }): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink();
}

/** 列表只用于展示分类；读不到或 frontmatter 缺失都按缺省分类处理。 */
async function readMemoryCategory(filePath: string): Promise<WorkspaceMemoryCategory> {
  const content = await readFile(filePath, "utf-8").catch(() => "");
  return parseWorkspaceMemoryFrontmatter(content).category;
}

function compareProjectMemoryFiles(
  left: ProjectMemoryFileSummary,
  right: ProjectMemoryFileSummary,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "index" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "en");
}

async function readWorkspaceCatalog(
  ref: ProjectMemoryWorkspaceRef,
): Promise<ProjectMemoryWorkspaceSummary | null> {
  if (!isWorkspaceMemorySupported(ref.workspaceIdentity)) return null;
  const memoryRoot = resolveWorkspaceMemoryRoot(ref.workspacePath);
  const enabled = await readWorkspaceMemoryEnabled(ref.workspacePath);

  let entries: Dirent[];
  try {
    entries = await readdir(memoryRoot, { withFileTypes: true });
  } catch (error) {
    // 项目还没写过记忆：目录不存在不是错误，返回空 catalog。
    if (isNotFoundError(error)) entries = [];
    else throw error;
  }

  const files: ProjectMemoryFileSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!isWorkspaceMemoryFileName(entry.name)) continue;
    const filePath = join(memoryRoot, entry.name);
    try {
      const metadata = await lstat(filePath);
      if (!isRegularFileLike(metadata)) continue;
      const kind = entry.name === PROJECT_MEMORY_INDEX_FILE_NAME ? "index" : "item";
      files.push({
        name: entry.name,
        path: filePath,
        kind,
        ...(kind === "item" ? { category: await readMemoryCategory(filePath) } : {}),
        size: metadata.size,
        updatedAt: metadata.mtimeMs,
      });
    } catch (error) {
      // readdir 后文件可能被并发删除；它不再属于本次只读快照。
      if (!isNotFoundError(error)) throw error;
    }
  }

  // 索引可能还没写（模型只返回了 writes）；补一行占位，让用户能直接创建和编辑。
  if (!files.some((file) => file.name === PROJECT_MEMORY_INDEX_FILE_NAME)) {
    files.push({
      name: PROJECT_MEMORY_INDEX_FILE_NAME,
      path: join(memoryRoot, PROJECT_MEMORY_INDEX_FILE_NAME),
      kind: "index",
      size: 0,
      updatedAt: 0,
      missing: true,
    });
  }

  files.sort(compareProjectMemoryFiles);
  return {
    id: workspaceKey(ref),
    workspacePath: ref.workspacePath,
    label: workspaceLabel(ref),
    enabled,
    updatedAt: files.length === 0 ? 0 : Math.max(...files.map((file) => file.updatedAt)),
    files,
  };
}

async function requireContainedMemoryFile(
  ref: ProjectMemoryWorkspaceRef,
  fileName: string,
): Promise<string> {
  const memoryRoot = resolveWorkspaceMemoryRoot(ref.workspacePath);
  const rootMetadata = await lstat(memoryRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Project Memory directory is not a regular directory: ${memoryRoot}`);
  }
  const filePath = join(memoryRoot, fileName);
  const fileMetadata = await lstat(filePath);
  if (!isRegularFileLike(fileMetadata)) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  const rootRealPath = await realpath(memoryRoot);
  const fileRealPath = await realpath(filePath);
  const relativePath = relative(rootRealPath, fileRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the project: ${fileRealPath}`);
  }
  return filePath;
}

export function createMemoryService(): IMemoryService {
  async function listProjectMemories(params: {
    workspaces: ProjectMemoryWorkspaceRef[];
  }): Promise<ProjectMemoryWorkspaceSummary[]> {
    const seen = new Set<string>();
    const unique: ProjectMemoryWorkspaceRef[] = [];
    for (const ref of params.workspaces) {
      const key = workspaceKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(ref);
    }
    const summaries: ProjectMemoryWorkspaceSummary[] = [];
    // 最近项目可能很多，逐项 await 会把一次设置页刷新拖成几十次串行 readdir + lstat。
    for (let offset = 0; offset < unique.length; offset += MEMORY_SCAN_CONCURRENCY) {
      const batch = unique.slice(offset, offset + MEMORY_SCAN_CONCURRENCY);
      const results = await Promise.all(batch.map((ref) => readWorkspaceCatalog(ref)));
      for (const result of results) if (result) summaries.push(result);
    }
    summaries.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"),
    );
    return summaries;
  }

  async function readProjectMemoryFile(
    params: ProjectMemoryWorkspaceRef & { fileName: string },
  ): Promise<{ content: string; updatedAt: number }> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      throw new Error("Project Memory is only available for local workspaces");
    }
    if (!isWorkspaceMemoryFileName(params.fileName)) {
      throw new Error("Invalid Project Memory path");
    }
    const filePath = await requireContainedMemoryFile(params, params.fileName);
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireContainedMemoryFile(params, params.fileName);
      },
    });
  }

  async function writeProjectMemoryFile(
    params: ProjectMemoryWorkspaceRef & { fileName: string; content: string },
  ): Promise<void> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      throw new Error("Project Memory is only available for local workspaces");
    }
    if (!isWorkspaceMemoryFileName(params.fileName)) {
      throw new Error("Invalid Project Memory path");
    }
    const maxBytes =
      params.fileName === PROJECT_MEMORY_INDEX_FILE_NAME
        ? WORKSPACE_MEMORY_MAX_INDEX_BYTES
        : WORKSPACE_MEMORY_MAX_ITEM_BYTES;
    if (Buffer.byteLength(params.content, "utf-8") > maxBytes) {
      throw new Error(`Project Memory file exceeds ${maxBytes} bytes: ${params.fileName}`);
    }
    await ensureWorkspaceMemoryRoot(params.workspacePath);
    const filePath = join(resolveWorkspaceMemoryRoot(params.workspacePath), params.fileName);
    const existing = await lstat(filePath).catch(() => null);
    if (existing) {
      // 已存在时复用读取路径的校验：普通文件、非 symlink、realpath 在根目录内。
      await requireContainedMemoryFile(params, params.fileName);
    }
    await atomicWritePrivateTextFile(filePath, params.content);
    // UI 新建/改写条目后同步索引：否则新文件不会出现在注入的 MEMORY.md 里。
    if (params.fileName !== PROJECT_MEMORY_INDEX_FILE_NAME) {
      await reconcileWorkspaceMemoryIndex(resolveWorkspaceMemoryRoot(params.workspacePath));
    }
  }

  async function deleteProjectMemoryFile(
    params: ProjectMemoryWorkspaceRef & { fileName: string },
  ): Promise<void> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      throw new Error("Project Memory is only available for local workspaces");
    }
    if (!isWorkspaceMemoryFileName(params.fileName)) {
      throw new Error("Invalid Project Memory path");
    }
    const filePath = await requireContainedMemoryFile(params, params.fileName);
    await unlink(filePath);
    // 删了文件就把指向它的指针行一起清掉，否则主模型下一轮还会看到这条死链。
    if (params.fileName !== PROJECT_MEMORY_INDEX_FILE_NAME) {
      await reconcileWorkspaceMemoryIndex(resolveWorkspaceMemoryRoot(params.workspacePath));
    }
  }

  async function getWorkspaceMemoryEnabled(params: ProjectMemoryWorkspaceRef): Promise<boolean> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) return false;
    return readWorkspaceMemoryEnabled(params.workspacePath);
  }

  async function setWorkspaceMemoryEnabled(
    params: ProjectMemoryWorkspaceRef & { enabled: boolean },
  ): Promise<void> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      throw new Error("Project Memory is only available for local workspaces");
    }
    await writeWorkspaceMemoryEnabled(params.workspacePath, params.enabled);
    // 打开开关时立刻建目录：当前会话下一轮就会重新读开关，不能等到下次新建会话。
    if (params.enabled) await ensureWorkspaceMemoryRoot(params.workspacePath);
  }

  async function getWorkspaceMemoryModel(
    params: ProjectMemoryWorkspaceRef,
  ): Promise<WorkspaceMemoryModelRef | null> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) return null;
    return readWorkspaceMemoryModel(params.workspacePath);
  }

  async function setWorkspaceMemoryModel(
    params: ProjectMemoryWorkspaceRef & { model: WorkspaceMemoryModelRef | null },
  ): Promise<void> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      throw new Error("Project Memory is only available for local workspaces");
    }
    await writeWorkspaceMemoryModel(params.workspacePath, params.model);
  }

  async function getWorkspaceMemoryExpiryDays(params: ProjectMemoryWorkspaceRef): Promise<number> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      return WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS;
    }
    return readWorkspaceMemoryExpiryDays(params.workspacePath);
  }

  async function setWorkspaceMemoryExpiryDays(
    params: ProjectMemoryWorkspaceRef & { days: number | null },
  ): Promise<void> {
    if (!isWorkspaceMemorySupported(params.workspaceIdentity)) {
      throw new Error("Project Memory is only available for local workspaces");
    }
    await writeWorkspaceMemoryExpiryDays(params.workspacePath, params.days);
  }

  return {
    listProjectMemories,
    readProjectMemoryFile,
    writeProjectMemoryFile,
    deleteProjectMemoryFile,
    getWorkspaceMemoryEnabled,
    getWorkspaceMemoryModel,
    getWorkspaceMemoryExpiryDays,
    setWorkspaceMemoryEnabled,
    setWorkspaceMemoryModel,
    setWorkspaceMemoryExpiryDays,
  };
}
