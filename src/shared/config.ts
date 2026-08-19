import * as vscode from "vscode";
import { FALLBACK_MODEL_ID, FALLBACK_VISION_MODEL_ID } from "../models/catalog";

export interface FallbackConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly visionModel: string;
  readonly onRateLimit: boolean;
  readonly onModelUnavailable: boolean;
  readonly onEmptyStream: boolean;
  readonly onTimeout: boolean;
  readonly firstTokenTimeoutSeconds: number | null;
  readonly showNoticeInChat: boolean;
  readonly notifyUser: boolean;
}

export interface NetworkConfig {
  readonly streamIdleTimeout: number; // in seconds
  readonly maxHttpRetries: number;
  readonly maxEmptyStreamRetries: number;
}

export interface ReasoningConfig {
  readonly mode: "none" | "on" | "medium" | "high" | "max";
  readonly showInChat: boolean;
}

export interface GenerationConfig {
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly maxOutputTokens: number | null;
}

export interface ToolsConfig {
  readonly autoRepairArguments: boolean;
  readonly autoRetryInvalidCalls: boolean;
  readonly suppressDuplicateReads: boolean;
}

export interface ContextConfig {
  readonly autoCompactOnOverflow: boolean;
  readonly summarizationModel: string;
  readonly safetyMarginPercent: number;
}

export interface UiConfig {
  readonly showStatusBarItem: boolean;
}

export interface DeveloperConfig {
  readonly debugLogging: boolean;
  readonly logTimingBreakdowns: boolean;
}

export interface NimConfig {
  readonly fallback: FallbackConfig;
  readonly network: NetworkConfig;
  readonly reasoning: ReasoningConfig;
  readonly generation: GenerationConfig;
  readonly tools: ToolsConfig;
  readonly context: ContextConfig;
  readonly ui: UiConfig;
  readonly developer: DeveloperConfig;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  enabled: true,
  model: FALLBACK_MODEL_ID,
  visionModel: FALLBACK_VISION_MODEL_ID,
  onRateLimit: true,
  onModelUnavailable: true,
  onEmptyStream: true,
  onTimeout: true,
  firstTokenTimeoutSeconds: null,
  showNoticeInChat: true,
  notifyUser: true,
};

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  streamIdleTimeout: 120,
  maxHttpRetries: 3,
  maxEmptyStreamRetries: 2,
};

export const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  mode: "none",
  showInChat: false,
};

export const DEFAULT_GENERATION_CONFIG: GenerationConfig = {
  temperature: null,
  topP: null,
  maxOutputTokens: null,
};

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  autoRepairArguments: true,
  autoRetryInvalidCalls: true,
  suppressDuplicateReads: true,
};

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  autoCompactOnOverflow: true,
  summarizationModel: FALLBACK_MODEL_ID,
  safetyMarginPercent: 1.0,
};

export const DEFAULT_UI_CONFIG: UiConfig = {
  showStatusBarItem: true,
};

export const DEFAULT_DEVELOPER_CONFIG: DeveloperConfig = {
  debugLogging: false,
  logTimingBreakdowns: true,
};

export class ConfigManager {
  private static getConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("nvidia-nim");
  }

  public static getFallbackConfig(): FallbackConfig {
    const config = this.getConfiguration();
    const enabled = config.get<boolean>("fallback.enabled", DEFAULT_FALLBACK_CONFIG.enabled);
    const model = config.get<string>("fallback.model", DEFAULT_FALLBACK_CONFIG.model);
    const visionModel = config.get<string>(
      "fallback.visionModel",
      DEFAULT_FALLBACK_CONFIG.visionModel,
    );
    const onRateLimit = config.get<boolean>(
      "fallback.onRateLimit",
      DEFAULT_FALLBACK_CONFIG.onRateLimit,
    );
    const onModelUnavailable = config.get<boolean>(
      "fallback.onModelUnavailable",
      DEFAULT_FALLBACK_CONFIG.onModelUnavailable,
    );
    const onEmptyStream = config.get<boolean>(
      "fallback.onEmptyStream",
      DEFAULT_FALLBACK_CONFIG.onEmptyStream,
    );
    const onTimeout = config.get<boolean>("fallback.onTimeout", DEFAULT_FALLBACK_CONFIG.onTimeout);
    const rawFirstTokenTimeout = config.get<number | null>(
      "fallback.firstTokenTimeoutSeconds",
      null,
    );
    const firstTokenTimeoutSeconds =
      typeof rawFirstTokenTimeout === "number" &&
      Number.isFinite(rawFirstTokenTimeout) &&
      rawFirstTokenTimeout >= 5 &&
      rawFirstTokenTimeout <= 120
        ? rawFirstTokenTimeout
        : null;
    const showNoticeInChat = config.get<boolean>(
      "fallback.showNoticeInChat",
      DEFAULT_FALLBACK_CONFIG.showNoticeInChat,
    );
    const notifyUser = config.get<boolean>(
      "fallback.notifyUser",
      DEFAULT_FALLBACK_CONFIG.notifyUser,
    );

    return {
      enabled,
      model: model.trim() || DEFAULT_FALLBACK_CONFIG.model,
      visionModel: visionModel.trim() || DEFAULT_FALLBACK_CONFIG.visionModel,
      onRateLimit,
      onModelUnavailable,
      onEmptyStream,
      onTimeout,
      firstTokenTimeoutSeconds,
      showNoticeInChat,
      notifyUser,
    };
  }

  public static getNetworkConfig(): NetworkConfig {
    const config = this.getConfiguration();
    const rawTimeout = config.get<number>(
      "network.streamIdleTimeout",
      DEFAULT_NETWORK_CONFIG.streamIdleTimeout,
    );
    const streamIdleTimeout =
      typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
        ? Math.max(15, Math.min(600, Math.round(rawTimeout)))
        : DEFAULT_NETWORK_CONFIG.streamIdleTimeout;

    const rawHttpRetries = config.get<number>(
      "network.maxHttpRetries",
      DEFAULT_NETWORK_CONFIG.maxHttpRetries,
    );
    const maxHttpRetries =
      typeof rawHttpRetries === "number" && Number.isFinite(rawHttpRetries)
        ? Math.max(0, Math.min(10, Math.round(rawHttpRetries)))
        : DEFAULT_NETWORK_CONFIG.maxHttpRetries;

    const rawEmptyRetries = config.get<number>(
      "network.maxEmptyStreamRetries",
      DEFAULT_NETWORK_CONFIG.maxEmptyStreamRetries,
    );
    const maxEmptyStreamRetries =
      typeof rawEmptyRetries === "number" && Number.isFinite(rawEmptyRetries)
        ? Math.max(0, Math.min(5, Math.round(rawEmptyRetries)))
        : DEFAULT_NETWORK_CONFIG.maxEmptyStreamRetries;

    return {
      streamIdleTimeout,
      maxHttpRetries,
      maxEmptyStreamRetries,
    };
  }

  public static getReasoningConfig(): ReasoningConfig {
    const config = this.getConfiguration();
    const rawMode =
      config.get<string>("reasoning.mode") ??
      config.get<string>("reasoningMode", DEFAULT_REASONING_CONFIG.mode);
    const validModes: Array<ReasoningConfig["mode"]> = ["none", "on", "medium", "high", "max"];
    const mode = validModes.includes(rawMode as ReasoningConfig["mode"])
      ? (rawMode as ReasoningConfig["mode"])
      : DEFAULT_REASONING_CONFIG.mode;

    const showInChat =
      config.get<boolean>("reasoning.showInChat") ??
      config.get<boolean>("showReasoning", DEFAULT_REASONING_CONFIG.showInChat);

    return {
      mode,
      showInChat: Boolean(showInChat),
    };
  }

  public static getGenerationConfig(): GenerationConfig {
    const config = this.getConfiguration();
    const rawTemp = config.get<number | null>("generation.temperature", null);
    const temperature =
      typeof rawTemp === "number" && Number.isFinite(rawTemp)
        ? Math.max(0, Math.min(2.0, rawTemp))
        : null;

    const rawTopP = config.get<number | null>("generation.topP", null);
    const topP =
      typeof rawTopP === "number" && Number.isFinite(rawTopP)
        ? Math.max(0, Math.min(1.0, rawTopP))
        : null;

    const rawMaxTokens = config.get<number | null>("generation.maxOutputTokens", null);
    const maxOutputTokens =
      typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens >= 128
        ? Math.min(131072, Math.round(rawMaxTokens))
        : null;

    return {
      temperature,
      topP,
      maxOutputTokens,
    };
  }

  public static getToolsConfig(): ToolsConfig {
    const config = this.getConfiguration();
    const autoRepairArguments = config.get<boolean>(
      "tools.autoRepairArguments",
      DEFAULT_TOOLS_CONFIG.autoRepairArguments,
    );
    const autoRetryInvalidCalls = config.get<boolean>(
      "tools.autoRetryInvalidCalls",
      DEFAULT_TOOLS_CONFIG.autoRetryInvalidCalls,
    );
    const suppressDuplicateReads = config.get<boolean>(
      "tools.suppressDuplicateReads",
      DEFAULT_TOOLS_CONFIG.suppressDuplicateReads,
    );

    return {
      autoRepairArguments,
      autoRetryInvalidCalls,
      suppressDuplicateReads,
    };
  }

  public static getContextConfig(): ContextConfig {
    const config = this.getConfiguration();
    const autoCompactOnOverflow = config.get<boolean>(
      "context.autoCompactOnOverflow",
      DEFAULT_CONTEXT_CONFIG.autoCompactOnOverflow,
    );
    const summarizationModel = config.get<string>(
      "context.summarizationModel",
      DEFAULT_CONTEXT_CONFIG.summarizationModel,
    );
    const rawMargin = config.get<number>(
      "context.safetyMarginPercent",
      DEFAULT_CONTEXT_CONFIG.safetyMarginPercent,
    );
    const safetyMarginPercent =
      typeof rawMargin === "number" && Number.isFinite(rawMargin)
        ? Math.max(0, Math.min(10.0, rawMargin))
        : DEFAULT_CONTEXT_CONFIG.safetyMarginPercent;

    return {
      autoCompactOnOverflow,
      summarizationModel: summarizationModel.trim() || DEFAULT_CONTEXT_CONFIG.summarizationModel,
      safetyMarginPercent,
    };
  }

  public static getUiConfig(): UiConfig {
    const config = this.getConfiguration();
    const showStatusBarItem = config.get<boolean>(
      "ui.showStatusBarItem",
      DEFAULT_UI_CONFIG.showStatusBarItem,
    );
    return {
      showStatusBarItem,
    };
  }

  public static getDeveloperConfig(): DeveloperConfig {
    const config = this.getConfiguration();
    const debugLogging = config.get<boolean>(
      "developer.debugLogging",
      DEFAULT_DEVELOPER_CONFIG.debugLogging,
    );
    const logTimingBreakdowns = config.get<boolean>(
      "developer.logTimingBreakdowns",
      DEFAULT_DEVELOPER_CONFIG.logTimingBreakdowns,
    );
    return {
      debugLogging,
      logTimingBreakdowns,
    };
  }

  public static getNimConfig(): NimConfig {
    return {
      fallback: this.getFallbackConfig(),
      network: this.getNetworkConfig(),
      reasoning: this.getReasoningConfig(),
      generation: this.getGenerationConfig(),
      tools: this.getToolsConfig(),
      context: this.getContextConfig(),
      ui: this.getUiConfig(),
      developer: this.getDeveloperConfig(),
    };
  }
}
