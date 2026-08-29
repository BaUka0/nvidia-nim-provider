import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FALLBACK_MODEL_ID,
  FALLBACK_VISION_MODEL_ID,
  MODEL_LIST,
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

  it("normalizes moonshotai/kimi-k3 with its 1M context limits", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "moonshotai/kimi-k3",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "moonshotai/kimi-k3",
        displayName: "Kimi K3",
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

  it("normalizes nvidia/nemotron-3-super-120b-a12b with its curated 1M / 64K limits", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
        displayName: "Nemotron 3 Super 120B",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: false,
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
        id: "meta/muse-glimmer-30b",
        name: "API Supplied Muse",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "meta/muse-glimmer-30b",
        displayName: "Muse Glimmer",
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
    const raw: NvidiaModelSummary[] = [{ id: "moonshotai/kimi-k3" }, { id: "moonshotai/kimi-k3" }];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "moonshotai/kimi-k3",
        displayName: "Kimi K3",
      }),
    ]);
  });

  it("detects whether cached values match the normalized NVIDIA model shape", () => {
    expect(
      isNormalizedNvidiaModel({
        id: "moonshotai/kimi-k3",
        displayName: "Kimi K3",
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      }),
    ).toBe(true);
    expect(
      isNormalizedNvidiaModel({
        id: "moonshotai/kimi-k3",
        displayName: "Kimi K3",
        contextWindow: 1048576,
        maxOutputTokens: "65536", // invalid type
        supportsTools: true,
        supportsVision: true,
      }),
    ).toBe(false);
  });
});

describe("getFallbackModel", () => {
  const super120 = {
    id: FALLBACK_MODEL_ID,
    displayName: "Nemotron 3 Super 120B",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false,
  };
  const lightning = {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    displayName: "Nemotron 3.5 Lightning 30B",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: false,
  };
  const kimi = {
    id: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
  };
  const minimax = {
    id: "minimaxai/minimax-m3",
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutputTokens: 100000,
    supportsTools: true,
    supportsVision: true,
  };
  const glimmer = {
    id: FALLBACK_VISION_MODEL_ID,
    displayName: "Muse Glimmer",
    contextWindow: 131072,
    maxOutputTokens: 32768,
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

  it("selects Nemotron 3 Super 120B as the default text fallback", () => {
    expect(FALLBACK_MODEL_ID).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(getFallbackModel(kimi.id, [kimi, lightning, super120, minimax])).toEqual(super120);
  });

  it("last-resorts to another available model when the current model is already the text fallback", () => {
    expect(getFallbackModel(super120.id, [kimi, lightning, super120, minimax])).toEqual(kimi);
  });

  it("supports string fallback argument for backward compatibility", () => {
    expect(
      getFallbackModel(kimi.id, [kimi, flash, lightning], "deepseek-ai/deepseek-v4-flash-0731"),
    ).toEqual(flash);
  });

  describe("priority list fallback (requiresVision: false)", () => {
    it("walks the priority list in order before the configured single model", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, flash, lightning, super120, minimax], {
          configuredFallbackModelId: FALLBACK_MODEL_ID,
          priorityList: ["deepseek-ai/deepseek-v4-flash-0731", "meta/muse-glimmer-30b"],
        }),
      ).toEqual(flash);
    });

    it("skips the currently failing model and already-tried ids", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, flash], {
          configuredFallbackModelId: FALLBACK_MODEL_ID,
          triedModelIds: ["deepseek-ai/deepseek-v4-flash-0731"],
        }),
      ).toBeUndefined();
    });

    it("last-resorts to another available text model when the configured fallback is missing", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, flash], {
          configuredFallbackModelId: FALLBACK_MODEL_ID,
        }),
      ).toEqual(flash);
    });

    it("last-resorts to Lightning when the configured fallback is missing", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, lightning], {
          configuredFallbackModelId: FALLBACK_MODEL_ID,
        }),
      ).toEqual(lightning);
    });

    it("skips unknown entries and keeps walking the chain", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, super120], {
          priorityList: ["vendor/does-not-exist"],
          triedModelIds: [],
        }),
      ).toEqual(super120);
    });

    it("returns undefined when the whole chain is exhausted", () => {
      expect(
        getFallbackModel(kimi.id, [kimi], {
          priorityList: [FALLBACK_MODEL_ID, "minimaxai/minimax-m3"],
        }),
      ).toBeUndefined();
    });
  });

  describe("Vision-aware fallback (requiresVision: true)", () => {
    it("selects Muse Glimmer by default when requiresVision is true", () => {
      expect(FALLBACK_VISION_MODEL_ID).toBe("meta/muse-glimmer-30b");
      expect(
        getFallbackModel(kimi.id, [kimi, lightning, minimax, glimmer], {
          requiresVision: true,
        }),
      ).toEqual(glimmer);
    });

    it("uses configured fallback.model if it already supports vision", () => {
      expect(
        getFallbackModel(lightning.id, [kimi, lightning, minimax, glimmer], {
          configuredFallbackModelId: "moonshotai/kimi-k3",
          requiresVision: true,
        }),
      ).toEqual(kimi);
    });

    it("uses configured visionModel when fallback.model is text-only", () => {
      expect(
        getFallbackModel(kimi.id, [kimi, lightning, minimax, glimmer], {
          configuredFallbackModelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
          configuredVisionFallbackModelId: "meta/muse-glimmer-30b",
          requiresVision: true,
        }),
      ).toEqual(glimmer);
    });

    it("selects alternative vision model when the failing model is the vision fallback model", () => {
      expect(
        getFallbackModel(glimmer.id, [minimax, lightning, glimmer], {
          requiresVision: true,
        }),
      ).toEqual(minimax);
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

describe("models probe curated ids", () => {
  it("matches MODEL_LIST", () => {
    const probe = readFileSync(join(__dirname, "../scripts/nim-models-probe.mjs"), "utf8");
    const block = probe.match(/CURATED_MODEL_IDS = new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const probeIds = [...(block?.[1].matchAll(/"([^"]+)"/g) ?? [])].map((match) => match[1]).sort();
    expect(probeIds).toEqual(Object.keys(MODEL_LIST).sort());
  });
});
