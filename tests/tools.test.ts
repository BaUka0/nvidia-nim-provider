import * as vscode from "vscode";
import { NimAnalyzeImageTool, registerNimTools } from "../src/tools/vision";

jest.mock("vscode", () => ({
  LanguageModelToolResult: class {
    constructor(public content: Array<{ value: string }>) {}
  },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  Disposable: {
    from: jest.fn(() => ({ dispose: jest.fn() })),
  },
  lm: {
    registerTool: jest.fn(() => ({ dispose: jest.fn() })),
  },
}));

import { NimVisionClient } from "../src/tools/vision";

describe("NimAnalyzeImageTool", () => {
  let tool: NimAnalyzeImageTool;
  let secrets: { get: jest.Mock };

  beforeEach(() => {
    secrets = { get: jest.fn() };
    tool = new NimAnalyzeImageTool(secrets as any);
    jest.spyOn(NimVisionClient.prototype, "analyzeImage").mockResolvedValue("Analyzed result");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("nvidia_nim_analyze_image");
    expect(tool.description).toContain("Analyze an image");
    expect(tool.tags).toContain("vision");
  });

  it("invokes analyzeImage successfully", async () => {
    const result = await tool.invoke(
      {
        input: { image_data: "data:image/png;base64,abc", prompt: "What is this?" },
      } as any,
      { isCancellationRequested: false } as any,
    );
    expect((result.content[0] as any).value).toBe("Analyzed result");
  });

  it("handles analyzeImage errors gracefully", async () => {
    jest.spyOn(NimVisionClient.prototype, "analyzeImage").mockRejectedValue(new Error("API down"));
    const failingTool = new NimAnalyzeImageTool(secrets as any);
    const result = await failingTool.invoke(
      {
        input: { image_data: "data:image/png;base64,abc", prompt: "What?" },
      } as any,
      { isCancellationRequested: false } as any,
    );
    expect((result.content[0] as any).value).toContain("Failed to analyze image");
    expect((result.content[0] as any).value).toContain("API down");
  });

  it("rejects remote image URLs before any API access", async () => {
    jest.restoreAllMocks();
    const result = await tool.invoke(
      {
        input: { image_data: "https://example.com/cat.png", prompt: "What is this?" },
      } as any,
      { isCancellationRequested: false } as any,
    );
    expect((result.content[0] as any).value).toContain("requires a base64 image data URL");
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("rejects non-base64 data URLs before any API access", async () => {
    jest.restoreAllMocks();
    const result = await tool.invoke(
      {
        input: { image_data: "data:image/png,not-base64", prompt: "What is this?" },
      } as any,
      { isCancellationRequested: false } as any,
    );
    expect((result.content[0] as any).value).toContain("requires a base64 image data URL");
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("prepareInvocation returns invocation message", async () => {
    const prepared = await tool.prepareInvocation!(
      { input: { image_data: "", prompt: "" } } as any,
      { isCancellationRequested: false } as any,
    );
    expect(prepared).toEqual({ invocationMessage: "Analyzing image with NVIDIA NIM Vision..." });
  });
});

describe("registerNimTools", () => {
  it("returns a disposable", () => {
    const secrets = { get: jest.fn() } as any;
    const disposable = registerNimTools(secrets);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe("function");
    expect(vscode.Disposable.from).toHaveBeenCalled();
    expect((vscode as any).lm.registerTool).toHaveBeenCalledWith(
      "nvidia_nim_analyze_image",
      expect.any(NimAnalyzeImageTool),
    );
  });
});
