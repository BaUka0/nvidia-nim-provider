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
    id: "deepseek-ai/deepseek-v4-flash",
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
});
