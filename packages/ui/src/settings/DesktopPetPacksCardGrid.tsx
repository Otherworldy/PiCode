import { useState } from "react";
import { buildLocalMediaPreviewUrl, type DesktopPetInstalledPack } from "@zcode/shared";
import { Download, FolderInput, PawPrint, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DesktopPetDeleteDialog } from "./DesktopPetDeleteDialog.js";

export function DesktopPetPacksCardGrid({
  packs,
  activeUrl,
  packDir,
  disabled,
  onUse,
  onOpenDownload,
  onRescan,
  onDeleted,
}: {
  packs: DesktopPetInstalledPack[];
  activeUrl: string;
  packDir: string;
  disabled: boolean;
  onUse: (pack: DesktopPetInstalledPack) => void;
  onOpenDownload: () => void;
  onRescan: () => void;
  onDeleted: (pack: DesktopPetInstalledPack) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [deleteTarget, setDeleteTarget] = useState<DesktopPetInstalledPack | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handleImport = async () => {
    setImportError(null);
    const dir = await platform.selectDirectory();
    if (!dir) return;
    const res = await platform.importDesktopPetPack?.(dir);
    if (res?.success && res.pack) {
      onUse(res.pack);
      onRescan();
    } else {
      setImportError(intl.formatMessage({ id: "settings.desktopPetImportFailed" }));
    }
  };

  const handleDeleteConfirm = async (pack: DesktopPetInstalledPack) => {
    const ok = await platform.deleteDesktopPetPack?.(pack.id, pack.sourceType);
    if (ok) {
      onDeleted(pack);
      onRescan();
    }
  };

  return (
    <div className="border-t border-border px-4 py-4 flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.desktopPetInstalled" })}
            </h3>
            <span className="px-2 py-0.5 text-xs rounded-full bg-surface-subtle border border-border text-foreground-subtle font-medium">
              {packs.length}
            </span>
          </div>
          <p className="text-xs text-foreground-subtle mt-1">
            {intl.formatMessage({ id: "settings.desktopPetInstalledDescription" })}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={handleImport}
            className="gap-1.5"
          >
            <FolderInput className="w-3.5 h-3.5 text-primary" />
            <span>{intl.formatMessage({ id: "settings.desktopPetImport" })}</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onOpenDownload}
            className="gap-1.5"
          >
            <Download className="w-3.5 h-3.5 text-emerald-500" />
            <span>{intl.formatMessage({ id: "settings.desktopPetDownloadBtn" })}</span>
          </Button>

          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={disabled}
            onClick={onRescan}
            title={intl.formatMessage({ id: "settings.desktopPetRescan" })}
            className="h-8 w-8"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {importError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive">
          {importError}
        </div>
      ) : null}

      {packs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.desktopPetInstalledEmpty" })}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {packs.map((pack) => {
            const isCurrent =
              pack.sourceType === "local"
                ? Boolean(packDir && pack.localPath && samePath(packDir, pack.localPath))
                : Boolean(!packDir && pack.url && samePackUrl(activeUrl, pack.url));

            const previewUrl = pack.idleClipPath
              ? buildLocalMediaPreviewUrl(pack.idleClipPath)
              : null;

            return (
              <div
                key={pack.id}
                className={`group relative rounded-xl border p-3 flex flex-col justify-between transition-all duration-150 overflow-hidden ${
                  isCurrent
                    ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/25"
                    : "border-border bg-card hover:border-border-hover"
                }`}
              >
                <div>
                  <div className="relative w-full h-32 rounded-lg border border-border/60 bg-surface/50 overflow-hidden flex flex-col items-center justify-center mb-3">
                    {previewUrl ? (
                      <video
                        src={previewUrl}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="h-full w-auto max-w-full object-contain select-none pointer-events-none"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center text-foreground-subtlest">
                        <PawPrint className="w-8 h-8 opacity-40" />
                      </div>
                    )}

                    <div className="absolute top-2 right-2 flex items-center gap-1">
                      {isCurrent ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary text-primary-foreground shadow-2xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                          {intl.formatMessage({ id: "settings.desktopPetInstalledCurrent" })}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-surface text-foreground-subtle border border-border">
                          {intl.formatMessage({
                            id:
                              pack.sourceType === "local"
                                ? "settings.desktopPetSourceLocal"
                                : "settings.desktopPetSourceDownload",
                          })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-1.5">
                    <h4
                      className="text-sm font-semibold text-foreground truncate"
                      title={pack.name}
                    >
                      {pack.name}
                    </h4>
                    {pack.size ? (
                      <span className="text-[10px] text-foreground-subtle font-mono shrink-0">
                        {pack.size}px
                      </span>
                    ) : null}
                  </div>

                  <p
                    className="text-xs text-foreground-subtle mt-1 font-mono truncate"
                    title={pack.localPath || pack.url}
                  >
                    {pack.sourceType === "local"
                      ? pack.localPath
                      : (pack.url?.split("/").pop() ?? pack.url)}
                  </p>
                </div>

                <div className="mt-3 pt-2.5 border-t border-border flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setDeleteTarget(pack)}
                    className="p-1 rounded text-foreground-subtle hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title={intl.formatMessage({ id: "common.delete" })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>

                  {isCurrent ? (
                    <span className="text-xs text-primary font-medium">
                      {intl.formatMessage({ id: "settings.desktopPetInstalledCurrent" })}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => onUse(pack)}
                    >
                      {intl.formatMessage({ id: "settings.desktopPetInstalledUse" })}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DesktopPetDeleteDialog
        pack={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

function samePackUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left.trim() === right.trim();
  }
}

function samePath(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
