import { NimChatMessage } from "../src/types";
import { chatCompletion } from "../src/api/client";
import { estimateNimMessagesTokens, truncateMessagesForContext } from "../src/messages/converter";
import { MESSAGE_OVERHEAD_TOKENS } from "../src/messages/token-estimate";
import {
  compactAndFit,
  splitMessagesForSummarization,
  summarizeOldMessages,
} from "../src/models/summarizer";

jest.mock("../src/api/client", () => ({
  chatCompletion: jest.fn(),
  fetchModelsOrThrow: jest.fn(),
  streamChatCompletion: jest.fn(),
  fetchWithRetry: jest.fn(),
}));

jest.mock("vscode", () => ({
  SecretStorage: class {},
  window: { showInformationMessage: jest.fn() },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => defaultValue),
    })),
  },
}));

describe("estimateNimMessagesTokens", () => {
  it("estimates tokens for simple text messages", () => {
    const messages: NimChatMessage[] = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there" },
    ];
    const tokens = estimateNimMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles array content", () => {
    const messages: NimChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const tokens = estimateNimMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("truncateMessagesForContext", () => {
  it("preserves system messages and most recent non-system messages", () => {
    const messages: NimChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: "New question" },
      { role: "assistant", content: "New answer" },
    ];
    const result = truncateMessagesForContext(messages, 100);
    expect(result[0]).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("truncated"),
      }),
    );
    const systemContents = result.filter((m) => m.role === "system");
    expect(systemContents.length).toBeGreaterThanOrEqual(1);
    expect(result[result.length - 1].content).toBe("New answer");
  });

  it("keeps at least the last message even if it alone exceeds the budget", () => {
    const longContent = "a".repeat(10000);
    const messages: NimChatMessage[] = [{ role: "user", content: longContent }];
    const result = truncateMessagesForContext(messages, 10);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe(longContent);
  });

  it("pairs the trailing tool message with its owning assistant filtered to that tool_call_id when budget is exceeded", () => {
    const messages: NimChatMessage[] = [
      { role: "user", content: "Inspect both files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"filePath":"a.ts"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "read_file", arguments: '{"filePath":"b.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "x".repeat(5000) },
      { role: "tool", tool_call_id: "call_2", content: "y".repeat(5000) },
    ];
    const result = truncateMessagesForContext(messages, 10);
    const nonSystem = result.filter((m) => m.role !== "system");
    expect(nonSystem).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "read_file", arguments: '{"filePath":"b.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: "y".repeat(5000) },
    ]);
  });

  it("falls back to the last non-tool message instead of emitting an orphan tool message", () => {
    const messages: NimChatMessage[] = [
      { role: "user", content: "Explain the build failure" },
      { role: "tool", tool_call_id: "orphan_call", content: "z".repeat(5000) },
    ];
    const result = truncateMessagesForContext(messages, 10);
    const nonSystem = result.filter((m) => m.role !== "system");
    expect(nonSystem).toEqual([{ role: "user", content: "Explain the build failure" }]);
  });
});

describe("splitMessagesForSummarization", () => {
  it("keeps recent messages and isolates old ones", () => {
    const messages: NimChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Old question 1" },
      { role: "assistant", content: "Old answer 1" },
      { role: "user", content: "Recent question" },
      { role: "assistant", content: "Recent answer" },
    ];
    const { oldMessages, recentMessages } = splitMessagesForSummarization(messages, 1000);
    expect(oldMessages.length).toBeGreaterThan(0);
    expect(recentMessages.length).toBeGreaterThan(0);
    expect(recentMessages[recentMessages.length - 1].content).toBe("Recent answer");
  });

  it("keeps the newest message verbatim even when it alone exceeds the budget", () => {
    const question = `${"pasted file line\n".repeat(2000)}What is wrong here?`;
    const messages: NimChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: question },
    ];
    const { oldMessages, recentMessages } = splitMessagesForSummarization(messages, 100);
    expect(oldMessages.map((message) => message.content)).toEqual(["Old question", "Old answer"]);
    expect(recentMessages.at(-1)?.content).toBe(question);
  });

  it("summarizes a newest message that cannot fit the request at all", () => {
    const pastedLog = `${"log line\n".repeat(5000)}What went wrong?`;
    const messages: NimChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: pastedLog },
    ];
    const { oldMessages, recentMessages } = splitMessagesForSummarization(messages, 100, 1000);
    expect(oldMessages.at(-1)?.content).toBe(pastedLog);
    expect(recentMessages.filter((message) => message.role !== "system")).toEqual([]);
  });

  it("handles single-message conversations", () => {
    const messages: NimChatMessage[] = [{ role: "user", content: "Hello" }];
    const { oldMessages, recentMessages } = splitMessagesForSummarization(messages, 1000);
    expect(oldMessages.length).toBeGreaterThanOrEqual(0);
    expect(recentMessages.length).toBeGreaterThanOrEqual(0);
  });

  it("does not split an assistant tool call from its tool result", () => {
    const messages: NimChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      { role: "user", content: "Continue" },
    ];

    // Fits the tool result and the user turn, but not the tool call before them.
    const budget = 2 * MESSAGE_OVERHEAD_TOKENS + 8;
    const { oldMessages, recentMessages } = splitMessagesForSummarization(messages, budget);

    expect(oldMessages).toHaveLength(0);
    expect(recentMessages.map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
  });
});

describe("summarizeOldMessages", () => {
  it("preserves reasoning and tool-call metadata in summarization input", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockResolvedValueOnce("Summary");

    await summarizeOldMessages(
      [
        {
          role: "assistant",
          content: "I will inspect the repository.",
          reasoning_content: "The user asked for a code change.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "file contents",
        },
      ],
      "test-key",
      "test-agent",
    );

    const request = completionMock.mock.calls.at(-1)?.[1];
    const userMessage = request?.messages.find(
      (message: NimChatMessage) => message.role === "user",
    );
    expect(userMessage?.content).toEqual(
      expect.stringContaining("[reasoning]: The user asked for a code change."),
    );
    expect(userMessage?.content).toEqual(expect.stringContaining('"name":"read_file"'));
    expect(userMessage?.content).toEqual(expect.stringContaining("[tool_call_id]: call_1"));
  });

  it("summarizes text content parts as plain text instead of JSON", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockResolvedValueOnce("Summary");

    await summarizeOldMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Please review src/app.ts" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abcd" } },
          ],
        },
      ],
      "test-key",
      "test-agent",
    );

    const request = completionMock.mock.calls.at(-1)?.[1];
    const userMessage = request?.messages.find(
      (message: NimChatMessage) => message.role === "user",
    );
    expect(userMessage?.content).toEqual(expect.stringContaining("Please review src/app.ts"));
    expect(userMessage?.content).toEqual(expect.stringContaining("[image omitted from summary]"));
    expect(userMessage?.content).not.toEqual(expect.stringContaining('"type":"text"'));
  });

  it("keeps the summarization payload within its character budget", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockResolvedValueOnce("Summary");

    await summarizeOldMessages(
      [{ role: "user", content: "x".repeat(100000) }],
      "test-key",
      "test-agent",
    );

    const request = completionMock.mock.calls.at(-1)?.[1];
    const userMessage = request?.messages.find(
      (message: NimChatMessage) => message.role === "user",
    );
    expect(userMessage?.content.length).toBeLessThanOrEqual(48000);
    expect(userMessage?.content).toContain("Earlier content clipped");
  });

  it("drops the oldest turns first when the payload is over budget", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockResolvedValueOnce("Summary");

    await summarizeOldMessages(
      [
        { role: "user", content: `oldest-start ${"a".repeat(30000)} oldest-end` },
        { role: "assistant", content: `middle-start ${"b".repeat(30000)} middle-end` },
        { role: "user", content: "newest turn" },
      ],
      "test-key",
      "test-agent",
    );

    const request = completionMock.mock.calls.at(-1)?.[1];
    const text: string = request?.messages.find(
      (message: NimChatMessage) => message.role === "user",
    )?.content;
    expect(text.length).toBeLessThanOrEqual(48000);
    expect(text.startsWith("[Earlier content clipped before summarization.]")).toBe(true);
    expect(text).toContain("newest turn");
    expect(text).toContain("middle-start");
    expect(text).toContain("oldest-end");
    expect(text).not.toContain("oldest-start");
  });

  it("falls back to truncation when the API returns an empty summary", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockResolvedValueOnce("   ");

    const summary = await summarizeOldMessages(
      [
        { role: "user", content: "Old question" },
        { role: "assistant", content: "Old answer" },
      ],
      "test-key",
      "test-agent",
    );

    expect(summary.role).toBe("system");
    expect(summary.content).toEqual(
      expect.stringContaining("[Previous conversation — truncated due to context limits]"),
    );
  });

  it("propagates summarizer cancellation instead of silently truncating", async () => {
    const cancellation = new Error("aborted");
    cancellation.name = "AbortError";
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockRejectedValueOnce(cancellation);
    const controller = new AbortController();

    await expect(
      summarizeOldMessages(
        [{ role: "user", content: "old context" }],
        "test-key",
        "test-agent",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(completionMock.mock.calls.at(-1)?.[2]).toBe(controller.signal);
  });

  it("falls back to truncation when the summarization API call fails", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockRejectedValueOnce(new Error("503 unavailable"));

    const summary = await summarizeOldMessages(
      [
        { role: "user", content: "Old question about parsers" },
        { role: "assistant", content: "Old answer about parsers" },
      ],
      "test-key",
      "test-agent",
    );

    expect(summary.role).toBe("system");
    expect(summary.content).toEqual(
      expect.stringContaining("[Previous conversation — truncated due to context limits]"),
    );
    expect(summary.content).toEqual(expect.stringContaining("Old question about parsers"));
  });

  it("uses the provided summarizationModel parameter", async () => {
    const completionMock = chatCompletion as jest.Mock;
    completionMock.mockResolvedValueOnce("Summary with custom model");

    await summarizeOldMessages(
      [{ role: "user", content: "some text" }],
      "test-key",
      "test-agent",
      undefined,
      "meta/muse-glimmer-30b",
    );

    const request = completionMock.mock.calls.at(-1)?.[1];
    expect(request.model).toBe("meta/muse-glimmer-30b");
    expect(request.max_tokens).toBe(4096);
  });

  it.each([
    ["mistralai/mistral-large-4-1t-a52b", 16384],
    ["stepfun-ai/step-5-preview", 16384],
    ["minimaxai/minimax-m3.1-flash", 16384],
    ["nvidia/nemotron-3.5-lightning-30b-a3b", 4096],
  ])(
    "sets max_tokens for %s to %i so always-reasoning models are not starved",
    async (modelId, expectedMaxTokens) => {
      const completionMock = chatCompletion as jest.Mock;
      completionMock.mockResolvedValueOnce("Summary");

      await summarizeOldMessages(
        [{ role: "user", content: "some text" }],
        "test-key",
        "test-agent",
        undefined,
        modelId,
      );

      const request = completionMock.mock.calls.at(-1)?.[1];
      expect(request.model).toBe(modelId);
      expect(request.max_tokens).toBe(expectedMaxTokens);
    },
  );
});

describe("compactAndFit", () => {
  it("fits without truncation when summarization reduces token count below budget", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("Short summary");
    const messages: NimChatMessage[] = [
      { role: "system", content: "You are an assistant" },
      { role: "user", content: "Old question that is relatively verbose" },
      { role: "assistant", content: "Old answer that is also somewhat wordy" },
      { role: "user", content: "Recent question" },
    ];

    const result = await compactAndFit({
      messages,
      effectiveMaxInputTokens: 500,
      toolDefinitionTokens: 50,
      allowTruncation: false,
      summarizationOptions: {
        apiKey: "test-key",
        userAgent: "test-agent",
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.fits).toBe(true);
    expect(
      result.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Short summary"),
      ),
    ).toBe(true);
  });

  it("applies truncation fallback when allowTruncation is true and messages exceed budget", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("Summary of long messages");
    const messages: NimChatMessage[] = [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: "Recent question with more detail" },
    ];

    const result = await compactAndFit({
      messages,
      effectiveMaxInputTokens: 5,
      toolDefinitionTokens: 0,
      allowTruncation: true,
      summarizationOptions: {
        apiKey: "test-key",
        userAgent: "test-agent",
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate when allowTruncation is false", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("Summary text");
    const messages: NimChatMessage[] = [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: "Recent question with more detail" },
    ];

    const result = await compactAndFit({
      messages,
      effectiveMaxInputTokens: 5,
      toolDefinitionTokens: 0,
      allowTruncation: false,
      summarizationOptions: {
        apiKey: "test-key",
        userAgent: "test-agent",
      },
    });

    expect(result.truncated).toBe(false);
    expect(result.fits).toBe(false);
  });

  it("forceShrink truncates even when the estimator already reports a fit", async () => {
    const messages: NimChatMessage[] = [
      { role: "system", content: "You are an assistant" },
      { role: "user", content: "only one recent turn so summarization cannot split history" },
    ];

    const result = await compactAndFit({
      messages,
      effectiveMaxInputTokens: 500,
      toolDefinitionTokens: 0,
      allowTruncation: true,
      forceShrink: true,
      summarizationOptions: {
        apiKey: "test-key",
        userAgent: "test-agent",
      },
    });

    expect(result.compacted).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.fits).toBe(true);
  });
});
