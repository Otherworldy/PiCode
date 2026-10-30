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
