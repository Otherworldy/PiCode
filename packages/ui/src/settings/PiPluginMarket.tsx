import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  PI_PLUGIN_CATALOG_PAGE_SIZE,
  isRecommendedPiPluginInstalled,
  normalizePiPluginInstallSource,
  recommendedPiPlugins,
  type ZCodePiPluginsResult,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { piPluginFailureDetail } from "@/settings/piPluginMarketFormat.js";
import { PiPluginMarketView, recommendedCopy } from "@/settings/PiPluginMarketView.js";

type PiPlugin = ZCodePiPluginsResult["plugins"][number];
type CatalogPackage = NonNullable<ZCodePiPluginsResult["catalog"]>["packages"][number];
type CatalogKind = NonNullable<CatalogPackage["kinds"]>[number];
type CatalogSort = "downloads" | "recent" | "name";

export function PiPluginMarket({
  plugins,
  scope,
  onSearchQueryChange,
  installedOnly,
  onInstalledOnlyChange,
  installedPanel,
  workspace,
  install,
  onInstalled,
}: {
  plugins: readonly PiPlugin[];
  scope: "user" | "project";
  onSearchQueryChange?: (value: string) => void;
  installedOnly: boolean;
  onInstalledOnlyChange: (value: boolean) => void;
  installedPanel: ReactNode;
  workspace: { workspacePath: string; workspaceIdentity?: string };
  install: (source: string) => Promise<ZCodePiPluginsResult>;
  onInstalled: (result: ZCodePiPluginsResult) => void;
}) {
  const { intl } = useZCodeIntl();
  const session = useZCodeSessionService(
    workspace.workspacePath,
    null,
    workspace.workspaceIdentity,
  );
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  const [pending, setPending] = useState<string | "all" | null>(null);
  const [catalog, setCatalog] = useState<CatalogPackage[] | null>(null);
  const [catalogFrom, setCatalogFrom] = useState(0);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogError, setCatalogError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [kind, setKind] = useState<"all" | CatalogKind>("all");
  const [sort, setSort] = useState<CatalogSort>("downloads");
  const [queryDraft, setQueryDraft] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const searchSeq = useRef(0);

  const loadCatalog = useCallback(
    async (query: string, from: number) => {
      const seq = ++searchSeq.current;
      setLoading(true);
      setCatalogError(false);
      try {
        const result = await session.mutatePiPlugins({
          ...workspace,
          action: "search",
          query: query.slice(0, 200),
          from,
          ...(kind === "all" ? {} : { kind }),
          sort,
        });
        if (seq !== searchSeq.current) return;
        const next = result.catalog;
        setCatalogFrom(next?.from ?? from);
        setCatalogTotal(next?.total ?? 0);
        setCatalog(next?.packages ?? []);
      } catch (error) {
        if (seq !== searchSeq.current) return;
        logger.warn("[pi-plugins] catalog search failed", { error });
        setCatalogError(true);
        setCatalog([]);
      } finally {
        if (seq === searchSeq.current) setLoading(false);
      }
    },
    [kind, session, sort, workspace],
  );

  useEffect(() => {
    setPage(0);
  }, [appliedQuery, kind, sort]);

  useEffect(() => {
    if (installedOnly) return;
    const handle = setTimeout(() => {
      void loadCatalog(appliedQuery, page * PI_PLUGIN_CATALOG_PAGE_SIZE);
    }, 0);
    return () => {
      clearTimeout(handle);
      searchSeq.current += 1;
    };
  }, [appliedQuery, installedOnly, loadCatalog, page]);

  const submitSearch = () => {
    const next = queryDraft.trim();
    setAppliedQuery(next);
    onSearchQueryChange?.(next);
  };

  const needle = appliedQuery.toLowerCase();
  const pinned = recommendedPiPlugins.filter((item) => {
    if (!needle) return true;
    const copy = recommendedCopy[item.source];
    return [
      copy.name,
      item.source,
      intl.formatMessage({ id: copy.tag }),
      intl.formatMessage({ id: copy.description }),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const rows = catalog ?? [];
  const missing = pinned
    .filter((item) => !isRecommendedPiPluginInstalled(plugins, item.source, scope))
    .map((item) => item.source);
  const pageCount = Math.max(
    1,
    Math.ceil(
      Math.min(catalogTotal, 2000 + PI_PLUGIN_CATALOG_PAGE_SIZE) / PI_PLUGIN_CATALOG_PAGE_SIZE,
    ),
  );

  const run = (sources: string[], closeSource = false) => {
    if (sources.length === 0 || pending) return;
    const [only] = sources;
    setPending(sources.length === 1 && only ? only : "all");
    void (async () => {
      try {
        for (const source of sources) onInstalled(await install(source));
        toast(intl.formatMessage({ id: "settings.plugins.pi.recommended.installedToast" }));
        if (closeSource) {
          setSourceDraft("");
          setSourceOpen(false);
        }
      } catch (error) {
        logger.warn("[pi-plugins] install failed", { error });
        const detail = piPluginFailureDetail(error);
        const title = intl.formatMessage({ id: "settings.plugins.pi.installFailed" });
        toast(detail ? `${title}\n${detail}` : title, {
          dismissible: true,
          durationMs: 12_000,
          variant: "warning",
        });
      } finally {
        setPending(null);
      }
    })();
  };

  const submitSource = () => {
    const normalized = normalizePiPluginInstallSource(sourceDraft);
    if (!normalized) {
      toast(intl.formatMessage({ id: "settings.plugins.pi.market.invalidSource" }));
      return;
    }
    run([normalized], true);
  };

  return (
    <>
      <PiPluginMarketView
        pinned={pinned}
        plugins={plugins}
        scope={scope}
        pending={pending}
        missing={missing}
        rows={rows}
        catalog={catalog}
        catalogFrom={catalogFrom}
        catalogTotal={catalogTotal}
        catalogError={catalogError}
        loading={loading}
        queryDraft={queryDraft}
        onQueryDraft={setQueryDraft}
        onSearch={submitSearch}
        installedOnly={installedOnly}
        onInstalledOnlyChange={onInstalledOnlyChange}
        installedPanel={installedPanel}
        kind={kind}
        sort={sort}
        currentPage={Math.min(page + 1, pageCount)}
        pageCount={pageCount}
        onKind={setKind}
        onSort={setSort}
        onPage={setPage}
        onInstall={run}
        onSourceOpen={() => setSourceOpen(true)}
      />
      <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "settings.plugins.pi.market.sourceTitle" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "settings.plugins.pi.market.hint" })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitSource();
            }}
          >
            <Input
              value={sourceDraft}
              size="lg"
              className="h-9 font-mono"
              placeholder={intl.formatMessage({
                id: "settings.plugins.pi.market.sourcePlaceholder",
              })}
              onChange={(event) => setSourceDraft(event.target.value)}
            />
            <DialogFooter>
              <Button type="submit" size="sm" disabled={pending !== null || !sourceDraft.trim()}>
                {intl.formatMessage({ id: "settings.plugins.pi.market.installSource" })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
