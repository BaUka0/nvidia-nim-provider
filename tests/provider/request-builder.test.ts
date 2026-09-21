import * as vscode from "vscode";
import { chatCompletion } from "../../src/api/client";
import { getModelAdapter, ModelAdapter } from "../../src/models/adapters";
import { NimRequestBuilder, resolveReasoningMode } from "../../src/provider/request-builder";
import { ConfigManager } from "../../src/shared/config";
import { makeChatMessages, makeChatOptions, makeModel } from "../helpers/fakes";

jest.mock("../../src/api/client", () => ({
  chatCompletion: jest.fn(),
}));

jest.mock("vscode", () => ({
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
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
    id: "deepseek-ai/deepseek-v4-flash-0731",
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
      config: ConfigManager.getNimConfig(),
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
        config: ConfigManager.getNimConfig(),
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
        config: ConfigManager.getNimConfig(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect((chatCompletion as jest.Mock).mock.calls[0][2]).toBe(controller.signal);
  });

  it("applies configured generation parameters when options are omitted", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "generation.temperature") return 0.35;
        if (key === "generation.topP") return 0.85;
        if (key === "generation.maxOutputTokens") return 500;
        if (key === "reasoning.mode") return "on";
        return defaultValue;
      }),
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: createModel(),
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.temperature).toBe(0.35);
    expect(prepared.requestBody.top_p).toBe(0.85);
    expect(prepared.requestBody.max_tokens).toBe(500);
  });

  it("sets Nemotron default temperature and top_p when unconfigured", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const nemotronModel = makeModel({
      id: "nvidia/nemotron-3-ultra-550b-a55b",
      name: "Nemotron 3 Ultra 550B",
      maxInputTokens: 100000,
      maxOutputTokens: 65536,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: nemotronModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.temperature).toBe(1);
    expect(prepared.requestBody.top_p).toBe(0.95);
  });

  it("defaults DeepSeek requests to temperature 1.0 and top_p 0.95 when unconfigured", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    });

    const deepseekModel = makeModel({
      id: "deepseek-ai/deepseek-v4-flash-0731",
      name: "DeepSeek V4 Flash",
      maxInputTokens: 100000,
      maxOutputTokens: 65536,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: deepseekModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.temperature).toBe(1);
    expect(prepared.requestBody.top_p).toBe(0.95);
  });
});

describe("NimRequestBuilder.convertMessagesWithProfile", () => {
  const customAdapter = {
    ...getModelAdapter("deepseek-ai/deepseek-v4-flash-0731"),
    getProfile: () => ({
      defaultTemperature: 1,
      extraSystemMessages: ["Custom system directive", "Formatting rules"],
    }),
  } as unknown as ModelAdapter;

  it("consolidates extra system messages into a single system turn when input has no system message", () => {
    const inputMessages = makeChatMessages({
      role: 1,
      content: [new vscode.LanguageModelTextPart("Hello")],
    });

    const result = NimRequestBuilder.convertMessagesWithProfile({
      messages: inputMessages,
      contextWindow: 128000,
      adapter: customAdapter,
      supportsVision: false,
      toolsEnabled: true,
    });

    const systemMessages = result.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain("Custom system directive");
    expect(systemMessages[0].content).toContain("Formatting rules");
    expect(result[1].role).toBe("user");
  });

  it("merges extra system messages with the existing leading system message into a single turn", () => {
    const inputMessages = makeChatMessages(
      {
        role: 3,
        content: [new vscode.LanguageModelTextPart("You are VS Code Copilot.")],
      },
      {
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      },
    );

    const result = NimRequestBuilder.convertMessagesWithProfile({
      messages: inputMessages,
      contextWindow: 128000,
      adapter: customAdapter,
      supportsVision: false,
      toolsEnabled: true,
    });

    const systemMessages = result.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain("Custom system directive");
    expect(systemMessages[0].content).toContain("Formatting rules");
    expect(systemMessages[0].content).toContain("You are VS Code Copilot.");
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
  });

  it("does not add extra system guidance when adapter supplies no extra system messages", () => {
    const inputMessages = makeChatMessages({
      role: 1,
      content: [new vscode.LanguageModelTextPart("Hello")],
    });

    const result = NimRequestBuilder.convertMessagesWithProfile({
      messages: inputMessages,
      contextWindow: 128000,
      adapter: getModelAdapter("deepseek-ai/deepseek-v4-flash-0731"),
      supportsVision: false,
      toolsEnabled: true,
    });

    const systemMessages = result.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(0);
    expect(result[0].role).toBe("user");
  });
});

describe("resolveReasoningMode", () => {
  it("maps 'on' to the highest standard active mode when model does not explicitly declare 'on'", () => {
    expect(resolveReasoningMode("on", ["none", "low", "high"])).toBe("high");
    expect(resolveReasoningMode("on", ["none", "high", "max"])).toBe("high");
    expect(resolveReasoningMode("on", ["none", "medium", "high", "xhigh"])).toBe("high");
    expect(resolveReasoningMode("on", ["low", "max"])).toBe("low");
  });

  it("handles case-insensitivity and whitespace", () => {
    expect(resolveReasoningMode("  ON  ", ["none", "low", "high"])).toBe("high");
    expect(resolveReasoningMode("HIGH", ["none", "low", "high"])).toBe("high");
    expect(resolveReasoningMode("None", ["none", "low", "high"])).toBe("none");
    expect(resolveReasoningMode("Off", ["none", "low", "high"])).toBe("none");
  });

  it("maps 'auto' to the best active mode", () => {
    expect(resolveReasoningMode("auto", ["none", "low", "high"])).toBe("high");
    expect(resolveReasoningMode("auto", ["none", "medium", "high", "xhigh"])).toBe("high");
    expect(resolveReasoningMode("auto", ["low", "max"])).toBe("low");
  });

  it("preserves exact supported modes", () => {
    expect(resolveReasoningMode("low", ["none", "low", "high"])).toBe("low");
    expect(resolveReasoningMode("high", ["none", "low", "high"])).toBe("high");
    expect(resolveReasoningMode("none", ["none", "low", "high"])).toBe("none");
    expect(resolveReasoningMode("on", ["none", "on"])).toBe("on");
  });

  it("maps 'medium' to 'low' or 'high' if medium is not present", () => {
    expect(resolveReasoningMode("medium", ["none", "low", "high"])).toBe("low");
    expect(resolveReasoningMode("medium", ["none", "high", "max"])).toBe("high");
  });

  it("maps 'max' to 'high' if max is not present", () => {
    expect(resolveReasoningMode("max", ["none", "low", "high"])).toBe("high");
  });

  it("maps 'none' or 'off' to 'none' when available", () => {
    expect(resolveReasoningMode("none", ["none", "low", "high"])).toBe("none");
    expect(resolveReasoningMode("off", ["none", "low", "high"])).toBe("none");
    expect(resolveReasoningMode("none", ["low", "high"])).toBe("low");
    expect(resolveReasoningMode("off", ["low", "high"])).toBe("low");
  });

  it("maps unknown mode strings to the best active mode instead of disabling reasoning", () => {
    expect(resolveReasoningMode("thinking", ["none", "low", "high"])).toBe("high");
    expect(resolveReasoningMode("deep", ["none", "high", "max"])).toBe("high");
    expect(resolveReasoningMode("custom", ["low", "max"])).toBe("low");
  });

  it("handles missing or empty supportedModes gracefully", () => {
    expect(resolveReasoningMode("on", undefined)).toBe("on");
    expect(resolveReasoningMode("on", [])).toBe("on");
    expect(resolveReasoningMode(undefined, ["none", "low", "high"])).toBe("none");
    expect(resolveReasoningMode(undefined, ["low", "high"])).toBe("low");
  });

  it("automaps configured reasoningMode in prepareRequest", async () => {
    const deepseekModel = makeModel({
      id: "deepseek-ai/deepseek-v4-flash-0731",
      name: "DeepSeek V4 Flash",
      maxInputTokens: 100000,
      maxOutputTokens: 65536,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: deepseekModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions({
        modelConfiguration: { reasoningMode: "on" },
      }),
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: "high",
    });
    expect(prepared.reasoningIsolationExpected).toBe(true);
  });

  it("applies parallel_tool_calls: false and toolTemperature: 0.6 for Nemotron when tools are enabled", async () => {
    const nemotronModel = makeModel({
      id: "nvidia/nemotron-3-super-120b-a12b",
      name: "Nemotron 3 Super 120B",
      maxInputTokens: 100000,
      maxOutputTokens: 16384,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: nemotronModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Find files")],
      }),
      options: makeChatOptions({
        tools: [
          {
            name: "find_files",
            description: "Find files by pattern",
            inputSchema: { type: "object" },
          },
        ],
      }),
      contextWindow: 131072,
      supportsTools: true,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.tools).toHaveLength(1);
    expect(prepared.requestBody.parallel_tool_calls).toBe(false);
    expect(prepared.requestBody.temperature).toBe(0.6);
  });

  it("does not set parallel_tool_calls when tools are disabled for Nemotron", async () => {
    const nemotronModel = makeModel({
      id: "nvidia/nemotron-3-super-120b-a12b",
      name: "Nemotron 3 Super 120B",
      maxInputTokens: 100000,
      maxOutputTokens: 16384,
    });

    const prepared = await NimRequestBuilder.prepareRequest({
      model: nemotronModel,
      messages: makeChatMessages({
        role: 1,
        content: [new vscode.LanguageModelTextPart("Hello")],
      }),
      options: makeChatOptions(),
      contextWindow: 131072,
      supportsTools: true,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.tools).toBeUndefined();
    expect(prepared.requestBody.parallel_tool_calls).toBeUndefined();
    expect(prepared.requestBody.temperature).toBe(1);
  });
});
