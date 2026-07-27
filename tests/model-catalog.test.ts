import { isNormalizedNvidiaModel, normalizeNvidiaModels } from "../src/models/catalog";
import type { NvidiaModelSummary } from "../src/types";

describe("normalizeNvidiaModels", () => {
  it("keeps whitelisted models and applies overrides", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "deepseek-ai/deepseek-v4-flash",
      },
      {
        id: "unknown/model-that-should-be-filtered",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "deepseek-ai/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        supportsTools: true,
        supportsVision: false,
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
        maxOutputTokens: 128000,
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
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
  });

  it("normalizes poolside/laguna-xs-2.1 with its documented limits", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "poolside/laguna-xs-2.1",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "poolside/laguna-xs-2.1",
        displayName: "Laguna XS 2.1",
        contextWindow: 262144,
        maxOutputTokens: 16384,
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
        displayName: "Kimi k2.6",
        contextWindow: 256000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
      }),
    ).toBe(true);
    expect(
      isNormalizedNvidiaModel({
        id: "moonshotai/kimi-k2.6",
        displayName: "Kimi k2.6",
        contextWindow: 256000,
        maxOutputTokens: "65536", // invalid type
        supportsTools: true,
        supportsVision: true,
      }),
    ).toBe(false);
  });
});
