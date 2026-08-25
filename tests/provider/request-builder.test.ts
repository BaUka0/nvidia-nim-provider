import * as vscode from "vscode";
import { chatCompletion } from "../../src/api/client";
import { NimRequestBuilder } from "../../src/provider/request-builder";
import { makeChatMessages, makeChatOptions, makeModel } from "../helpers/fakes";

jest.mock("../../src/api/client", () => ({
  chatCompletion: jest.fn(),
}));

jest.mock("vscode", () => ({
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
  },
}));

function createModel(maxInputTokens = 5000): vscode.LanguageModelChatInformation {
  return makeModel({
    id: "deepseek-ai/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash",
    maxInputTokens,
    maxOutputTokens: 1000,
  });
}

function createMessages(count: number, chars = 1000): vscode.LanguageModelChatMessage[] {
  return makeChatMessages(
    ...Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? 1 : 2,
      content: [new vscode.LanguageModelTextPart(`${index}: ${"x".repeat(chars)}`)],
    })),
  );
}

describe("NimRequestBuilder context accounting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("compresses a long dialogue before preparing the request", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("Short historical summary");

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: createMessages(10),
      options: makeChatOptions(),
      contextWindow: 5000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(prepared.inputTokenCount).toBeLessThanOrEqual(5000 - 4096);
    expect(prepared.requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Previous conversation summary"),
        }),
      ]),
    );
    expect(prepared.requestBody.max_tokens).toBeLessThanOrEqual(1000);
  });

  it("returns a structured token-limit error when compression cannot fit the payload", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("z".repeat(100000));

    await expect(
      NimRequestBuilder.prepareRequest({
        model: createModel(),
        messages: createMessages(2, 5000),
        options: makeChatOptions(),
        contextWindow: 5000,
        supportsTools: false,
        supportsVision: false,
        apiKey: "test-key",
        userAgent: "test-agent",
      }),
    ).rejects.toThrow("[TOKEN_LIMIT_EXCEEDED]");
  });

  it("passes cancellation to the summarizer request", async () => {
    const cancellation = new Error("aborted");
    cancellation.name = "AbortError";
    (chatCompletion as jest.Mock).mockRejectedValueOnce(cancellation);
    const controller = new AbortController();

    await expect(
      NimRequestBuilder.prepareRequest({
        model: createModel(),
        messages: createMessages(10),
        options: makeChatOptions(),
        contextWindow: 5000,
        supportsTools: false,
        supportsVision: false,
        apiKey: "test-key",
        userAgent: "test-agent",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect((chatCompletion as jest.Mock).mock.calls[0][2]).toBe(controller.signal);
  });

  it("applies configured generation parameters when options are omitted", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "generation.temperature") return 0.35;
        if (key === "generation.topP") return 0.85;
        if (key === "generation.maxOutputTokens") return 500;
        if (key === "reasoning.mode") return "on";
        return defaultValue;
      }),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.temperature).toBe(0.35);
    expect(prepared.requestBody.top_p).toBe(0.85);
    expect(prepared.requestBody.max_tokens).toBe(500);
  });

  it("forwards configured frequency, presence and repetition penalties", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "generation.frequencyPenalty") return 0.7;
        if (key === "generation.presencePenalty") return -0.5;
        if (key === "generation.repetitionPenalty") return 1.1;
        return defaultValue;
      }),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBe(0.7);
    expect(prepared.requestBody.presence_penalty).toBe(-0.5);
    expect(prepared.requestBody.repetition_penalty).toBe(1.1);
  });

  it("does not apply default penalties when not explicitly configured", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBeUndefined();
    expect(prepared.requestBody.presence_penalty).toBeUndefined();
    expect(prepared.requestBody.repetition_penalty).toBeUndefined();
  });

  it("does not apply penalties when topP is explicitly configured without penalties", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "generation.topP") return 0.9;
        return defaultValue;
      }),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBeUndefined();
    expect(prepared.requestBody.presence_penalty).toBeUndefined();
  });

  it("does not leak presence penalty when frequency was explicitly set", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions({
        modelOptions: { frequency_penalty: 0 },
      }),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBe(0);
    expect(prepared.requestBody.presence_penalty).toBeUndefined();
  });

  it("lets modelOptions override generation penalty defaults", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "generation.frequencyPenalty") return 0.7;
        return defaultValue;
      }),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions({
        modelOptions: { frequency_penalty: -1.5 },
      }),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBe(-1.5);
  });

  it("sets Nemotron top_p default without injecting penalty fields", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const nemotronModel = makeModel({
      id: "nvidia/nemotron-3-ultra-550b-a55b",
      name: "Nemotron 3 Ultra 550B",
      maxInputTokens: 100000,
      maxOutputTokens: 65536,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: nemotronModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBeUndefined();
    expect(prepared.requestBody.presence_penalty).toBeUndefined();
    expect(prepared.requestBody.top_p).toBe(0.95);
  });

  it("suppresses presence and frequency penalties for models with immutable penalties (Kimi K3)", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "generation.frequencyPenalty") return 0.5;
        if (key === "generation.presencePenalty") return 0.5;
        if (key === "generation.repetitionPenalty") return 1.2;
        return defaultValue;
      }),
    });

    const kimiModel = makeModel({
      id: "moonshotai/kimi-k3",
      name: "Kimi K3",
      maxInputTokens: 1000000,
      maxOutputTokens: 65536,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: kimiModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 1048576,
      supportsTools: true,
      supportsVision: true,
      apiKey: "test-key",
      userAgent: "test-agent",
    });

    expect(prepared.requestBody.frequency_penalty).toBeUndefined();
    expect(prepared.requestBody.presence_penalty).toBeUndefined();
    expect(prepared.requestBody.repetition_penalty).toBe(1.2);
  });
});
