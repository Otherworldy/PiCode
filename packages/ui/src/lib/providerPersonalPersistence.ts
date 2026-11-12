import type { IProviderSettingsService, ProviderSettingsView } from "@picode/services";

export async function persistPersonalProviderDeletion(params: {
  providerId: string;
  providerSettingsService: Pick<IProviderSettingsService, "deletePersonalProvider">;
}): Promise<ProviderSettingsView> {
  return params.providerSettingsService.deletePersonalProvider(params.providerId);
}
