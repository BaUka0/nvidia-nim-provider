import {
  FALLBACK_MODEL_ID,
  FALLBACK_VISION_MODEL_ID,
  getFallbackModel,
  isNormalizedNvidiaModel,
  normalizeNvidiaModels,
} from "../src/models/catalog";
import type { NvidiaModelSummary } from "../src/types";

describe("normalizeNvidiaModels", () => {
  it("keeps whitelisted models and applies overrides", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
      },
      {
        id: "unknown/model-that-should-be-filtered",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash 0731",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
  });

  it("normalizes moonshotai/kimi-k2.6 with Deprecated label", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "moonshotai/kimi-k2.6",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "moonshotai/kimi-k2.6",
        displayName: "Kimi k2.6 (Deprecated)",
        contextWindow: 262144,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
  });

  it("normalizes z-ai/glm-5.2 correctly with its specific overrides", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "z-ai/glm-5.2",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "z-ai/glm-5.2",
        displayName: "GLM 5.2",
        contextWindow: 1000000,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
  });

  it("normalizes thinkingmachines/inkling with its multimodal million-token limits", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "thinkingmachines/inkling",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "thinkingmachines/inkling",
        displayName: "Inkling",
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
  });

  it("normalizes meta/muse-glimmer-30b with its documented limits", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "meta/muse-glimmer-30b",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "meta/muse-glimmer-30b",
        displayName: "Muse Glimmer",
        contextWindow: 131072,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
  });

  it("normalizes nvidia/nemotron-3.5-lightning-30b-a3b with its curated 1M / 32K limits", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "nvidia/nemotron-3.5-lightning-30b-a3b",
        displayName: "Nemotron 3.5 Lightning 30B",
        contextWindow: 1000000,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
  });

  it("uses the curated max output limit instead of an API-supplied override", () => {
    // Curated limits are stable across API metadata changes.
    const raw: NvidiaModelSummary[] = [
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        metadata: { max_tokens: 8192 },
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        maxOutputTokens: 65536,
      }),
    ]);
  });

  it("prefers the override display name over the API name", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "stepfun-ai/step-3.7-flash",
        name: "API Supplied Step 3.7",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "stepfun-ai/step-3.7-flash",
        displayName: "Step 3.7 Flash",
      }),
    ]);
  });

  it("filters non-whitelisted models completely", () => {
    const raw: NvidiaModelSummary[] = [
      { id: "baai/bge-m3" },
      { id: "nvidia/ai-synthetic-video-detector" },
      { id: "meta/llama-3.1-8b-instruct" }, // previously valid, now filtered
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([]);
  });

  it("deduplicates exact duplicate model ids from the NVIDIA catalog", () => {
    const raw: NvidiaModelSummary[] = [{ id: "z-ai/glm-5.2" }, { id: "z-ai/glm-5.2" }];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "z-ai/glm-5.2",
        displayName: "GLM 5.2",
      }),
    ]);
  });

  it("detects whether cached values match the normalized NVIDIA model shape", () => {
    expect(
      isNormalizedNvidiaModel({
        id: "moonshotai/kimi-k2.6",
        displayName: "Kimi k2.6 (Deprecated)",
        contextWindow: 256000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      }),
    ).toBe(true);
    expect(
      isNormalizedNvidiaModel({
        id: "moonshotai/kimi-k2.6",
        displayName: "Kimi k2.6 (Deprecated)",
        contextWindow: 256000,
        maxOutputTokens: "65536", // invalid type
        supportsTools: true,
        supportsVision: true,
      }),
    ).toBe(false);
  });
});

describe("getFallbackModel", () => {
  const lightning = {
    id: FALLBACK_MODEL_ID,
    displayName: "Nemotron 3.5 Lightning 30B",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: false,
  };
  const kimi = {
    id: "moonshotai/kimi-k2.6",
    displayName: "Kimi k2.6 (Deprecated)",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
  };
  const minimax = {
    id: FALLBACK_VISION_MODEL_ID,
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutputTokens: 100000,
    supportsTools: true,
    supportsVision: true,
  };
  const stepfun = {
    id: "stepfun-ai/step-3.7-flash",
    displayName: "Step 3.7 Flash",
    contextWindow: 262144,
    maxOutputTokens: 262144,
    supportsTools: true,
    supportsVision: true,
  };
  const flash = {
    id: "deepseek-ai/deepseek-v4-flash-0731",
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false,
  };

  it("selects Nemotron 3.5 Lightning as the default text fallback", () => {
    expect(FALLBACK_MODEL_ID).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(getFallbackModel(kimi.id, [kimi, lightning, minimax])).toEqual(lightning);
  });

  it("does not fall back when the current model is already Lightning", () => {
    expect(getFallbackModel(lightning.id, [kimi, lightning, minimax])).toBeUndefined();
  });

  it("supports string fallback argument for backward compatibility", () => {
    expect(
      getFallbackModel(kimi.id, [kimi, flash, lightning], "deepseek-ai/deepseek-v4-flash-0731"),
    ).toEqual(flash);
  });

  describe("Vision-aware fallback (requiresVision: true)", () => {
    it("selects MiniMax M3 by default when requiresVision is true", () => {
      expect(FALLBACK_VISION_MODEL_ID).toBe("minimaxai/minimax-m3");
      expect(
        getFallbackModel(kimi.id, [kimi, lightning, minimax, stepfun], {
          requiresVision: true,
        }),
      ).toEqual(minimax);
    });

    it("uses configured fallback.model if it already supports vision", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, lightning, minimax, stepfun], {
          configuredFallbackModelId: "stepfun-ai/step-3.7-flash",
          requiresVision: true,
        }),
      ).toEqual(stepfun);
    });

    it("uses configured visionModel when fallback.model is text-only", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, lightning, minimax, stepfun], {
          configuredFallbackModelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
          configuredVisionFallbackModelId: "stepfun-ai/step-3.7-flash",
          requiresVision: true,
        }),
      ).toEqual(stepfun);
    });

    it("selects alternative vision model when the failing model is the vision fallback model", () => {
      expect(
        getFallbackModel(minimax.id, [minimax, lightning, stepfun], {
          requiresVision: true,
        }),
      ).toEqual(stepfun);
    });

    it("returns undefined if no vision models are available in the catalog", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, lightning, flash], {
          requiresVision: true,
        }),
      ).toBeUndefined();
    });
  });
});
