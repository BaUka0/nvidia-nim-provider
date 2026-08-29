import * as vscode from "vscode";
import {
  DEBUG_ENV_VAR,
  DEBUG_STATE_KEY,
  EXTENSION_VERSION,
  MANAGE_COMMAND_ID,
  MIGRATION_DONE_KEY,
  OPEN_DEBUG_LOG_COMMAND_ID,
  SAVE_SESSION_LOGS_COMMAND_ID,
  SAVE_TURN_REPORT_COMMAND_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_VENDOR,
  REFRESH_MODELS_COMMAND_ID,
  SECRET_STORAGE_KEY,
  TOGGLE_DEBUG_LOGGING_COMMAND_ID,
} from "./shared/constants";
import {
  debugLog,
  disposeOutputChannel,
  getOutputChannel,
  outputLog,
  setDeveloperLogOptions,
} from "./shared/logging";
import { StatusBarManager } from "./shared/status-bar";
import { NimChatModelProvider } from "./provider/chat-provider";
import { registerNimTools } from "./tools/vision";
import { refreshModelsFromApi, resetRefreshQueue } from "./models/refresh";
import { NvidiaApiKeyResolver } from "./api/key-resolver";
import { ConfigManager } from "./shared/config";
import { isLikelyNvidiaApiKey } from "./shared/api-key-format";
import {
  buildSessionLogFilename,
  formatSessionLogsPayload,
  resolveDownloadsDir,
  writeTurnReportFile,
} from "./shared/turn-report";
import * as path from "node:path";

function applyDeveloperLogOptions(context: vscode.ExtensionContext): void {
  const developer = ConfigManager.getDeveloperConfig();
  const debugFlag = context.globalState.get<boolean>(DEBUG_STATE_KEY, false);
  setDeveloperLogOptions({
    debugLogging: debugFlag || developer.debugLogging,
    logStreamChunks: developer.logStreamChunks,
    logUserMessages: developer.logUserMessages,
  });
}

async function saveSessionLogs(): Promise<void> {
  const payload = formatSessionLogsPayload();
  if (!payload) {
    vscode.window.showWarningMessage(
      `${PROVIDER_DISPLAY_NAME} has no session logs yet. Send a chat message first, then run this command again.`,
    );
    return;
  }

  const filename = buildSessionLogFilename();
  const downloadsDir = resolveDownloadsDir();
  let savedPath = path.join(downloadsDir, filename);
  try {
    await writeTurnReportFile(savedPath, payload);
  } catch (error) {
    const fallback = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(savedPath),
      filters: { JSON: ["json"] },
      saveLabel: "Save session logs",
    });
    if (!fallback) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `${PROVIDER_DISPLAY_NAME} could not save the session logs: ${message}`,
      );
      return;
    }
    savedPath = fallback.fsPath;
    try {
      await writeTurnReportFile(savedPath, payload);
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      vscode.window.showErrorMessage(
        `${PROVIDER_DISPLAY_NAME} could not save the session logs: ${message}`,
      );
      return;
    }
  }

  const showInFolder = "Show in Folder";
  const choice = await vscode.window.showInformationMessage(
    `${PROVIDER_DISPLAY_NAME}: saved session logs to ${savedPath}`,
    showInFolder,
  );
  if (choice === showInFolder) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(savedPath));
  }
}

let _provider: NimChatModelProvider | null = null;

async function migrateLanguageModelProviderGroup(apiKey: string): Promise<boolean> {
  if (vscode.workspace.isTrusted === false) {
    outputLog(
      "languageModelGroup",
      `Skipping automatic language model group migration in an untrusted workspace.`,
    );
    return false;
  }
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
      // Never pre-fill the stored secret into the input box: the value would
      // live in renderer memory and be exposed via clipboard/accessibility.
      const apiKey = await vscode.window.showInputBox({
        title: `${PROVIDER_DISPLAY_NAME} API Key`,
        prompt: existing
          ? `Update your ${PROVIDER_DISPLAY_NAME} API key`
          : `Enter your ${PROVIDER_DISPLAY_NAME} API key`,
        ignoreFocusOut: true,
        password: true,
        placeHolder: existing
          ? `A key is already stored. Enter a new key to replace it, or submit empty to clear it.`
          : `Enter your ${PROVIDER_DISPLAY_NAME} API key...`,
      });
      if (apiKey === undefined) {
        return;
      }
      if (!apiKey.trim()) {
        await context.secrets.delete(SECRET_STORAGE_KEY);
        _provider?.fireModelInfoChanged({ invalidateModelCache: true });
        vscode.window.showWarningMessage(
          `${PROVIDER_DISPLAY_NAME} stored API key cleared. Also remove the ${PROVIDER_DISPLAY_NAME} model group in Copilot Chat > Manage Models if it still appears.`,
        );
        return;
      }
      const trimmed = apiKey.trim();
      if (!isLikelyNvidiaApiKey(trimmed)) {
        const proceed = await vscode.window.showWarningMessage(
          `This does not look like a NVIDIA NIM API key (expected nvapi-…). Save it anyway?`,
          { modal: true },
          "Save",
        );
        if (proceed !== "Save") {
          return;
        }
      }
      await context.secrets.store(SECRET_STORAGE_KEY, trimmed);
      if (await migrateLanguageModelProviderGroup(trimmed)) {
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
      applyDeveloperLogOptions(context);
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
    vscode.commands.registerCommand(SAVE_SESSION_LOGS_COMMAND_ID, saveSessionLogs),
    vscode.commands.registerCommand(SAVE_TURN_REPORT_COMMAND_ID, saveSessionLogs),
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
  const debugEnabledFlag = context.globalState.get<boolean>(DEBUG_STATE_KEY, false);
  process.env[DEBUG_ENV_VAR] = debugEnabledFlag ? "1" : "0";
  applyDeveloperLogOptions(context);
  debugLog(
    "activate",
    `Extension activated. Debug logging ${debugEnabledFlag ? "enabled" : "disabled"}.`,
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nvidia-nim.ui.showStatusBarItem")) {
        statusBar.updateVisibility();
      }
      if (e.affectsConfiguration("nvidia-nim.developer")) {
        applyDeveloperLogOptions(context);
      }
      if (
        e.affectsConfiguration("nvidia-nim.fallback") ||
        e.affectsConfiguration("nvidia-nim.network") ||
        e.affectsConfiguration("nvidia-nim.context")
      ) {
        _provider?.fireModelInfoChanged({ invalidateModelCache: false });
      }
    }),
  );

  const registration = vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider);
  context.subscriptions.push(registration);

  // Register tools and commands
  context.subscriptions.push(registerNimTools(context.secrets, context.globalState, keyResolver));
  registerCommands(context, ua, statusBar, keyResolver);

  // Initialize stored API key (async, fire-and-forget). The catch keeps the
  // extension host free of unhandled promise rejections on startup races.
  void initializeStoredApiKey(context, ua, statusBar, keyResolver).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    statusBar.showError(message);
    outputLog("init", `Stored API key initialization failed: ${message}`);
  });
}

export function deactivate() {
  _provider = null;
  resetRefreshQueue();
  disposeOutputChannel();
}
