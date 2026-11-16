import * as vscode from "vscode";
import { chatCompletion } from "../src/api/client";
import { MODEL_LIST } from "../src/models/catalog";
import { MODELS_STATE_KEY } from "../src/shared/constants";
import { NimAnalyzeImageTool, registerNimTools } from "../src/tools/vision";

jest.mock("../src/api/client", () => ({
  chatCompletion: jest.fn(),
}));

jest.mock("vscode", () => ({
  version: "1.125.0",
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
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    })),
  },
}));

import { NimVisionClient } from "../src/tools/vision";
import {
  makeMemento,
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

describe("NimVisionClient.analyzeImage max_tokens budget", () => {
  const validPngDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;

  beforeEach(() => {
    jest.restoreAllMocks();
    (chatCompletion as jest.Mock).mockReset();
  });

  it.each([
    ["meta/muse-glimmer-30b", 2000],
    ["mistralai/mistral-large-4-1t-a52b", 8192],
    ["stepfun-ai/step-5-preview", 8192],
  ])("uses max_tokens %i when analyzing with %s", async (modelId, expectedMaxTokens) => {
    const secrets = makeSecrets();
    (secrets.get as jest.Mock).mockResolvedValue("nvapi-testkey12345");
    const entry = MODEL_LIST[modelId];
    const memento = makeMemento((key) =>
      key === MODELS_STATE_KEY
        ? [
            {
              id: modelId,
              displayName: entry.displayName,
              contextWindow: entry.contextWindow,
              maxOutputTokens: entry.maxOutputTokens,
              supportsTools: entry.supportsTools,
              supportsVision: entry.supportsVision,
            },
          ]
        : undefined,
    );
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: (key: string, defaultValue: unknown) =>
        key === "fallback.visionModel" ? modelId : defaultValue,
    }));
    (chatCompletion as jest.Mock).mockResolvedValueOnce("Detailed image description");

    const client = new NimVisionClient(secrets, memento);
    const output = await client.analyzeImage(validPngDataUrl, "Describe this diagram");

    expect(output).toBe("Detailed image description");
    const sentBody = (chatCompletion as jest.Mock).mock.calls[0]?.[1];
    expect(sentBody?.model).toBe(modelId);
    expect(sentBody?.max_tokens).toBe(expectedMaxTokens);
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
