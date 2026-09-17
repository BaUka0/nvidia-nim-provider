import { estimateToolsTokens } from "../src/messages/converter";
import { compactAndFit } from "../src/models/summarizer";
import { buildOverflowRetryRequest } from "../src/provider/overflow-compactor";
import { NimRequestBuilder } from "../src/provider/request-builder";
import { COMPACTION_MIN_OUTPUT_TOKENS, COMPACTION_OUTPUT_FRACTION } from "../src/shared/constants";
import type { NimChatRequest } from "../src/types";

jest.mock("../src/models/summarizer", () => ({
  compactAndFit: jest.fn(),
}));

const compactAndFitMock = compactAndFit as jest.MockedFunction<typeof compactAndFit>;

function makeBody(overrides: Partial<NimChatRequest> = {}): NimChatRequest {
  return {
    model: "moonshotai/kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 4096,
    ...overrides,
  };
}

function makeFittedResult(
  messages: NimChatRequest["messages"] = [
    { role: "system", content: "[Previous conversation summary]: earlier turns" },
  ],
) {
  return {
    messages,
    tokenCount: 128,
    compacted: true,
    truncated: false,
    fits: true,
  };
}

describe("buildOverflowRetryRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rewrites the request body with compacted messages and a reduced max_tokens", async () => {
    const compacted = makeFittedResult();
    compactAndFitMock.mockResolvedValue(compacted);

    const result = await buildOverflowRetryRequest({
      activeRequestBody: makeBody(),
      retryContextWindow: 128000,
      apiKey: "nvapi-test",
      userAgent: "test-ua",
      safetyMarginPercent: 1,
    });

    const expectedMaxOutput = Math.max(
      COMPACTION_MIN_OUTPUT_TOKENS,
      Math.floor(128000 * COMPACTION_OUTPUT_FRACTION),
    );
    expect(result?.compactedMaxOutput).toBe(expectedMaxOutput);
    expect(result?.requestBody).toEqual({
      model: "moonshotai/kimi-k3",
      messages: compacted.messages,
      max_tokens: expectedMaxOutput,
    });
    // 128k window keeps the flat 4096-token safety margin.
    expect(compactAndFitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "hello" }],
        toolDefinitionTokens: 0,
        effectiveMaxInputTokens: 128000 - 4096 - expectedMaxOutput,
        allowTruncation: true,
        forceShrink: true,
      }),
    );
  });

  it("uses the percentage safety margin on very large windows", async () => {
    compactAndFitMock.mockResolvedValue(makeFittedResult());

    const result = await buildOverflowRetryRequest({
      activeRequestBody: makeBody(),
      retryContextWindow: 1_000_000,
      apiKey: "nvapi-test",
      userAgent: "test-ua",
      safetyMarginPercent: 1,
    });

    const expectedMaxOutput = Math.max(
      COMPACTION_MIN_OUTPUT_TOKENS,
      Math.floor(1_000_000 * COMPACTION_OUTPUT_FRACTION),
    );
    // margin = max(4096, 1_000_000 * 1%) = 10000
    expect(compactAndFitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveMaxInputTokens: 1_000_000 - 10000 - expectedMaxOutput,
      }),
    );
    expect(result?.compactedMaxOutput).toBe(expectedMaxOutput);
  });

  it("returns undefined when compaction cannot make the request fit", async () => {
    compactAndFitMock.mockResolvedValue({
      messages: [{ role: "user", content: "hello" }],
      tokenCount: 999_999,
      compacted: false,
      truncated: false,
      fits: false,
    });

    await expect(
      buildOverflowRetryRequest({
        activeRequestBody: makeBody(),
        retryContextWindow: 128000,
        apiKey: "nvapi-test",
        userAgent: "test-ua",
        safetyMarginPercent: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when neither the body nor the caller supplies messages", async () => {
    await expect(
      buildOverflowRetryRequest({
        activeRequestBody: makeBody({ messages: [] }),
        retryContextWindow: 128000,
        apiKey: "nvapi-test",
        userAgent: "test-ua",
        safetyMarginPercent: 1,
      }),
    ).resolves.toBeUndefined();
    expect(compactAndFitMock).not.toHaveBeenCalled();
  });

  it("converts the VS Code messages when the failing body carries none", async () => {
    const convertSpy = jest
      .spyOn(NimRequestBuilder, "convertMessagesWithProfile")
      .mockReturnValue([{ role: "user", content: "converted" }]);
    compactAndFitMock.mockResolvedValue(makeFittedResult());

    const result = await buildOverflowRetryRequest({
      messages: [{ role: 1, content: [{ value: "hi" }] }] as never,
      activeRequestBody: makeBody({ messages: [] }),
      supportsVision: true,
      retryContextWindow: 128000,
      apiKey: "nvapi-test",
      userAgent: "test-ua",
      safetyMarginPercent: 1,
    });

    expect(convertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ supportsVision: true, contextWindow: 128000 }),
    );
    expect(compactAndFitMock).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: "user", content: "converted" }] }),
    );
    expect(result).toBeDefined();
    convertSpy.mockRestore();
  });

  it("counts tool definition tokens against the compacted input budget", async () => {
    compactAndFitMock.mockResolvedValue(makeFittedResult());
    const tools: NimChatRequest["tools"] = [
      {
        type: "function",
        function: { name: "read_file", description: "Read a file", parameters: {} },
      },
    ];

    await buildOverflowRetryRequest({
      activeRequestBody: makeBody({ tools }),
      retryContextWindow: 128000,
      apiKey: "nvapi-test",
      userAgent: "test-ua",
      safetyMarginPercent: 1,
    });

    expect(compactAndFitMock).toHaveBeenCalledWith(
      expect.objectContaining({ toolDefinitionTokens: estimateToolsTokens(tools) }),
    );
  });

  it("forwards summarizer credentials and retry limits", async () => {
    compactAndFitMock.mockResolvedValue(makeFittedResult());

    await buildOverflowRetryRequest({
      activeRequestBody: makeBody(),
      retryContextWindow: 128000,
      apiKey: "nvapi-key",
      userAgent: "agent/1.0",
      summarizationModel: "z-ai/glm-5.3-flash",
      maxHttpRetries: 4,
      safetyMarginPercent: 1,
    });

    expect(compactAndFitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summarizationOptions: expect.objectContaining({
          apiKey: "nvapi-key",
          userAgent: "agent/1.0",
          summarizationModel: "z-ai/glm-5.3-flash",
          maxHttpRetries: 4,
        }),
      }),
    );
  });
});
