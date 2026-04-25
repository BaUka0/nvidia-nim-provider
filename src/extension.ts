import * as vscode from "vscode";
import { fetchModels } from "./api";
import {
  DEBUG_ENV_VAR,
  DEBUG_STATE_KEY,
  EXTENSION_VERSION,
  MANAGE_COMMAND_ID,
  MODELS_STATE_KEY,
  OPEN_DEBUG_LOG_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  RAW_MODELS_STATE_KEY,
  REFRESH_MODELS_COMMAND_ID,
  SECRET_STORAGE_KEY,
  TOGGLE_DEBUG_LOGGING_COMMAND_ID,
} from "./constants";
import { normalizeNvidiaModels } from "./model-catalog";
import { debugLog, getOutputChannel } from "./output-channel";
import { OcGoChatModelProvider } from "./provider";
import { registerOcGoTools } from "./tools";

let _provider: OcGoChatModelProvider | null = null;
let _refreshQueue: Promise<void> = Promise.resolve();

async function refreshModelsFromApi(
  context: vscode.ExtensionContext,
  ua: string,
  options: { showMessages: boolean },
): Promise<void> {
  const nextRefresh = _refreshQueue
    .catch(() => undefined)
    .then(async () => {
      const apiKey = await context.secrets.get(SECRET_STORAGE_KEY);
      if (!apiKey) {
        if (options.showMessages) {
          vscode.window.showWarningMessage(`No ${PROVIDER_DISPLAY_NAME} API key configured.`);
        }
        return;
      }

      try {
        const rawModels = await fetchModels(apiKey, undefined, ua);
        if (rawModels && rawModels.length > 0) {
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
          _provider?.fireModelInfoChanged();
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

        debugLog("refreshModels", "Model refresh returned no models.");
        if (options.showMessages) {
          vscode.window.showWarningMessage(
            `Failed to refresh models from ${PROVIDER_DISPLAY_NAME} API.`,
          );
        }
      } catch (error) {
        debugLog(
          "refreshModels",
          `Model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (options.showMessages) {
          vscode.window.showErrorMessage(
            `Failed to refresh models: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });

  _refreshQueue = nextRefresh.catch(() => undefined);
  return nextRefresh;
}

export function activate(context: vscode.ExtensionContext) {
  const ua = `nvidia-nim-provider/${EXTENSION_VERSION} VSCode/${vscode.version}`;
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  const debugEnabled = context.globalState.get<boolean>(DEBUG_STATE_KEY, false);
  process.env[DEBUG_ENV_VAR] = debugEnabled ? "1" : "0";
  debugLog(
    "activate",
    `Extension activated. Debug logging ${debugEnabled ? "enabled" : "disabled"}.`,
  );
  const provider = new OcGoChatModelProvider(context.secrets, ua, context.globalState);
  _provider = provider;

  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_STORAGE_KEY) {
        _provider?.fireModelInfoChanged();
      }
    }),
  );

  const registration = vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider);
  context.subscriptions.push(registration);
  context.subscriptions.push(registerOcGoTools(context.secrets, context.globalState));
  context.subscriptions.push(
    vscode.commands.registerCommand(MANAGE_COMMAND_ID, async () => {
      const existing = await context.secrets.get(SECRET_STORAGE_KEY);
      const apiKey = await vscode.window.showInputBox({
        title: `${PROVIDER_DISPLAY_NAME} API Key`,
        prompt: existing
          ? `Update your ${PROVIDER_DISPLAY_NAME} API key`
          : `Enter your ${PROVIDER_DISPLAY_NAME} API key`,
        ignoreFocusOut: true,
        password: true,
        value: existing ?? "",
        placeHolder: `Enter your ${PROVIDER_DISPLAY_NAME} API key...`,
      });
      if (apiKey === undefined) {
        return;
      }
      if (!apiKey.trim()) {
        await context.secrets.delete(SECRET_STORAGE_KEY);
        vscode.window.showInformationMessage(`${PROVIDER_DISPLAY_NAME} API key cleared.`);
        _provider?.fireModelInfoChanged();
        return;
      }
      await context.secrets.store(SECRET_STORAGE_KEY, apiKey.trim());
      vscode.window.showInformationMessage(`${PROVIDER_DISPLAY_NAME} API key saved.`);
      _provider?.fireModelInfoChanged();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_MODELS_COMMAND_ID, async () => {
      await refreshModelsFromApi(context, ua, { showMessages: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(TOGGLE_DEBUG_LOGGING_COMMAND_ID, async () => {
      const current = context.globalState.get<boolean>(DEBUG_STATE_KEY, false);
      const next = !current;
      await context.globalState.update(DEBUG_STATE_KEY, next);
      process.env[DEBUG_ENV_VAR] = next ? "1" : "0";
      debugLog("toggleDebug", `Debug logging ${next ? "enabled" : "disabled"}.`);
      vscode.window.showInformationMessage(
        `${PROVIDER_DISPLAY_NAME} debug logging ${next ? "enabled" : "disabled"}.`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_DEBUG_LOG_COMMAND_ID, () => {
      const output = getOutputChannel();
      output.show(true);
    }),
  );

  void refreshModelsFromApi(context, ua, { showMessages: false });
}

export function deactivate() {
  _provider = null;
  _refreshQueue = Promise.resolve();
}
