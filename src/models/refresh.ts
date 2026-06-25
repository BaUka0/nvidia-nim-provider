import * as vscode from "vscode";
import { fetchModels } from "../api/client";
import {
  MODELS_CACHE_VERSION,
  MODELS_CACHE_VERSION_STATE_KEY,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  RAW_MODELS_STATE_KEY,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { normalizeNvidiaModels } from "./catalog";
import { debugLog } from "../shared/logging";
import { NimChatModelProvider } from "../provider/chat-provider";
import { StatusBarManager } from "../shared/status-bar";

let _refreshQueue: Promise<void> = Promise.resolve();

export async function refreshModelsFromApi(
  context: vscode.ExtensionContext,
  ua: string,
  options: { showMessages: boolean; apiKey?: string },
  provider: NimChatModelProvider | null,
  statusBar?: StatusBarManager,
): Promise<void> {
  const nextRefresh = _refreshQueue
    .catch(() => undefined)
    .then(async () => {
      const apiKey = options.apiKey ?? (await context.secrets.get(SECRET_STORAGE_KEY));
      if (!apiKey) {
        if (options.showMessages) {
          vscode.window.showWarningMessage(`No ${PROVIDER_DISPLAY_NAME} API key configured.`);
        }
        return;
      }

      statusBar?.showRefreshing();
      try {
        const rawModels = await fetchModels(apiKey, undefined, ua);
        if (Array.isArray(rawModels)) {
          const normalizedModels = normalizeNvidiaModels(rawModels);
          const previousRawModels = context.globalState.get(RAW_MODELS_STATE_KEY);
          await context.globalState.update(RAW_MODELS_STATE_KEY, rawModels);
          try {
            await context.globalState.update(MODELS_STATE_KEY, normalizedModels);
          } catch (normalizedWriteError) {
            try {
              await context.globalState.update(RAW_MODELS_STATE_KEY, previousRawModels);
            } catch (rollbackError) {
              debugLog(
                "refreshModels",
                `Raw cache rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              );
            }
            throw normalizedWriteError;
          }
          await context.globalState.update(MODELS_CACHE_VERSION_STATE_KEY, MODELS_CACHE_VERSION);
          provider?.fireModelInfoChanged();
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

  _refreshQueue = nextRefresh.catch(() => undefined);
  return nextRefresh;
}

export function resetRefreshQueue(): void {
  _refreshQueue = Promise.resolve();
}
