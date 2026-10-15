import * as vscode from "vscode";
import { estimateTokens } from "../../src/messages/converter";
import { MESSAGE_OVERHEAD_TOKENS } from "../../src/messages/token-estimate";
import { NimChatModelProvider } from "../../src/provider/chat-provider";
import {
  asRequestMessage,
  makeMemento,
  makeModel,
  makeRequestMessage,
  makeSecrets,
  makeToken,
} from "../helpers/fakes";

describe("NimChatModelProvider.provideTokenCount", () => {
  let provider: NimChatModelProvider;

  beforeEach(() => {
    const secrets = makeSecrets();
    const globalState = makeMemento();
    provider = new NimChatModelProvider(secrets, "test-ua", globalState);
  });

  const token = makeToken();
  const model = makeModel({ id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 });

  const msg = (role: number, content: unknown[]) => makeRequestMessage({ role, content });

  it("counts tokens for a plain string", async () => {
    await expect(provider.provideTokenCount(model, "Hello world", token)).resolves.toBe(
      estimateTokens("Hello world"),
    );
  });

  it("counts tokens for a text part message", async () => {
    const text = "The quick brown fox jumps over the lazy dog";
    await expect(
      provider.provideTokenCount(model, msg(1, [new vscode.LanguageModelTextPart(text)]), token),
    ).resolves.toBe(MESSAGE_OVERHEAD_TOKENS + estimateTokens(text));
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
    expect(result).toBe(MESSAGE_OVERHEAD_TOKENS + estimateTokens(longContent));
    expect(result).toBeGreaterThan(2);
  });

  it("counts structured tool result parts via their serialized value", async () => {
    const value = { filePath: "/tmp/a.txt", content: "x".repeat(300) };
    const result = await provider.provideTokenCount(
      model,
      msg(1, [new vscode.LanguageModelToolResultPart("call_1", [{ value }])]),
      token,
    );
    expect(result).toBe(MESSAGE_OVERHEAD_TOKENS + estimateTokens(JSON.stringify(value)));
    expect(result).toBeGreaterThan(2);
  });

  it("counts tool call parts by name + serialized input", async () => {
    const args = { filePath: "/tmp/example.md", startLine: 1, endLine: 20 };
    const result = await provider.provideTokenCount(
      model,
      msg(2, [new vscode.LanguageModelToolCallPart("call_1", "read_file", args)]),
      token,
    );
    expect(result).toBe(
      MESSAGE_OVERHEAD_TOKENS + estimateTokens("read_file") + estimateTokens(JSON.stringify(args)),
    );
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
    expect(result).toBe(MESSAGE_OVERHEAD_TOKENS + estimateTokens(json));
  });

  it("counts image data parts by pixel size, not byte size", async () => {
    // A 1024x1024 PNG header: 37 x 37 patches of 28 px + 2, as Muse Glimmer reports.
    const bytes = new Uint8Array(3000);
    bytes.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ]);
    bytes.set([0, 0, 4, 0, 0, 0, 4, 0], 16);
    const result = await provider.provideTokenCount(
      model,
      msg(1, [new vscode.LanguageModelDataPart(bytes, "image/png")]),
      token,
    );
    expect(result).toBe(MESSAGE_OVERHEAD_TOKENS + 1371);
  });

  it("sums multiple heterogeneous parts in one message", async () => {
    const text = "Read this file";
    const args = { filePath: "/tmp/x.md", startLine: 1, endLine: 5 };
    const toolResult = "Sunny, 25C and humid with a chance of rain later";
    const expected =
      MESSAGE_OVERHEAD_TOKENS +
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
    const malformed = asRequestMessage({ content: null });
    await expect(provider.provideTokenCount(model, malformed, token)).resolves.toBe(0);
  });
});
