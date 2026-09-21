import { useCallback } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { logger } from "@/logger.js";

export function PiModelCatalogSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const session = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { state, reload } = useModelSelectionServiceView(services.modelSelectionService);
  const view = state.status === "ready" ? state.view : null;
  const refresh = useCallback(() => {
    void session
      .readWorkspacePresentation({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then(() => reload())
      .catch((error: unknown) => {
        logger.warn("[pi-model-catalog] refresh failed", { error });
      });
  }, [reload, session, workspaceIdentity, workspacePath]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.pi.source" })}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={refresh}>
          {intl.formatMessage({ id: "settings.modelProvider.pi.refresh" })}
        </Button>
      </div>
      {state.status === "loading" ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.pi.loading" })}
        </p>
      ) : !view || view.providers.length === 0 ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.pi.empty" })}
        </p>
      ) : (
        view.providers.map((provider) => (
          <SettingsGroupCard key={provider.providerId}>
            <div className="px-4 py-3">
              <h3 className="text-ui-md font-medium text-foreground">{provider.providerName}</h3>
            </div>
            {provider.models.map((model) => {
              const preferred =
                view.preferredSelection?.providerId === provider.providerId &&
                view.preferredSelection.modelId === model.modelId;
              return (
                <div
                  key={`${provider.providerId}/${model.modelId}`}
                  className="border-t border-border px-4 py-3 text-ui-base text-foreground"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span>{model.modelId}</span>
                    {preferred ? (
                      <span className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.modelProvider.pi.default" })}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </SettingsGroupCard>
        ))
      )}
    </div>
  );
}
