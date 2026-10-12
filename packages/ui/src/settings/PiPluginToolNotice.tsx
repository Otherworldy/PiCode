import type { ZCodePiPluginsResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type InstallTools = NonNullable<ZCodePiPluginsResult["tools"]>;

/** 缺 npm 或 git 时提示安装。两项都在就不占位置。 */
export function PiPluginToolNotice({ tools }: { tools: InstallTools | null }) {
  const { intl } = useZCodeIntl();
  if (!tools || (tools.npm && tools.git)) return null;
  const id =
    !tools.npm && !tools.git
      ? "settings.plugins.pi.tools.both"
      : !tools.npm
        ? "settings.plugins.pi.tools.npm"
        : "settings.plugins.pi.tools.git";
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm text-amber-800 dark:text-amber-200"
    >
      <p>{intl.formatMessage({ id })}</p>
      <div className="mt-1 flex gap-3">
        {tools.npm ? null : (
          <a
            className="font-medium underline"
            href="https://nodejs.org/"
            rel="noreferrer"
            target="_blank"
          >
            Node.js
          </a>
        )}
        {tools.git ? null : (
          <a
            className="font-medium underline"
            href="https://git-scm.com/"
            rel="noreferrer"
            target="_blank"
          >
            Git
          </a>
        )}
      </div>
    </div>
  );
}
