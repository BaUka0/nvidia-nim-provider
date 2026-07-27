import * as vscode from "vscode";
import { fetchModels, fetchModelsOrThrow } from "../api/client";
import {
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { normalizeNvidiaModels } from "./catalog";
import { debugLog } from "../shared/logging";
import { NimChatModelProvider } from "../provider/chat-provider";
import { StatusBarManager } from "../shared/status-bar";
import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../api/key-resolver";
import {
  reportMissingCuratedModels,
  resetModelCacheOperationQueue,
  runSerializedModelCacheOperation,
  writeModelCacheAtomically,
} from "./cache";

export async function refreshModelsFromApi(
  context: vscode.ExtensionContext,
  ua: string,
  options: { showMessages: boolean; apiKey?: string },
  provider: NimChatModelProvider | null,
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
      const fetchModelsRequest =
        typeof fetchModelsOrThrow === "function" ? fetchModelsOrThrow : fetchModels;
      const rawModels = await fetchModelsRequest(apiKey, undefined, ua);
      if (Array.isArray(rawModels)) {
        reportMissingCuratedModels(rawModels);
        const normalizedModels = normalizeNvidiaModels(rawModels);
        await writeModelCacheAtomically(
          context.globalState,
          rawModels,
          normalizedModels,
          getApiKeyFingerprint(apiKey),
        );
        provider?.fireModelInfoChanged({ invalidateModelCache: false });
        statusBar?.showOk(normalizedModels.length);
        debugLog(
          "refreshModels",
          `Refreshed ${normalizedModels.length} models from ${PROVIDER_DISPLAY_NAME} API.`,
        );
        if (options.showMessages) {
          vscode.window.showInformationMessage(
            `Refreshed ${normalizedModels.length} ${PROVIDER_DISPLAY_NAME} models.`,
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
