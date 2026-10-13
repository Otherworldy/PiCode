/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export {
  forgetSshWorkspaceTarget,
  parseFindEntries,
  quotePosixArg,
  rememberSshWorkspaceTarget,
  remotePosixPath,
  runSsh,
  sshDestinationArgs,
  sshSpecFromConnectTarget,
  sshWorkspaceSpawnEnv,
  type SshRemoteSpec,
} from "./node/sshRemote.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  ensurePiMcpFiles,
  mcpServersFromDocument,
  piProjectMcpFile,
  piUserMcpFile,
  readPiMcpServers,
  toPiStoredMcpServer,
} from "./node/piMcpConfigFile.js";
export {
  APP_DATA_DIR_NAME,
  LEGACY_APP_DATA_DIR_NAME,
  ensureAppDataDir,
  isAppDataDirName,
} from "./node/appDataDir.js";
export {
  AGENT_APPEND_SYSTEM_PROMPT_FILE_NAME,
  AGENT_SYSTEM_PROMPT_FILE_NAME,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  agentSystemPromptFileName,
  localAgentSystemPromptPath,
  prepareAgentSystemPromptWrite,
  remoteAgentSystemPromptPath,
  resolvePiAgentDir,
  type AgentSystemPromptKind,
  type AgentSystemPromptScope,
} from "./node/agentSystemPromptFile.js";
export {
  AGENT_PROMPT_MAX_BYTES,
  agentPromptFileNameFromLabel,
  assertAgentPromptFileName,
  localAgentPromptsDir,
  prepareAgentPromptWrite,
  remoteAgentPromptPath,
  remoteAgentPromptsDir,
} from "./node/agentPromptFiles.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
