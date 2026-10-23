import {
  type IMemoryService,
  type ProjectMemoryFileSummary,
  type ProjectMemoryWorkspaceSummary,
} from "./memory.js";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { readProjectMemoryFileFromStableHandle } from "#src/memory/projectMemoryStableRead.js";
import { getZCodeDataRootDir } from "#src/paths.js";

const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const PROJECT_MEMORY_DIRECTORY_NAME = "memory";
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getProjectMemoriesRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isProjectMemoryFileName(fileName: string): boolean {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith(".md") && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

function resolveWorkspaceLabel(workspaceId: string): string {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function requirePlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project Memory directory is not a regular directory: ${path}`);
  }
}

async function requireProjectMemoriesRoot(): Promise<string> {
  const projectsRoot = getProjectMemoriesRoot();
  // 只校验 workspace 子目录时，projectsRoot symlink 会让 list/read 跟随到本地数据目录外。
  await requirePlainDirectory(projectsRoot);
  return projectsRoot;
}

async function requireExactProjectMemoryFile(
  memoryRoot: string,
  fileName: string,
): Promise<string> {
  const memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  const fileEntry = memoryEntries.find((entry) => entry.name === fileName);
  const requestedFilePath = join(memoryRoot, fileName);
  if (!fileEntry) {
    // 文件确实不存在时继续透传原始 ENOENT；只有大小写别名能命中时才拒绝读取。
    await lstat(requestedFilePath);
    throw new Error(`Project Memory file name does not match exactly: ${fileName}`);
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  return requestedFilePath;
}

async function assertContainedProjectMemoryPath(
  projectsRoot: string,
  targetPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const targetRealPath = await realpath(targetPath);
  const relativePath = relative(projectsRootRealPath, targetRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the local profile: ${targetPath}`);
  }
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

const MEMORY_SCAN_CONCURRENCY = 8;

/** 读取一个 workspace 的 Memory 目录快照；目录消失时返回 null（调用方跳过）。 */
async function readWorkspaceCatalog(
  projectsRoot: string,
  workspaceId: string,
): Promise<ProjectMemoryWorkspaceSummary | null> {
  const workspaceRoot = join(projectsRoot, workspaceId);
  const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
  if (!(await isPlainDirectory(workspaceRoot)) || !(await isPlainDirectory(memoryRoot))) {
    return null;
  }

  let memoryEntries;
  try {
    memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  } catch (error) {
    // 目录检查后 Memory Agent 仍可能删除目录；catalog 快照只跳过已消失的 workspace。
    if (isNotFoundError(error)) return null;
    throw error;
  }

  const candidates = memoryEntries.filter(
    (entry) => entry.isFile() && !entry.isSymbolicLink() && isProjectMemoryFileName(entry.name),
  );
  // 内层同样分批：单个 workspace 的 .md 可能很多，全量 Promise.all 会把
  // 「workspace 并发 8」放大成 8 × N 个并发 syscall。
  const summaries: Array<ProjectMemoryFileSummary | null> = [];
  for (let offset = 0; offset < candidates.length; offset += MEMORY_SCAN_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + MEMORY_SCAN_CONCURRENCY);
    summaries.push(
      ...(await Promise.all(
        batch.map(async (memoryEntry) => {
          const filePath = join(memoryRoot, memoryEntry.name);
          let fileMetadata;
          try {
            fileMetadata = await lstat(filePath);
          } catch (error) {
            // readdir 后事实文件可能被并发删除；它不再属于本次只读快照。
            if (isNotFoundError(error)) return null;
            throw error;
          }
          if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) return null;
          const summary: ProjectMemoryFileSummary = {
            name: memoryEntry.name,
            path: filePath,
            kind: memoryEntry.name === PROJECT_MEMORY_INDEX_FILE_NAME ? "index" : "item",
            size: fileMetadata.size,
            updatedAt: fileMetadata.mtimeMs,
          };
          return summary;
        }),
      )),
    );
  }
  const files = summaries.filter((summary): summary is ProjectMemoryFileSummary => summary !== null);
  if (files.length === 0) return null;

  files.sort(compareProjectMemoryFiles);
  return {
    id: workspaceId,
    label: resolveWorkspaceLabel(workspaceId),
    updatedAt: Math.max(...files.map((file) => file.updatedAt)),
    files,
  };
}

export function createMemoryService(): IMemoryService {
  async function listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
    let projectsRoot: string;
    let projectEntries;
    try {
      projectsRoot = await requireProjectMemoriesRoot();
      projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    // 原来是「每 workspace 串行 lstat ×2 + readdir + 每个文件串行 lstat」：
    // 50 个 workspace × 10 个文件 ≈ 600 次串行 syscall，冷启动要几百毫秒。
    // 改成小批并发，顺序不变（结果按目录名收集后统一排序）。
    const workspaceIds = projectEntries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
    const collected: ProjectMemoryWorkspaceSummary[] = [];
    for (let offset = 0; offset < workspaceIds.length; offset += MEMORY_SCAN_CONCURRENCY) {
      const batch = workspaceIds.slice(offset, offset + MEMORY_SCAN_CONCURRENCY);
      const results = await Promise.all(
        batch.map((workspaceId) => readWorkspaceCatalog(projectsRoot, workspaceId)),
      );
      for (const result of results) if (result) collected.push(result);
    }

    const workspaces = collected;
    workspaces.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"),
    );
    return workspaces;
  }

  async function readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // 大小写不敏感文件系统会让请求名称命中不同大小写的磁盘文件，绕过 catalog 白名单。
    const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      },
    });
  }

  return {
    listProjectMemories,
    readProjectMemoryFile,
  };
}
