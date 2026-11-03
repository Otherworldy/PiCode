/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export {
  buildRemoteShellCommand,
  buildSshAskpassScript,
  forgetSshWorkspaceTarget,
  parseFindEntries,
  probeSshRemotePlatform,
  quotePosixArg,
  quoteRemoteArg,
  rememberSshWorkspaceTarget,
  remoteDirname,
  remoteJoin,
  remotePosixPath,
  resolveSshProxyEndpoint,
  runSsh,
  spawnSsh,
  sshDestinationArgs,
  sshPasswordSecretPath,
  sshProxyPasswordSecretPath,
  sshRemotePlatform,
  sshSpecFromConnectTarget,
  sshTunnelEndpoint,
  sshWorkspaceSpawnEnv,
  writeSshPasswordSecret,
  writeSshProxyPasswordSecret,
  type SshProxyEndpoint,
  type SshRemotePlatform,
  type SshRemoteSpec,
  type SshSecretTarget,
} from "./node/sshRemote.js";
export {
  disposeSshProxyForwarders,
  ensureSshProxyForwarder,
  lastSshProxyTunnelError,
  type SshTunnelEndpoint,
} from "./node/sshProxyTunnel.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export {
  buildAccessScript,
  buildExistsScript,
  buildIsDirectoryExitScript,
  buildIsFileScript,
  buildListMarkdownScript,
  buildListNamesScript,
  buildMkdirScript,
  buildReadRangeScript,
  buildReadTextScript,
  buildReaddirScript,
  buildRemoteCommandScript,
  buildRemoteStartDirectoryScript,
  buildRemoveFileScript,
  buildResolvePathScript,
  buildStatScript,
  buildWriteFileScript,
  normalizeRemoteStartDirectory,
  parseRemoteStat,
  remoteRootPath,
  spawnScp,
  writeSshFileContent,
} from "./node/sshRemoteCommands.js";
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
  PI_PROJECT_DIR_NAME,
  WORKSPACE_MEMORY_DIR_NAME,
  WORKSPACE_MEMORY_INDEX_FILE_NAME,
  WORKSPACE_MEMORY_INDEX_MAX_CHARS,
  WORKSPACE_MEMORY_INDEX_MAX_LINES,
  WORKSPACE_MEMORY_INDEX_READ_MAX_BYTES,
  WORKSPACE_MEMORY_ITEM_FILE_PATTERN,
  WORKSPACE_MEMORY_MAX_INDEX_BYTES,
  WORKSPACE_MEMORY_MAX_ITEM_BYTES,
  assertWorkspaceMemoryRootTrusted,
  ensureWorkspaceMemoryGitExcluded,
  ensureWorkspaceMemoryRoot,
  isWorkspaceMemoryFileName,
  isWorkspaceMemoryItemFileName,
  isWorkspaceMemorySupported,
  parseWorkspaceMemoryFrontmatter,
  readWorkspaceMemoryEnabled,
  readWorkspaceMemoryModel,
  resolveWorkspaceMemoryRoot,
  setWorkspaceMemoryEnabled,
  setWorkspaceMemoryModel,
  WORKSPACE_MEMORY_CATEGORIES,
  WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS,
  WORKSPACE_MEMORY_EXPIRED_DIR_NAME,
  WORKSPACE_MEMORY_SOURCES,
  WORKSPACE_MEMORY_TYPES,
  type WorkspaceMemoryCategory,
  type WorkspaceMemoryFrontmatter,
  type WorkspaceMemoryModelConfig,
  type WorkspaceMemorySource,
  type WorkspaceMemoryType,
} from "./node/workspaceMemory.js";
export {
  formatWorkspaceMemoryPointerLine,
  isWorkspaceMemoryMarkdownTarget,
  reconcileWorkspaceMemoryIndex,
} from "./node/workspaceMemoryIndex.js";
export {
  pruneExpiredWorkspaceMemories,
  readWorkspaceMemoryExpiryDays,
  resolveWorkspaceMemoryExpiry,
  setWorkspaceMemoryExpiryDays,
  type WorkspaceMemoryExpiryVerdict,
} from "./node/workspaceMemoryExpiry.js";
export {
  LEGACY_WORKSPACE_CONFIG_FILE_NAME,
  migrateLegacyWorkspaceConfig,
  migrateLegacyWorkspaceConfigSync,
  readWorkspaceConfigText,
  resolveLegacyWorkspaceConfigPath,
  resolveWorkspaceConfigPath,
  WORKSPACE_CONFIG_DIR_NAME,
  WORKSPACE_CONFIG_FILE_NAME,
} from "./node/workspaceConfig.js";
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
  updateJsonConfigFile,
  userCliConfigFilePath,
  type JsonConfigBuilder,
} from "./node/userCliConfigFile.js";
