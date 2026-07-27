import * as vscode from "vscode";
import {
  DEBUG_ENV_VAR,
  DEBUG_STATE_KEY,
  EXTENSION_VERSION,
  MANAGE_COMMAND_ID,
  MIGRATION_DONE_KEY,
  OPEN_DEBUG_LOG_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  REFRESH_MODELS_COMMAND_ID,
  SECRET_STORAGE_KEY,
  TOGGLE_DEBUG_LOGGING_COMMAND_ID,
  TOGGLE_SHOW_REASONING_COMMAND_ID,
} from "./shared/constants";
import { debugLog, getOutputChannel, outputLog } from "./shared/logging";
import { StatusBarManager } from "./shared/status-bar";
import { NimChatModelProvider } from "./provider/chat-provider";
import { registerNimTools } from "./tools/vision";
import { refreshModelsFromApi, resetRefreshQueue } from "./models/refresh";
import { NvidiaApiKeyResolver } from "./api/key-resolver";

let _provider: NimChatModelProvider | null = null;

async function migrateLanguageModelProviderGroup(apiKey: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("lm.migrateLanguageModelsProviderGroup", {
      vendor: PROVIDER_VENDOR,
      name: PROVIDER_DISPLAY_NAME,
      apiKey,
    });
    outputLog(
      "languageModelGroup",
      `Configured ${PROVIDER_DISPLAY_NAME} language model group from stored API key.`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputLog(
      "languageModelGroup",
      `Could not configure VS Code language model group automatically: ${message}`,
    );
    return /already exists/i.test(message);
  }
}

async function initializeStoredApiKey(
  context: vscode.ExtensionContext,
  ua: string,
  statusBar: StatusBarManager,
  keyResolver: NvidiaApiKeyResolver,
): Promise<void> {
  const apiKey = await context.secrets.get(SECRET_STORAGE_KEY);
  if (!apiKey) {
    return;
  }

  const migrationDone = context.globalState.get<boolean>(MIGRATION_DONE_KEY, false);
  if (!migrationDone && (await migrateLanguageModelProviderGroup(apiKey))) {
    await context.globalState.update(MIGRATION_DONE_KEY, true);
  }
  await refreshModelsFromApi(
    context,
    ua,
    { showMessages: false, apiKey },
    _provider,
    statusBar,
    keyResolver,
  );
}

function registerCommands(
  context: vscode.ExtensionContext,
  ua: string,
  statusBar: StatusBarManager,
  keyResolver: NvidiaApiKeyResolver,
): void {
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
        vscode.window.showInformationMessage(
          `${PROVIDER_DISPLAY_NAME} legacy API key cleared. If ${PROVIDER_DISPLAY_NAME} still appears in Copilot Chat, remove its model group from Manage Models.`,
        );
        _provider?.fireModelInfoChanged();
        return;
      }
      await context.secrets.store(SECRET_STORAGE_KEY, apiKey.trim());
      if (await migrateLanguageModelProviderGroup(apiKey.trim())) {
        await context.globalState.update(MIGRATION_DONE_KEY, true);
      }
      vscode.window.showInformationMessage(`${PROVIDER_DISPLAY_NAME} API key saved.`);
      _provider?.fireModelInfoChanged();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_MODELS_COMMAND_ID, async () => {
      await refreshModelsFromApi(
        context,
        ua,
        { showMessages: true },
        _provider,
        statusBar,
        keyResolver,
      );
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

  context.subscriptions.push(
    vscode.commands.registerCommand(TOGGLE_SHOW_REASONING_COMMAND_ID, async () => {
      const config = vscode.workspace.getConfiguration("nvidia-nim");
      const current = config.get<boolean>("showReasoning", false);
      await config.update("showReasoning", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `NVIDIA NIM reasoning content display ${!current ? "enabled" : "disabled"}.`,
      );
    }),
  );
}

export function activate(context: vscode.ExtensionContext) {
  const ua = `nvidia-nim-provider/${EXTENSION_VERSION} VSCode/${vscode.version}`;

  // Initialize output channel and status bar
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Initialize debug logging
  const debugEnabled = context.globalState.get<boolean>(DEBUG_STATE_KEY, false);
  process.env[DEBUG_ENV_VAR] = debugEnabled ? "1" : "0";
  debugLog(
    "activate",
    `Extension activated. Debug logging ${debugEnabled ? "enabled" : "disabled"}.`,
  );

  // Create and register provider
  const keyResolver = new NvidiaApiKeyResolver(context.secrets);
  const provider = new NimChatModelProvider(
    context.secrets,
    ua,
    context.globalState,
    statusBar,
    keyResolver,
  );
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

  // Register tools and commands
  context.subscriptions.push(registerNimTools(context.secrets, context.globalState, keyResolver));
  registerCommands(context, ua, statusBar, keyResolver);

  // Initialize stored API key (async, fire-and-forget)
  void initializeStoredApiKey(context, ua, statusBar, keyResolver);
}

export function deactivate() {
  _provider = null;
  resetRefreshQueue();
}
