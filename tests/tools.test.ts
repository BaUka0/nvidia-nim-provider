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
import {
  makeSecrets,
  makeToken,
  makeToolInvokeOptions,
  makeToolPrepareOptions,
} from "./helpers/fakes";

describe("NimAnalyzeImageTool", () => {
  let tool: NimAnalyzeImageTool;
  let secrets: ReturnType<typeof makeSecrets>;

  beforeEach(() => {
    secrets = makeSecrets();
    tool = new NimAnalyzeImageTool(secrets);
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
      makeToolInvokeOptions({ image_data: "data:image/png;base64,abc", prompt: "What is this?" }),
      makeToken(),
    );
    expect((result.content as { value: string }[])[0].value).toBe("Analyzed result");
  });

  it("handles analyzeImage errors gracefully", async () => {
    jest.spyOn(NimVisionClient.prototype, "analyzeImage").mockRejectedValue(new Error("API down"));
    const failingTool = new NimAnalyzeImageTool(secrets);
    const result = await failingTool.invoke(
      makeToolInvokeOptions({ image_data: "data:image/png;base64,abc", prompt: "What?" }),
      makeToken(),
    );
    expect((result.content as { value: string }[])[0].value).toContain("Failed to analyze image");
    expect((result.content as { value: string }[])[0].value).toContain("API down");
  });

  it("rejects remote image URLs before any API access", async () => {
    jest.restoreAllMocks();
    const result = await tool.invoke(
      makeToolInvokeOptions({ image_data: "https://example.com/cat.png", prompt: "What is this?" }),
      makeToken(),
    );
    expect((result.content as { value: string }[])[0].value).toContain(
      "requires a base64 image data URL",
    );
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("rejects non-base64 data URLs before any API access", async () => {
    jest.restoreAllMocks();
    const result = await tool.invoke(
      makeToolInvokeOptions({ image_data: "data:image/png,not-base64", prompt: "What is this?" }),
      makeToken(),
    );
    expect((result.content as { value: string }[])[0].value).toContain(
      "requires a base64 image data URL",
    );
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("prepareInvocation returns invocation message", async () => {
    const prepared = await tool.prepareInvocation!(
      makeToolPrepareOptions({ image_data: "", prompt: "" }),
      makeToken(),
    );
    expect(prepared).toEqual({ invocationMessage: "Analyzing image with NVIDIA NIM Vision..." });
  });
});

describe("registerNimTools", () => {
  it("returns a disposable", () => {
    const secrets = makeSecrets();
    const disposable = registerNimTools(secrets);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe("function");
    expect(vscode.Disposable.from).toHaveBeenCalled();
    expect(vscode.lm.registerTool).toHaveBeenCalledWith(
      "nvidia_nim_analyze_image",
      expect.any(NimAnalyzeImageTool),
    );
  });
});
