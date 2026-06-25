import { NimChatMessage } from "../src/types";
import { estimateNimMessagesTokens, truncateMessagesForContext } from "../src/messages/converter";
import { splitMessagesForSummarization } from "../src/models/summarizer";

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
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
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
});
