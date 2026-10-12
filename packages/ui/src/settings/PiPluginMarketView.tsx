import {
  PI_PLUGIN_CATALOG_PAGE_SIZE,
  isRecommendedPiPluginInstalled,
  piPluginInstallSourceInstalled,
  type RecommendedPiPluginSource,
} from "@zcode/shared";
import { Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { type ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FEATURED_THEMES } from "@/settings/PiPluginCardVisuals.js";
import { PiPluginCatalogCard } from "@/settings/PiPluginCatalogCard.js";
import { pageNumbers } from "@/settings/piPluginMarketFormat.js";

export const recommendedCopy = {
  "npm:@plannotator/pi-extension": {
    name: "@plannotator/pi-extension",
    tag: "settings.plugins.pi.recommended.tag.plan",
    description: "settings.plugins.pi.recommended.plannotator",
  },
  "https://github.com/Otherworldy/pi-processes-bash": {
    name: "pi-processes",
    tag: "settings.plugins.pi.recommended.tag.process",
    description: "settings.plugins.pi.recommended.processes",
  },
  "git:github.com/Otherworldy/pi-ask-me": {
    name: "pi-ask-me",
    tag: "settings.plugins.pi.recommended.tag.ask",
    description: "settings.plugins.pi.recommended.ask",
  },
} as const satisfies Record<
  RecommendedPiPluginSource,
  { name: string; tag: string; description: string }
>;

const kinds = ["extension", "skill", "theme", "prompt"] as const;
type CatalogKind = (typeof kinds)[number];
type CatalogSort = "downloads" | "recent" | "name";
type PluginRow = {
  id: string;
  detail: string;
  name: string;
  scope: string;
  kind: string;
};

export function PiPluginMarketView({
  pinned,
  plugins,
  scope,
  pending,
  missing,
  rows,
  catalog,
  catalogFrom,
  catalogTotal,
  catalogError,
  loading,
  queryDraft,
  onQueryDraft,
  onSearch,
  installedOnly,
  onInstalledOnlyChange,
  installedPanel,
  kind,
  sort,
  currentPage,
  pageCount,
  onKind,
  onSort,
  onPage,
  onInstall,
  onSourceOpen,
}: {
  pinned: readonly { source: RecommendedPiPluginSource }[];
  plugins: readonly PluginRow[];
  scope: "user" | "project";
  pending: string | "all" | null;
  missing: readonly string[];
  rows: readonly {
    name: string;
    description: string;
    version: string;
    source: string;
    publishedAt?: string;
    publisher?: string;
    repository?: string;
    image?: string;
    kinds?: CatalogKind[];
  }[];
  catalog: unknown[] | null;
  catalogFrom: number;
  catalogTotal: number;
  catalogError: boolean;
  loading: boolean;
  queryDraft: string;
  onQueryDraft: (value: string) => void;
  onSearch: () => void;
  installedOnly: boolean;
  onInstalledOnlyChange: (value: boolean) => void;
  installedPanel: ReactNode;
  kind: "all" | CatalogKind;
  sort: CatalogSort;
  currentPage: number;
  pageCount: number;
  onKind: (value: "all" | CatalogKind) => void;
  onSort: (value: CatalogSort) => void;
  onPage: (page: number) => void;
  onInstall: (sources: string[]) => void;
  onSourceOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="default" onClick={onSourceOpen}>
          {intl.formatMessage({ id: "settings.plugins.pi.market.sourceOpen" })}
        </Button>
        {missing.length > 0 ? (
          <Button
            type="button"
            size="default"
            disabled={pending !== null}
            onClick={() => onInstall([...missing])}
          >
            {pending === "all"
              ? intl.formatMessage({ id: "settings.plugins.pi.recommended.installing" })
              : intl.formatMessage({ id: "settings.plugins.pi.recommended.installAll" })}
          </Button>
        ) : null}
      </div>
      {pinned.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-border/80 bg-surface/60 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-foreground-subtle" aria-hidden="true" />
            <div className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.plugins.pi.market.featured" })}
            </div>
            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
              Featured
            </span>
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.pi.market.featuredHint" })}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {pinned.map((item) => {
              const copy = recommendedCopy[item.source];
              const installed = isRecommendedPiPluginInstalled(plugins, item.source, scope);
              const busy = pending === "all" || pending === item.source;
              const theme = FEATURED_THEMES[item.source];
              const CardIcon = theme?.icon ?? Sparkles;
              return (
                <div
                  key={item.source}
                  className={cn(
                    "flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-3.5 transition-all shadow-xs",
                    theme?.cardBorder,
                  )}
                >
                  <div>
                    <div className="flex items-center gap-1.5">
                      <CardIcon
                        className={cn("size-3.5 shrink-0", theme?.iconClass)}
                        aria-hidden="true"
                      />
                      <div className="truncate font-mono text-ui-sm font-semibold text-foreground">
                        {copy.name}
                      </div>
                    </div>
                    <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
                      {intl.formatMessage({ id: copy.description })}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                    <span
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-ui-xs font-semibold",
                        theme?.badge,
                      )}
                    >
                      {intl.formatMessage({ id: copy.tag })}
                    </span>
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
                        onClick={() => onInstall([item.source])}
                      >
                        {busy
                          ? intl.formatMessage({
                              id: "settings.plugins.pi.recommended.installing",
                            })
                          : intl.formatMessage({ id: "settings.plugins.pi.recommended.install" })}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="space-y-3 rounded-xl border border-border/80 bg-surface/50 p-4">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.plugins.pi.market.all" })}
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <Select value={kind} onValueChange={(value) => onKind(value as "all" | CatalogKind)}>
            <SelectTrigger size="lg" variant="input" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({ id: "settings.plugins.pi.market.kind.all" })}
              </SelectItem>
              {kinds.map((item) => (
                <SelectItem key={item} value={item}>
                  {intl.formatMessage({ id: `settings.plugins.pi.market.kind.${item}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => onSort(value as CatalogSort)}>
            <SelectTrigger size="lg" variant="input" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["downloads", "recent", "name"] as const).map((item) => (
                <SelectItem key={item} value={item}>
                  {intl.formatMessage({ id: `settings.plugins.pi.market.sort.${item}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant={installedOnly ? "default" : "outline"}
            size="lg"
            className="rounded-lg"
            onClick={() => onInstalledOnlyChange(!installedOnly)}
          >
            {intl.formatMessage({ id: "settings.plugins.pi.market.installedFilter" })}
          </Button>
          <div className="flex min-w-48 flex-1 items-center gap-2">
            <Input
              value={queryDraft}
              size="lg"
              className="min-w-0 flex-1 font-mono"
              placeholder={intl.formatMessage({ id: "settings.plugins.pi.market.filter" })}
              onChange={(event) => onQueryDraft(event.target.value)}
            />
            <Button type="submit" size="lg" className="rounded-lg">
              {intl.formatMessage({ id: "settings.plugins.pi.market.search" })}
            </Button>
          </div>
        </form>
        {installedOnly ? (
          installedPanel
        ) : pinned.length === 0 && rows.length === 0 && !loading ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: catalogError
                ? "settings.plugins.pi.market.failed"
                : "settings.plugins.pi.market.empty",
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1500px]:grid-cols-4">
            {rows.map((item) => (
              <PiPluginCatalogCard
                key={item.source}
                busy={pending === item.source}
                installed={piPluginInstallSourceInstalled(plugins, item.source, scope)}
                item={item}
                pending={pending}
                onInstall={(source) => onInstall([source])}
              />
            ))}
          </div>
        )}
        {!installedOnly && loading && catalog === null ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.pi.market.loading" })}
          </div>
        ) : null}
        {!installedOnly && catalogError && (pinned.length > 0 || rows.length > 0) ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.pi.market.failed" })}
          </div>
        ) : null}
        {installedOnly ? null : (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {catalogTotal > PI_PLUGIN_CATALOG_PAGE_SIZE ? (
              <div className="flex flex-wrap items-center justify-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  disabled={currentPage <= 1 || loading}
                  onClick={() => onPage(Math.max(0, currentPage - 2))}
                >
                  {intl.formatMessage({ id: "settings.plugins.pi.market.prev" })}
                </Button>
                {pageNumbers(currentPage, pageCount).map((number) => (
                  <Button
                    key={number}
                    type="button"
                    variant={number === currentPage ? "default" : "ghost"}
                    size="default"
                    disabled={loading}
                    className="min-w-8"
                    onClick={() => onPage(number - 1)}
                  >
                    {number}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  disabled={currentPage >= pageCount || loading}
                  onClick={() => onPage(currentPage)}
                >
                  {intl.formatMessage({ id: "settings.plugins.pi.market.next" })}
                </Button>
              </div>
            ) : null}
            <div className="font-mono text-ui-sm text-foreground-subtlest">
              {intl.formatMessage(
                { id: "settings.plugins.pi.market.range" },
                {
                  from: catalogTotal === 0 ? 0 : catalogFrom + 1,
                  to: Math.min(catalogFrom + PI_PLUGIN_CATALOG_PAGE_SIZE, catalogTotal),
                  total: catalogTotal,
                },
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
