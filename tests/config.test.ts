import * as vscode from "vscode";
import { FALLBACK_MODEL_ID, FALLBACK_VISION_MODEL_ID } from "../src/models/catalog";
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
      expect(config.model).toBe(FALLBACK_MODEL_ID);
      expect(config.visionModel).toBe(FALLBACK_VISION_MODEL_ID);
      expect(config.onTimeout).toBe(true);
      expect(config.firstTokenTimeoutSeconds).toBeNull();
      expect(config.maxChainRestarts).toBe(2);
      expect(config.showNoticeInChat).toBe(true);
      expect(config.notifyUser).toBe(true);
    });

    it("reads custom fallback settings", () => {
      mockStore["fallback.enabled"] = false;
      mockStore["fallback.model"] = "z-ai/glm-5.3";
      mockStore["fallback.visionModel"] = "moonshotai/kimi-k3";
      mockStore["fallback.onTimeout"] = false;
      mockStore["fallback.onFirstTokenTimeout"] = false;
      mockStore["fallback.firstTokenTimeoutSeconds"] = 25;
      mockStore["fallback.maxChainRestarts"] = 1;
      mockStore["fallback.showNoticeInChat"] = false;
      mockStore["fallback.notifyUser"] = false;

      const config = ConfigManager.getFallbackConfig();
      expect(config.enabled).toBe(false);
      expect(config.model).toBe("z-ai/glm-5.3");
      expect(config.visionModel).toBe("moonshotai/kimi-k3");
      expect(config.onTimeout).toBe(false);
      expect(config.onFirstTokenTimeout).toBe(false);
      expect(config.firstTokenTimeoutSeconds).toBe(25);
      expect(config.maxChainRestarts).toBe(1);
      expect(config.showNoticeInChat).toBe(false);
      expect(config.notifyUser).toBe(false);
    });

    it("clamps fallback.maxChainRestarts into the 0..5 range", () => {
      mockStore["fallback.maxChainRestarts"] = -1;
      expect(ConfigManager.getFallbackConfig().maxChainRestarts).toBe(0);

      mockStore["fallback.maxChainRestarts"] = 9;
      expect(ConfigManager.getFallbackConfig().maxChainRestarts).toBe(5);

      mockStore["fallback.maxChainRestarts"] = 3;
      expect(ConfigManager.getFallbackConfig().maxChainRestarts).toBe(3);

      mockStore["fallback.maxChainRestarts"] = Number.NaN;
      expect(ConfigManager.getFallbackConfig().maxChainRestarts).toBe(2);
    });

    it("clamps or rejects invalid firstTokenTimeoutSeconds", () => {
      mockStore["fallback.firstTokenTimeoutSeconds"] = 3; // Below min 5
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBeNull();

      mockStore["fallback.firstTokenTimeoutSeconds"] = 4000; // Above max 3600
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBeNull();

      mockStore["fallback.firstTokenTimeoutSeconds"] = 150; // Valid (within 5..3600)
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBe(150);

      mockStore["fallback.firstTokenTimeoutSeconds"] = 45; // Valid
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBe(45);

      mockStore["fallback.firstTokenTimeoutSeconds"] = 3600; // Upper bound
      expect(ConfigManager.getFallbackConfig().firstTokenTimeoutSeconds).toBe(3600);
    });

    it("defaults fallback.priorityList to an empty list", () => {
      expect(ConfigManager.getFallbackConfig().priorityList).toEqual([]);
    });

    it("sanitizes fallback.priorityList entries", () => {
      mockStore["fallback.priorityList"] = [
        "  moonshotai/kimi-k3  ",
        "",
        42,
        null,
        "meta/muse-glimmer-30b",
      ];
      const config = ConfigManager.getFallbackConfig();
      expect(config.priorityList).toEqual(["moonshotai/kimi-k3", "meta/muse-glimmer-30b"]);

      mockStore["fallback.priorityList"] = "not-an-array";
      expect(ConfigManager.getFallbackConfig().priorityList).toEqual([]);
    });

    it("drops unknown catalog ids from fallback.priorityList", () => {
      mockStore["fallback.priorityList"] = ["moonshotai/kimi-k3", "vendor/not-a-real-model"];
      expect(ConfigManager.getFallbackConfig().priorityList).toEqual(["moonshotai/kimi-k3"]);
    });
  });

  describe("getNetworkConfig", () => {
    it("returns defaults when no settings are set", () => {
      const config = ConfigManager.getNetworkConfig();
      expect(config).toEqual(DEFAULT_NETWORK_CONFIG);
      expect(config.streamIdleTimeout).toBe(120);
      expect(config.maxHttpRetries).toBe(3);
      expect(config.maxEmptyStreamRetries).toBe(2);
      expect(config.maxTotalFetchAttempts).toBe(6);
    });

    it("clamps streamIdleTimeout within 15..3600", () => {
      mockStore["network.streamIdleTimeout"] = 5;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(15);

      mockStore["network.streamIdleTimeout"] = 5000;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(3600);

      mockStore["network.streamIdleTimeout"] = 45;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(45);

      mockStore["network.streamIdleTimeout"] = 3600;
      expect(ConfigManager.getNetworkConfig().streamIdleTimeout).toBe(3600);
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

    it("clamps maxTotalFetchAttempts within 2..30", () => {
      mockStore["network.maxTotalFetchAttempts"] = -5;
      expect(ConfigManager.getNetworkConfig().maxTotalFetchAttempts).toBe(2);

      mockStore["network.maxTotalFetchAttempts"] = 999;
      expect(ConfigManager.getNetworkConfig().maxTotalFetchAttempts).toBe(30);

      mockStore["network.maxTotalFetchAttempts"] = 12;
      expect(ConfigManager.getNetworkConfig().maxTotalFetchAttempts).toBe(12);
    });
  });

  describe("getReasoningConfig", () => {
    it("returns defaults when nothing is set", () => {
      const config = ConfigManager.getReasoningConfig();
      expect(config).toEqual(DEFAULT_REASONING_CONFIG);
      expect(config.mode).toBe("none");
    });

    it("reads reasoning setting keys", () => {
      mockStore["reasoning.mode"] = "high";

      const config = ConfigManager.getReasoningConfig();
      expect(config.mode).toBe("high");
    });

    it("ignores removed legacy keys", () => {
      mockStore["reasoningMode"] = "max";
      mockStore["showReasoning"] = true;
      mockStore["reasoning.showInChat"] = true;

      const config = ConfigManager.getReasoningConfig();
      expect(config.mode).toBe("none");
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
      expect(config.maxRepeatedLines).toBe(4);
      expect(config.maxLoopContinues).toBe(2);
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

    it("clamps generation.maxRepeatedLines into the 0..50 range", () => {
      mockStore["generation.maxRepeatedLines"] = -5;
      expect(ConfigManager.getGenerationConfig().maxRepeatedLines).toBe(0);

      mockStore["generation.maxRepeatedLines"] = 500;
      expect(ConfigManager.getGenerationConfig().maxRepeatedLines).toBe(50);

      mockStore["generation.maxRepeatedLines"] = 7;
      expect(ConfigManager.getGenerationConfig().maxRepeatedLines).toBe(7);

      mockStore["generation.maxRepeatedLines"] = Number.NaN;
      expect(ConfigManager.getGenerationConfig().maxRepeatedLines).toBe(4);
    });

    it("clamps generation.maxLoopContinues into the 0..8 range", () => {
      mockStore["generation.maxLoopContinues"] = -1;
      expect(ConfigManager.getGenerationConfig().maxLoopContinues).toBe(0);

      mockStore["generation.maxLoopContinues"] = 20;
      expect(ConfigManager.getGenerationConfig().maxLoopContinues).toBe(8);

      mockStore["generation.maxLoopContinues"] = 3;
      expect(ConfigManager.getGenerationConfig().maxLoopContinues).toBe(3);

      mockStore["generation.maxLoopContinues"] = Number.NaN;
      expect(ConfigManager.getGenerationConfig().maxLoopContinues).toBe(2);
    });
  });

  describe("getToolsConfig", () => {
    it("returns defaults", () => {
      const config = ConfigManager.getToolsConfig();
      expect(config).toEqual(DEFAULT_TOOLS_CONFIG);
      expect(config.maxConsecutiveIdenticalCalls).toBe(3);
    });

    it("reads custom flags", () => {
      mockStore["tools.maxConsecutiveIdenticalCalls"] = 5;
      const config = ConfigManager.getToolsConfig();
      expect(config.maxConsecutiveIdenticalCalls).toBe(5);
    });

    it("clamps tools.maxConsecutiveIdenticalCalls into the 0..20 range", () => {
      mockStore["tools.maxConsecutiveIdenticalCalls"] = -2;
      expect(ConfigManager.getToolsConfig().maxConsecutiveIdenticalCalls).toBe(0);

      mockStore["tools.maxConsecutiveIdenticalCalls"] = 50;
      expect(ConfigManager.getToolsConfig().maxConsecutiveIdenticalCalls).toBe(20);

      mockStore["tools.maxConsecutiveIdenticalCalls"] = Number.NaN;
      expect(ConfigManager.getToolsConfig().maxConsecutiveIdenticalCalls).toBe(3);
    });
  });

  describe("getContextConfig", () => {
    it("returns defaults", () => {
      const config = ConfigManager.getContextConfig();
      expect(config).toEqual(DEFAULT_CONTEXT_CONFIG);
      expect(config.summarizationModel).toBe("nvidia/nemotron-3-super-120b-a12b");
      expect(config.safetyMarginPercent).toBe(1.0);
    });

    it("reads custom context settings and clamps safety margin", () => {
      mockStore["context.summarizationModel"] = "meta/muse-glimmer-30b";
      mockStore["context.safetyMarginPercent"] = 15; // clamped to 10

      const config = ConfigManager.getContextConfig();
      expect(config.summarizationModel).toBe("meta/muse-glimmer-30b");
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
      expect(config.logStreamChunks).toBe(false);
      expect(config.logUserMessages).toBe(false);
    });

    it("honors developer logStreamChunks and logUserMessages overrides", () => {
      mockStore["developer.logStreamChunks"] = true;
      mockStore["developer.logUserMessages"] = true;
      const config = ConfigManager.getDeveloperConfig();
      expect(config.logStreamChunks).toBe(true);
      expect(config.logUserMessages).toBe(true);
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
