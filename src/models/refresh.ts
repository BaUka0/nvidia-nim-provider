import * as vscode from "vscode";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { debugLog } from "../shared/logging";
import { StatusBarManager } from "../shared/status-bar";
import { NvidiaApiKeyResolver } from "../api/key-resolver";
import { fetchCuratedModels } from "./fetch-curated";
import { resetModelCacheOperationQueue, runSerializedModelCacheOperation } from "./cache";

export async function refreshModelsFromApi(
  context: vscode.ExtensionContext,
  ua: string,
  options: { showMessages: boolean; apiKey?: string },
  onModelsRefreshed?: () => void,
  statusBar?: StatusBarManager,
  keyResolver?: NvidiaApiKeyResolver,
): Promise<void> {
  return runSerializedModelCacheOperation(async () => {
    const configuredApiKey = options.apiKey?.trim();
    const cacheKeyFingerprint = context.globalState.get<string>(
      MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
    );
    const apiKey =
      configuredApiKey ||
      (
        await keyResolver?.resolveForTool({
          cacheKeyFingerprint,
          allowUnmatchedRuntimeKey: true,
        })
      )?.value ||
      (await context.secrets.get(SECRET_STORAGE_KEY))?.trim();
    if (!apiKey) {
      if (options.showMessages) {
        vscode.window.showWarningMessage(`No ${PROVIDER_DISPLAY_NAME} API key configured.`);
      }
      return;
    }

    statusBar?.showRefreshing();
    try {
      const fetched = await fetchCuratedModels({
        apiKey,
        userAgent: ua,
        globalState: context.globalState,
      });
      if (fetched) {
        onModelsRefreshed?.();
        statusBar?.showOk(fetched.normalizedModels.length);
        debugLog(
          "refreshModels",
          `Refreshed ${fetched.normalizedModels.length} models from ${PROVIDER_DISPLAY_NAME} API.`,
        );
        if (options.showMessages) {
          vscode.window.showInformationMessage(
            `Refreshed ${fetched.normalizedModels.length} ${PROVIDER_DISPLAY_NAME} models.`,
          );
        }
        return;
      }

      statusBar?.showError("Model refresh failed");
      debugLog("refreshModels", "Model refresh failed or returned malformed data.");
      if (options.showMessages) {
        vscode.window.showWarningMessage(
          `Failed to refresh models from ${PROVIDER_DISPLAY_NAME} API.`,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      statusBar?.showError(msg);
      debugLog("refreshModels", `Model refresh failed: ${msg}`);
      if (options.showMessages) {
        vscode.window.showErrorMessage(`Failed to refresh models: ${msg}`);
      }
    }
  });
}

export function resetRefreshQueue(): void {
  resetModelCacheOperationQueue();
}
