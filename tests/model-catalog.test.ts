import { normalizeNvidiaModels } from "../src/model-catalog";
import type { NvidiaModelSummary } from "../src/types";

describe("normalizeNvidiaModels", () => {
  it("keeps chat models and infers tool and vision support from explicit capabilities", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "meta/llama-4-maverick-17b-128e-instruct",
        capabilities: { chat: true, vision: true, tool_calling: true },
        metadata: { context_window: 128000 },
      },
      {
        id: "nvidia/nv-embedqa-e5-v5",
        capabilities: { chat: false },
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "meta/llama-4-maverick-17b-128e-instruct",
        displayName: "Llama 4 Maverick 17B 128E Instruct",
        supportsVision: true,
        supportsTools: true,
        contextWindow: 128000,
      }),
    ]);
  });

  it("applies safe defaults when model metadata is missing", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "meta/llama-3.1-8b-instruct",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      {
        id: "meta/llama-3.1-8b-instruct",
        displayName: "llama-3.1-8b-instruct",
        contextWindow: 131072,
        maxOutputTokens: 16384,
        supportsTools: false,
        supportsVision: false,
      },
    ]);
  });

  it("uses metadata.max_tokens when max_output_tokens is absent", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "meta/llama-3.1-8b-instruct",
        metadata: { max_tokens: 8192 },
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "meta/llama-3.1-8b-instruct",
        maxOutputTokens: 8192,
      }),
    ]);
  });

  it("prefers the API name over a known override display name", () => {
    const raw: NvidiaModelSummary[] = [
      {
        id: "meta/llama-4-maverick-17b-128e-instruct",
        name: "API Supplied Llama 4 Maverick",
      },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([
      expect.objectContaining({
        id: "meta/llama-4-maverick-17b-128e-instruct",
        displayName: "API Supplied Llama 4 Maverick",
      }),
    ]);
  });

  it("filters obvious non-chat models when chat capability metadata is absent", () => {
    const raw: NvidiaModelSummary[] = [
      { id: "nvidia/nv-embedqa-e5-v5" },
      { id: "nv-rerank-qa-mistral-4b:1" },
    ];

    expect(normalizeNvidiaModels(raw)).toEqual([]);
  });
});
