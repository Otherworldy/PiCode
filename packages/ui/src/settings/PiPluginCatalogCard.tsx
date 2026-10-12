import { Check } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginAvatarPlaceholder, PluginKindBadge } from "@/settings/PiPluginCardVisuals.js";
import { relativeTime } from "@/settings/piPluginMarketFormat.js";

export function PiPluginCatalogCard({
  item,
  installed,
  busy,
  pending,
  onInstall,
}: {
  item: {
    name: string;
    description: string;
    version: string;
    source: string;
    publishedAt?: string;
    publisher?: string;
    repository?: string;
    image?: string;
    kinds?: readonly ("extension" | "skill" | "theme" | "prompt")[];
  };
  installed: boolean;
  busy: boolean;
  pending: string | "all" | null;
  onInstall: (source: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = item.kinds?.[0];
  const ago = relativeTime(item.publishedAt);
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-brand/40">
      {item.image ? (
        <img
          alt=""
          className="hidden size-16 shrink-0 rounded-md border border-border object-cover sm:block"
          src={item.image}
        />
      ) : (
        <PluginAvatarPlaceholder name={item.name} kind={label} />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
        <div>
          <div className="truncate font-mono text-ui-sm font-semibold text-foreground">
            {item.name}
          </div>
          {item.description ? (
            <p className="mt-1 line-clamp-2 text-ui-sm leading-5 text-foreground-subtle">
              {item.description}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-ui-xs text-foreground-subtlest">
            {item.publisher ? <span>{item.publisher}</span> : null}
            {item.version ? (
              <span className="rounded bg-surface px-1.5 py-0.5 text-foreground-subtle border border-border/40">
                v{item.version}
              </span>
            ) : null}
            {ago ? (
              <span>
                {intl.formatMessage({ id: "settings.plugins.pi.market.ago" }, { time: ago })}
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex items-center gap-2 text-ui-xs">
            {label ? (
              <PluginKindBadge
                kind={label}
                label={intl.formatMessage({ id: `settings.plugins.pi.market.kind.${label}` })}
              />
            ) : null}
            <a
              className="text-foreground-subtle transition-colors hover:text-foreground hover:underline"
              href={`https://www.npmjs.com/package/${item.name}`}
              rel="noreferrer"
              target="_blank"
            >
              npm
            </a>
            {item.repository ? (
              <a
                className="text-foreground-subtle transition-colors hover:text-foreground hover:underline"
                href={item.repository}
                rel="noreferrer"
                target="_blank"
              >
                repo
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <div className="flex min-w-0 max-w-[65%] items-center gap-1 rounded bg-surface/80 px-1.5 py-0.5 border border-border/50">
            <span className="text-foreground-subtlest font-bold select-none text-ui-xs">$</span>
            <span className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle">
              pi install {item.source}
            </span>
          </div>
          {installed ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-ui-xs font-semibold text-emerald-600 dark:text-emerald-400">
              <Check className="size-3" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.pi.recommended.installed" })}
            </span>
          ) : (
            <Button
              type="button"
              size="default"
              disabled={pending !== null}
              onClick={() => onInstall(item.source)}
            >
              {busy
                ? intl.formatMessage({ id: "settings.plugins.pi.recommended.installing" })
                : intl.formatMessage({ id: "settings.plugins.pi.recommended.install" })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
