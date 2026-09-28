import type { UiLocale } from "@zcode/i18n";
import type { Logger } from "@zcode/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@zcode/adapters/browser";
import type {
  createModelAdapter,
  createZCodeApp,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectZCodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectZCodeCustomCommand,
  InspectZCodeCustomCommandOptions,
  InspectZCodeSkillOptions,
  loginZCodeCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginZCodeCliOptions,
  listZCodeCustomCommands,
  ListZCodeCustomCommandsOptions,
  loadZCodeCustomCommand,
  listZCodeSessions,
  listZCodeSkills,
  ListZCodeSessionsOptions,
  ListZCodeSkillsOptions,
  logoutZCodeCli,
  LogoutZCodeCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunZCodeProtocolAgentOptions,
  prepareZCodeTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownZCodeTelemetry,
  ZCodeAppOptions,
} from "@zcode/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";

export type BootstrapModule = typeof import("@zcode/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunZCodeProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createZCodeApp?: (
    options?: ZCodeAppOptions,
  ) => Awaited<ReturnType<typeof createZCodeApp>> | ReturnType<typeof createZCodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createZCodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectZCodeSkillOptions) => ReturnType<typeof inspectZCodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectZCodeCustomCommandOptions,
  ) => ReturnType<typeof inspectZCodeCustomCommand>;
  loginZCodeCli?: (options?: LoginZCodeCliOptions) => ReturnType<typeof loginZCodeCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareZCodeTelemetryEnv?: typeof prepareZCodeTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListZCodeSessionsOptions) => ReturnType<typeof listZCodeSessions>;
  listCustomCommands?: (
    options: ListZCodeCustomCommandsOptions,
  ) => ReturnType<typeof listZCodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectZCodeCustomCommandOptions,
  ) => ReturnType<typeof loadZCodeCustomCommand>;
  isReservedSlashCommandName?: BootstrapModule["isReservedZCodeSlashCommandName"];
  listSkills?: (options: ListZCodeSkillsOptions) => ReturnType<typeof listZCodeSkills>;
  logger?: Logger;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  logoutZCodeCli?: (options?: LogoutZCodeCliOptions) => ReturnType<typeof logoutZCodeCli>;
  runZCodeProtocolAgent?: (options?: RunZCodeProtocolAgentOptions) => Promise<void>;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownZCodeTelemetry?: typeof shutdownZCodeTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createZCodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
