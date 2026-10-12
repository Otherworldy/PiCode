import {
  isRecommendedPiPluginInstalled,
  isRecommendedPiPluginSource,
} from "./recommended-pi-plugins.js";

/** npm 搜索 `keywords:pi-package` 的一页。设置页和宿主用同一个数。 */
export const PI_PLUGIN_CATALOG_PAGE_SIZE = 12;

const NPM_NAME = /^[a-z0-9~][a-z0-9._~-]*$/iu;
const NPM_VERSION = /^[A-Za-z0-9][A-Za-z0-9._~+-]*$/u;
const GIT_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
const GIT_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,80}$/u;

/**
 * 设置页允许写进 Pi `settings.json` 的包源。
 * 本地路径和 shell 字符不进来：安装会把这段交给 npm 或 git。
 */
export function normalizePiPluginInstallSource(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 300 || hasForbiddenSourceChar(value)) return null;
  if (value.includes("..") || value.includes("?") || value.includes("#") || value.includes("%")) {
    return null;
  }
  if (value.startsWith("npm:")) {
    const spec = npmSpec(value.slice(4));
    return spec ? `npm:${spec}` : null;
  }
  if (value.startsWith("git:")) {
    const spec = gitSpec(value.slice(4));
    return spec ? `git:${spec}` : null;
  }
  if (value.startsWith("https://")) {
    const spec = gitSpec(value.slice("https://".length));
    return spec ? `https://${spec}` : null;
  }
  const bare = npmSpec(value);
  return bare ? `npm:${bare}` : null;
}

export function piPluginSourcesMatch(left: string, right: string): boolean {
  const a = normalizePiPluginInstallSource(left);
  const b = normalizePiPluginInstallSource(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aName = npmPackageName(a);
  const bName = npmPackageName(b);
  return aName !== null && aName === bName;
}

export function piPluginInstallSourceInstalled(
  plugins: readonly {
    id: string;
    detail: string;
    name: string;
    scope: string;
    kind: string;
  }[],
  source: string,
  scope: "user" | "project",
): boolean {
  if (isRecommendedPiPluginSource(source)) {
    return isRecommendedPiPluginInstalled(plugins, source, scope);
  }
  const normalized = normalizePiPluginInstallSource(source);
  if (!normalized) return false;
  return plugins.some((plugin) => {
    if (plugin.kind !== "package" || plugin.scope !== scope) return false;
    return piPluginSourcesMatch(plugin.detail, normalized);
  });
}

function hasForbiddenSourceChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127) return true;
    if ("\"'`;&|$<>\\".includes(char)) return true;
  }
  return false;
}

function npmSpec(body: string): string | null {
  let name = body;
  let version: string | undefined;
  if (body.startsWith("@")) {
    const slash = body.indexOf("/");
    if (slash <= 1) return null;
    const at = body.indexOf("@", slash + 1);
    if (at !== -1) {
      name = body.slice(0, at);
      version = body.slice(at + 1);
    }
    const [scope, pkg, extra] = name.slice(1).split("/");
    if (!scope || !pkg || extra !== undefined) return null;
    if (!NPM_NAME.test(scope) || !NPM_NAME.test(pkg)) return null;
    name = `@${scope.toLowerCase()}/${pkg.toLowerCase()}`;
  } else {
    const at = body.indexOf("@");
    if (at !== -1) {
      name = body.slice(0, at);
      version = body.slice(at + 1);
    }
    if (!NPM_NAME.test(name)) return null;
    name = name.toLowerCase();
  }
  if (version !== undefined && !NPM_VERSION.test(version)) return null;
  return version ? `${name}@${version}` : name;
}

function gitSpec(body: string): string | null {
  if (!body || body.startsWith("/") || body.endsWith("/")) {
    const stripped = body.endsWith("/") ? body.slice(0, -1) : body;
    if (!stripped || stripped.startsWith("/") || stripped.endsWith("/")) return null;
    return gitSpec(stripped);
  }
  const slash = body.indexOf("/");
  if (slash === -1) return null;
  if (body.slice(0, slash).includes("@")) return null;
  let path = body;
  let ref: string | undefined;
  const at = body.lastIndexOf("@");
  if (at > slash) {
    path = body.slice(0, at);
    ref = body.slice(at + 1);
  }
  if (path.endsWith(".git")) path = path.slice(0, -4);
  const [host, ...segments] = path.split("/");
  if (!host || segments.length < 2) return null;
  if (!GIT_HOST.test(host)) return null;
  if (segments.some((part) => !GIT_SEGMENT.test(part))) return null;
  if (ref !== undefined && (ref.includes("..") || !GIT_REF.test(ref))) return null;
  const spec = `${host}/${segments.join("/")}`;
  return ref ? `${spec}@${ref}` : spec;
}

function npmPackageName(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const body = source.slice(4);
  if (body.startsWith("@")) {
    const slash = body.indexOf("/");
    const at = body.indexOf("@", slash + 1);
    return (at === -1 ? body : body.slice(0, at)).toLowerCase();
  }
  const at = body.indexOf("@");
  return (at === -1 ? body : body.slice(0, at)).toLowerCase();
}
