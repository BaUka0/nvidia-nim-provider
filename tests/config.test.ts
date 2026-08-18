import * as vscode from "vscode";
import {
  ConfigManager,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_DEVELOPER_CONFIG,
  DEFAULT_FALLBACK_CONFIG,
  DEFAULT_GENERATION_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_REASONING_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../src/shared/config";

describe("ConfigManager", () => {
  let mockStore: Record<string, unknown> = {};

  beforeEach(() => {
    mockStore = {};
    (vscode.workspace.getConfiguration as jest.Mock) = jest.fn((section?: string) => ({
      get: (key: string, defaultValue?: unknown) => {
        const fullKey = section ? `${section}.${key}` : key;
        if (key in mockStore) return mockStore[key];
        if (fullKey in mockStore) return mockStore[fullKey];
        return defaultValue;
      },
      update: jest.fn(),
      has: jest.fn((key: string) => key in mockStore),
      inspect: jest.fn(),
    }));
  });

  describe("getFallbackConfig", () => {
    it("returns defaults when no settings are set", () => {
      const config = ConfigManager.getFallbackConfig();
      expect(config).toEqual(DEFAULT_FALLBACK_CONFIG);
      expect(config.enabled).toBe(true);
      expect(config.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
      expect(config.onRateLimit).toBe(true);
      expect(config.onModelUnavailable).toBe(true);
      expect(config.onEmptyStream).toBe(true);
      expect(config.onTimeout).toBe(true);
      expect(config.firstTokenTimeoutSeconds).toBeNull();
      expect(config.showNoticeInChat).toBe(true);
      expect(config.notifyUser).toBe(true);
    });

    it("reads custom fallback settings", () => {
      mockStore["fallback.enabled"] = false;
      mockStore["fallback.model"] = "deepseek-ai/deepseek-v4-flash-0731";
      mockStore["fallback.onRateLimit"] = false;
      mockStore["fallback.onModelUnavailable"] = false;
      mockStore["fallback.onEmptyStream"] = false;
      mockStore["fallback.onTimeout"] = false;
      mockStore["fallback.firstTokenTimeoutSeconds"] = 25;
      mockStore["fallback.showNoticeInChat"] = false;
      mockStore["fallback.notifyUser"] = false;

      const config = ConfigManager.getFallbackConfig();
      expect(config.enabled).toBe(false);
      expect(config.model).toBe("deepseek-ai/deepseek-v4-flash-0731");
      expect(config.onRateLimit).toBe(false);
      expect(config.onModelUnavailable).toBe(false);
      expect(config.onEmptyStream).toBe(false);
      expect(config.onTimeout).toBe(false);
      expect(config.firstTokenTimeoutSeconds).toBe(25);
      expect(config.showNoticeInChat).toBe(false);
      expect(config.notifyUser).toBe(false);
    });

    it("clamps or rejects invalid firstTokenTimeoutSeconds", () => {
      mockStore["fallback.firstTokenTimeoutSeconds"] = 3; // Below min 5
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBeNull();

      mockStore["fallback.firstTokenTimeoutSeconds"] = 150; // Above max 120
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBeNull();

      mockStore["fallback.firstTokenTimeoutSeconds"] = 45; // Valid
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBe(45);
    });
  });

  describe("getNetworkConfig", () => {
    it("returns defaults when no settings are set", () => {
      const config = ConfigManager.getNetworkConfig();
      expect(config).toEqual(DEFAULT_NETWORK_CONFIG);
      expect(config.streamIdleTimeout).toBe(120);
      expect(config.maxHttpRetries).toBe(3);
      expect(config.maxEmptyStreamRetries).toBe(2);
    });

    it("clamps streamIdleTimeout within 15..600", () => {
      mockStore["network.streamIdleTimeout"] = 5;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(15);

      mockStore["network.streamIdleTimeout"] = 999;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(600);

      mockStore["network.streamIdleTimeout"] = 45;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(45);
    });

    it("clamps maxHttpRetries within 0..10", () => {
      mockStore["network.maxHttpRetries"] = -5;
      expect(ConfigManager.getNetworkConfig().maxHttpRetries).toBe(0);

      mockStore["network.maxHttpRetries"] = 20;
      expect(ConfigManager.getNetworkConfig().maxHttpRetries).toBe(10);
    });

    it("clamps maxEmptyStreamRetries within 0..5", () => {
      mockStore["network.maxEmptyStreamRetries"] = -1;
      expect(ConfigManager.getNetworkConfig().maxEmptyStreamRetries).toBe(0);

      mockStore["network.maxEmptyStreamRetries"] = 10;
      expect(ConfigManager.getNetworkConfig().maxEmptyStreamRetries).toBe(5);
    });
  });

  describe("getReasoningConfig", () => {
    it("returns defaults when nothing is set", () => {
      const config = ConfigManager.getReasoningConfig();
      expect(config).toEqual(DEFAULT_REASONING_CONFIG);
      expect(config.mode).toBe("none");
      expect(config.showInChat).toBe(false);
    });

    it("reads new setting keys", () => {
      mockStore["reasoning.mode"] = "high";
      mockStore["reasoning.showInChat"] = true;

      const config = ConfigManager.getReasoningConfig();
      expect(config.mode).toBe("high");
      expect(config.showInChat).toBe(true);
    });

    it("falls back to legacy keys if new keys are not present", () => {
      mockStore["reasoningMode"] = "max";
      mockStore["showReasoning"] = true;

      const config = ConfigManager.getReasoningConfig();
      expect(config.mode).toBe("max");
      expect(config.showInChat).toBe(true);
    });

    it("prefers new keys over legacy keys", () => {
      mockStore["reasoning.mode"] = "medium";
      mockStore["reasoningMode"] = "max";
      mockStore["reasoning.showInChat"] = false;
      mockStore["showReasoning"] = true;

      const config = ConfigManager.getReasoningConfig();
      expect(config.mode).toBe("medium");
      expect(config.showInChat).toBe(false);
    });

    it("handles invalid reasoning mode by defaulting to none", () => {
      mockStore["reasoning.mode"] = "unsupported_mode";
      expect(ConfigManager.getReasoningConfig().mode).toBe("none");
    });
  });

  describe("getGenerationConfig", () => {
    it("returns defaults (nulls) when not configured", () => {
      const config = ConfigManager.getGenerationConfig();
      expect(config).toEqual(DEFAULT_GENERATION_CONFIG);
      expect(config.temperature).toBeNull();
      expect(config.topP).toBeNull();
      expect(config.maxOutputTokens).toBeNull();
    });

    it("clamps temperature and topP", () => {
      mockStore["generation.temperature"] = 3.5;
      expect(ConfigManager.getGenerationConfig().temperature).toBe(2.0);

      mockStore["generation.temperature"] = -1;
      expect(ConfigManager.getGenerationConfig().temperature).toBe(0.0);

      mockStore["generation.topP"] = 1.5;
      expect(ConfigManager.getGenerationConfig().topP).toBe(1.0);

      mockStore["generation.maxOutputTokens"] = 50; // below 128 minimum
      expect(ConfigManager.getGenerationConfig().maxOutputTokens).toBeNull();

      mockStore["generation.maxOutputTokens"] = 4096;
      expect(ConfigManager.getGenerationConfig().maxOutputTokens).toBe(4096);
    });
  });

  describe("getToolsConfig", () => {
    it("returns defaults", () => {
      const config = ConfigManager.getToolsConfig();
      expect(config).toEqual(DEFAULT_TOOLS_CONFIG);
      expect(config.autoRepairArguments).toBe(true);
      expect(config.autoRetryInvalidCalls).toBe(true);
    });

    it("reads custom flags", () => {
      mockStore["tools.autoRepairArguments"] = false;
      mockStore["tools.autoRetryInvalidCalls"] = false;
      const config = ConfigManager.getToolsConfig();
      expect(config.autoRepairArguments).toBe(false);
      expect(config.autoRetryInvalidCalls).toBe(false);
    });
  });

  describe("getContextConfig", () => {
    it("returns defaults", () => {
      const config = ConfigManager.getContextConfig();
      expect(config).toEqual(DEFAULT_CONTEXT_CONFIG);
      expect(config.autoCompactOnOverflow).toBe(true);
      expect(config.summarizationModel).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
      expect(config.safetyMarginPercent).toBe(1.0);
    });

    it("reads custom context settings and clamps safety margin", () => {
      mockStore["context.autoCompactOnOverflow"] = false;
      mockStore["context.summarizationModel"] = "stepfun-ai/step-3.7-flash";
      mockStore["context.safetyMarginPercent"] = 15; // clamped to 10

      const config = ConfigManager.getContextConfig();
      expect(config.autoCompactOnOverflow).toBe(false);
      expect(config.summarizationModel).toBe("stepfun-ai/step-3.7-flash");
      expect(config.safetyMarginPercent).toBe(10.0);
    });
  });

  describe("getUiConfig & getDeveloperConfig", () => {
    it("returns UI defaults", () => {
      const config = ConfigManager.getUiConfig();
      expect(config).toEqual(DEFAULT_UI_CONFIG);
      expect(config.showStatusBarItem).toBe(true);
    });

    it("returns Developer defaults", () => {
      const config = ConfigManager.getDeveloperConfig();
      expect(config).toEqual(DEFAULT_DEVELOPER_CONFIG);
      expect(config.debugLogging).toBe(false);
      expect(config.logTimingBreakdowns).toBe(true);
    });
  });

  describe("getNimConfig", () => {
    it("aggregates all configs", () => {
      const config = ConfigManager.getNimConfig();
      expect(config.fallback).toBeDefined();
      expect(config.network).toBeDefined();
      expect(config.reasoning).toBeDefined();
      expect(config.generation).toBeDefined();
      expect(config.tools).toBeDefined();
      expect(config.context).toBeDefined();
      expect(config.ui).toBeDefined();
      expect(config.developer).toBeDefined();
    });
  });
});
