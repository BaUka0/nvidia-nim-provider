import * as vscode from "vscode";
import { estimateTokens } from "../../src/messages/converter";
import { NimChatModelProvider } from "../../src/provider/chat-provider";

describe("NimChatModelProvider.provideTokenCount", () => {
  let provider: NimChatModelProvider;

  beforeEach(() => {
    const secrets = {
      get: jest.fn(),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(),
    } as unknown as vscode.SecretStorage;
    const globalState = {
      get: jest.fn(),
      update: jest.fn(),
      keys: jest.fn(),
    } as unknown as vscode.Memento;
    provider = new NimChatModelProvider(secrets, "test-ua", globalState);
  });

  const token = {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn(),
  } as unknown as vscode.CancellationToken;
  const model = {
    id: "kimi-k2.6",
    maxInputTokens: 100000,
    maxOutputTokens: 65536,
  } as unknown as vscode.LanguageModelChatInformation;

  const msg = (role: number, content: unknown[]) =>
    ({ role, content }) as unknown as vscode.LanguageModelChatRequestMessage;

  it("counts tokens for a plain string", async () => {
    await expect(provider.provideTokenCount(model, "Hello world", token)).resolves.toBe(
      estimateTokens("Hello world"),
    );
  });

  it("counts tokens for a text part message", async () => {
    const text = "The quick brown fox jumps over the lazy dog";
    await expect(
      provider.provideTokenCount(model, msg(1, [new vscode.LanguageModelTextPart(text)]), token),
    ).resolves.toBe(estimateTokens(text));
  });

  it("counts tool result parts by their inner content, not a flat 2 tokens", async () => {
    const longContent = "a".repeat(600);
    const result = await provider.provideTokenCount(
      model,
      msg(1, [
        new vscode.LanguageModelToolResultPart("call_1", [
          new vscode.LanguageModelTextPart(longContent),
        ]),
      ]),
      token,
    );
    expect(result).toBe(estimateTokens(longContent));
    expect(result).toBeGreaterThan(2);
  });

  it("counts structured tool result parts via their serialized value", async () => {
    const value = { filePath: "/tmp/a.txt", content: "x".repeat(300) };
    const result = await provider.provideTokenCount(
      model,
      msg(1, [new vscode.LanguageModelToolResultPart("call_1", [{ value }])]),
      token,
    );
    expect(result).toBe(estimateTokens(JSON.stringify(value)));
    expect(result).toBeGreaterThan(2);
  });

  it("counts tool call parts by name + serialized input", async () => {
    const args = { filePath: "/tmp/example.md", startLine: 1, endLine: 20 };
    const result = await provider.provideTokenCount(
      model,
      msg(2, [new vscode.LanguageModelToolCallPart("call_1", "read_file", args)]),
      token,
    );
    expect(result).toBe(estimateTokens("read_file") + estimateTokens(JSON.stringify(args)));
    expect(result).toBeGreaterThan(2);
  });

  it("counts text-decodable data parts (application/json base64)", async () => {
    const json = JSON.stringify({ filePath: "/tmp/a.txt", content: "hello there" });
    const data = Buffer.from(json, "utf8");
    const result = await provider.provideTokenCount(
      model,
      msg(1, [new vscode.LanguageModelDataPart(data, "application/json")]),
      token,
    );
    expect(result).toBe(estimateTokens(json));
  });

  it("counts image data parts with a size-aware heuristic", async () => {
    const bytes = new Uint8Array(3000);
    const result = await provider.provideTokenCount(
      model,
      msg(1, [new vscode.LanguageModelDataPart(bytes, "image/png")]),
      token,
    );
    expect(result).toBe(Math.max(4, Math.ceil(3000 / 750)));
    expect(result).toBeGreaterThan(2);
  });

  it("sums multiple heterogeneous parts in one message", async () => {
    const text = "Read this file";
    const args = { filePath: "/tmp/x.md", startLine: 1, endLine: 5 };
    const toolResult = "Sunny, 25C and humid with a chance of rain later";
    const expected =
      estimateTokens(text) +
      estimateTokens("read_file") +
      estimateTokens(JSON.stringify(args)) +
      estimateTokens(toolResult);

    const result = await provider.provideTokenCount(
      model,
      msg(2, [
        new vscode.LanguageModelTextPart(text),
        new vscode.LanguageModelToolCallPart("call_1", "read_file", args),
        new vscode.LanguageModelToolResultPart("call_0", [
          new vscode.LanguageModelTextPart(toolResult),
        ]),
      ]),
      token,
    );
    expect(result).toBe(expected);
  });

  it("resolves to 0 when token counting throws, instead of rejecting", async () => {
    const malformed = { content: null } as unknown as vscode.LanguageModelChatRequestMessage;
    await expect(provider.provideTokenCount(model, malformed, token)).resolves.toBe(0);
  });
});
