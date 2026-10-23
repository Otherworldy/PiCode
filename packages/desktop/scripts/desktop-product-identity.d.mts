/**
 * desktop-product-identity.mjs 的类型声明。
 *
 * main 进程需要读产品身份（Windows AppUserModelId）来决定任务栏分组；该模块同时被构建脚本
 * （tsup.config.ts / release-it）以 ESM 方式加载，所以保持 .mjs 而不是改写成 .ts。
 */
export type DesktopProductFlavor = string;

export declare const ZCODE_PREVIEW_IDENTITY_ENV: "ZCODE_PREVIEW_IDENTITY";

export declare const desktopProductIdentities: Readonly<Record<string, unknown>>;

export declare function isPreviewIdentityRequested(env?: NodeJS.ProcessEnv): boolean;

export declare function resolveDesktopProductFlavor(env?: NodeJS.ProcessEnv): DesktopProductFlavor;

export declare function resolveDesktopProductIdentity(env?: NodeJS.ProcessEnv): unknown;

export declare function resolveDesktopArtifactSuffix(env?: NodeJS.ProcessEnv): string;

export declare function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged?: boolean },
): string;

export declare function resolveWindowsAppUserModelId(
  env?: NodeJS.ProcessEnv,
  runtime?: { isPackaged?: boolean },
): string;
