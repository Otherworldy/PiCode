import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 项目记忆抽取模型；未配置时跟随当前会话模型。 */
export interface WorkspaceMemoryModelRef {
  providerId: string;
  modelId: string;
}

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在项目 `.pi/memory` 内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
  /** 索引文件不存在时由 catalog 补出的占位条目，点击可创建。 */
  missing?: boolean;
}

export interface ProjectMemoryWorkspaceSummary {
  /** `workspaceIdentity?.trim() || workspacePath`。 */
  id: string;
  workspacePath: string;
  label: string;
  enabled: boolean;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface IMemoryService {
  /** 按传入的本地工作区读取项目内记忆；远端 ref 会被跳过。 */
  listProjectMemories(params: {
    workspaces: ProjectMemoryWorkspaceRef[];
  }): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 原样读取一个项目记忆 Markdown 文件。 */
  readProjectMemoryFile(
    params: ProjectMemoryWorkspaceRef & { fileName: string },
  ): Promise<{ content: string; updatedAt: number }>;

  /** 写入（新建或覆盖）一个项目记忆 Markdown 文件。 */
  writeProjectMemoryFile(
    params: ProjectMemoryWorkspaceRef & { fileName: string; content: string },
  ): Promise<void>;

  /** 删除一个项目记忆 Markdown 文件。 */
  deleteProjectMemoryFile(params: ProjectMemoryWorkspaceRef & { fileName: string }): Promise<void>;

  /** 读取项目配置 `<workspace>/zcode.json` 的记忆开关。 */
  getWorkspaceMemoryEnabled(params: ProjectMemoryWorkspaceRef): Promise<boolean>;

  /** 读取项目配置的记忆抽取模型；null 表示跟随会话模型。 */
  getWorkspaceMemoryModel(
    params: ProjectMemoryWorkspaceRef,
  ): Promise<WorkspaceMemoryModelRef | null>;

  /** 写入项目配置的记忆抽取模型；null 清除配置。 */
  setWorkspaceMemoryModel(
    params: ProjectMemoryWorkspaceRef & { model: WorkspaceMemoryModelRef | null },
  ): Promise<void>;

  /** 写入项目配置的记忆开关，只改 `features.memory`。 */
  setWorkspaceMemoryEnabled(
    params: ProjectMemoryWorkspaceRef & { enabled: boolean },
  ): Promise<void>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
