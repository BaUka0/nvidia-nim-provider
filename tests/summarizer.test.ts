import { NimChatMessage } from "../src/types";
import { chatCompletion } from "../src/api/client";
import { estimateNimMessagesTokens, truncateMessagesForContext } from "../src/messages/converter";
import { splitMessagesForSummarization, summarizeOldMessages } from "../src/models/summarizer";

jest.mock("../src/api/client", () => ({
  chatCompletion: jest.fn(),
  fetchModels: jest.fn(),
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

    const { oldMessages, recentMessages } = splitMessagesForSummarization(messages, 8);

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
  });
});
