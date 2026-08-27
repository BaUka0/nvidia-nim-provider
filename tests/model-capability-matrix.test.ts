import { MODEL_LIST, NvidiaModelCatalogEntry, normalizeNvidiaModels } from "../src/models/catalog";
import {
  getModelAdapter,
  getModelCapabilityContract,
  ModelAdapter,
  ReasoningParameterFormat,
  ReasoningRouting,
  ToolCallProtocol,
} from "../src/models/adapters";
import { ReasoningStreamRouter } from "../src/messages/reasoning-router";
import { ToolCallStreamAggregator } from "../src/provider/tool-call-aggregator";
import { getIncompleteTextToolCallName } from "../src/tools/parser";
import { NimChatRequest } from "../src/types";

interface ReasoningModeCase {
  mode: string;
  expectedFields: Record<string, unknown>;
}

interface CapabilityMatrixCase {
  modelId: string;
  catalog: NvidiaModelCatalogEntry;
  reasoningModes: string[];
  reasoningCases: ReasoningModeCase[];
  reasoningParameterFormat: ReasoningParameterFormat;
  toolCallProtocol: ToolCallProtocol;
  reasoningRouting: ReasoningRouting;
  responseSanitization: "none" | "model-specific";
  contentOnlyMode: string;
  contentOnlyRouting: "text" | "thinking";
  thinkTag: "think" | "mm:think";
}

const deepSeekReasoningCases: ReasoningModeCase[] = [
  {
    mode: "none",
    expectedFields: { chat_template_kwargs: { thinking: false } },
  },
  {
    mode: "high",
    expectedFields: {
      chat_template_kwargs: { thinking: true, reasoning_effort: "high" },
    },
  },
  {
    mode: "max",
    expectedFields: {
      chat_template_kwargs: { thinking: true, reasoning_effort: "max" },
    },
  },
];

const CAPABILITY_MATRIX: CapabilityMatrixCase[] = [
  {
    modelId: "deepseek-ai/deepseek-v4-flash-0731",
    catalog: {
      displayName: "DeepSeek V4 Flash 0731",
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      supportsTools: true,
      supportsVision: false,
    },
    reasoningModes: ["none", "high", "max"],
    reasoningCases: deepSeekReasoningCases,
    reasoningParameterFormat: "chat_template_kwargs",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "deepseek-ai/deepseek-v4-pro-0813",
    catalog: {
      displayName: "DeepSeek V4 Pro 0813",
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      supportsTools: true,
      supportsVision: false,
    },
    reasoningModes: ["none", "high", "max"],
    reasoningCases: deepSeekReasoningCases,
    reasoningParameterFormat: "chat_template_kwargs",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "minimaxai/minimax-m3",
    catalog: {
      displayName: "MiniMax M3",
      contextWindow: 1000000,
      maxOutputTokens: 100000,
      supportsTools: true,
      supportsVision: true,
    },
    reasoningModes: ["none", "on", "adaptive"],
    reasoningCases: [
      {
        mode: "none",
        expectedFields: { chat_template_kwargs: { thinking_mode: "disabled" } },
      },
      {
        mode: "on",
        expectedFields: { chat_template_kwargs: { thinking_mode: "enabled" } },
      },
      {
        mode: "adaptive",
        expectedFields: { chat_template_kwargs: { thinking_mode: "adaptive" } },
      },
    ],
    reasoningParameterFormat: "chat_template_kwargs",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "mm:think",
  },
  {
    modelId: "moonshotai/kimi-k3",
    catalog: {
      displayName: "Kimi K3",
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      supportsTools: true,
      supportsVision: true,
    },
    reasoningModes: ["none", "low", "high", "max"],
    reasoningCases: [
      { mode: "none", expectedFields: { reasoning_effort: "none" } },
      { mode: "low", expectedFields: { reasoning_effort: "low" } },
      { mode: "high", expectedFields: { reasoning_effort: "high" } },
      { mode: "max", expectedFields: { reasoning_effort: "max" } },
    ],
    reasoningParameterFormat: "reasoning_effort",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "nvidia/nemotron-3-ultra-550b-a55b",
    catalog: {
      displayName: "Nemotron 3 Ultra 550B",
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      supportsTools: true,
      supportsVision: false,
    },
    reasoningModes: ["none", "medium", "high"],
    reasoningCases: [
      { mode: "none", expectedFields: { reasoning_effort: "none" } },
      { mode: "medium", expectedFields: { reasoning_effort: "medium" } },
      { mode: "high", expectedFields: { reasoning_effort: "high" } },
    ],
    reasoningParameterFormat: "reasoning_effort",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "nvidia/nemotron-3-super-120b-a12b",
    catalog: {
      displayName: "Nemotron 3 Super 120B",
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      supportsTools: true,
      supportsVision: false,
    },
    reasoningModes: ["none", "low", "high"],
    reasoningCases: [
      {
        mode: "none",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: false },
        },
      },
      {
        mode: "low",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: true, low_effort: true },
        },
      },
      {
        mode: "high",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: true },
        },
      },
    ],
    reasoningParameterFormat: "chat_template_kwargs",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
    catalog: {
      displayName: "Nemotron 3.5 Lightning 30B",
      contextWindow: 1000000,
      maxOutputTokens: 32768,
      supportsTools: true,
      supportsVision: false,
    },
    reasoningModes: ["none", "medium", "high", "xhigh"],
    reasoningCases: [
      {
        mode: "none",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: false, reasoning_budget: 0 },
        },
      },
      {
        mode: "medium",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: true, reasoning_budget: 16384 },
        },
      },
      {
        mode: "high",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: true, reasoning_budget: 26214 },
        },
      },
      {
        mode: "xhigh",
        expectedFields: {
          chat_template_kwargs: { enable_thinking: true, reasoning_budget: 31130 },
        },
      },
    ],
    reasoningParameterFormat: "chat_template_kwargs",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "isolated",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "stepfun-ai/step-3.7-flash",
    catalog: {
      displayName: "Step 3.7 Flash",
      contextWindow: 262144,
      maxOutputTokens: 262144,
      supportsTools: true,
      supportsVision: true,
    },
    reasoningModes: [],
    reasoningCases: [],
    reasoningParameterFormat: "none",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "direct-content",
    responseSanitization: "none",
    contentOnlyMode: "none",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
  {
    modelId: "meta/muse-glimmer-30b",
    catalog: {
      displayName: "Muse Glimmer",
      contextWindow: 131072,
      maxOutputTokens: 32768,
      supportsTools: true,
      supportsVision: true,
    },
    reasoningModes: ["none", "low", "medium", "high", "xhigh"],
    reasoningCases: ["none", "low", "medium", "high", "xhigh"].map((mode) => ({
      mode,
      expectedFields: { reasoning_effort: mode },
    })),
    reasoningParameterFormat: "reasoning_effort",
    toolCallProtocol: "native-and-text",
    reasoningRouting: "direct-content",
    responseSanitization: "none",
    contentOnlyMode: "medium",
    contentOnlyRouting: "text",
    thinkTag: "think",
  },
];

function getReasoningFields(request: NimChatRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if ("reasoning_effort" in request) {
    result.reasoning_effort = request.reasoning_effort;
  }
  if ("chat_template_kwargs" in request) {
    result.chat_template_kwargs = request.chat_template_kwargs;
  }
  if ("enable_thinking" in request) {
    result.enable_thinking = request.enable_thinking;
  }
  return result;
}

function reasoningIsolationExpected(adapter: ModelAdapter, mode: string): boolean {
  return (
    (Boolean(adapter.applyReasoningMode) &&
      mode !== "none" &&
      adapter.isolateUntaggedReasoning !== false) ||
    Boolean(adapter.alwaysReasons)
  );
}

function createRouter(
  adapter: ModelAdapter,
  mode: string,
): {
  router: ReasoningStreamRouter;
  thinking: string[];
  text: string[];
} {
  const thinking: string[] = [];
  const text: string[] = [];
  return {
    thinking,
    text,
    router: new ReasoningStreamRouter({
      reasoningIsolationExpected: reasoningIsolationExpected(adapter, mode),
      onThinking: (value) => thinking.push(value),
      onText: (value) => text.push(value),
    }),
  };
}

describe("curated model capability matrix", () => {
  it("covers every curated whitelist model exactly once", () => {
    expect(CAPABILITY_MATRIX.map(({ modelId }) => modelId).sort()).toEqual(
      Object.keys(MODEL_LIST).sort(),
    );
  });

  it.each(CAPABILITY_MATRIX)("$modelId pins the exact catalog and adapter contract", (entry) => {
    expect(MODEL_LIST[entry.modelId]).toEqual(entry.catalog);
    expect(getModelCapabilityContract(entry.modelId)).toEqual({
      reasoningModes: entry.reasoningModes,
      reasoningParameterFormat: entry.reasoningParameterFormat,
      toolCallProtocol: entry.toolCallProtocol,
      reasoningRouting: entry.reasoningRouting,
      responseSanitization: entry.responseSanitization,
    });
    expect(getModelAdapter(entry.modelId).parseTextEmbeddedToolCalls).toEqual(expect.any(Function));
  });

  it.each(
    CAPABILITY_MATRIX.flatMap((entry) =>
      entry.reasoningCases.map((reasoningCase) => ({ ...entry, reasoningCase })),
    ),
  )(
    "$modelId sends exact reasoning fields for $reasoningCase.mode",
    ({ modelId, reasoningCase }) => {
      const request: NimChatRequest = { model: modelId, messages: [] };
      getModelAdapter(modelId).applyReasoningMode!(request, reasoningCase.mode);
      expect(getReasoningFields(request)).toEqual(reasoningCase.expectedFields);
    },
  );

  it("keeps Stepfun content-only responses visible without inventing an API toggle", () => {
    const adapter = getModelAdapter("stepfun-ai/step-3.7-flash");
    expect(adapter.supportedReasoningModes).toBeUndefined();
    expect(adapter.applyReasoningMode).toBeUndefined();
    expect(adapter.isolateUntaggedReasoning).toBe(false);
  });

  it.each(CAPABILITY_MATRIX)(
    "$modelId has an explicit content-only routing expectation",
    (entry) => {
      const adapter = getModelAdapter(entry.modelId);
      const { router, thinking, text } = createRouter(adapter, entry.contentOnlyMode);

      router.handleContent("content-only answer");
      router.flush();

      if (entry.contentOnlyRouting === "text") {
        expect(text.join("")).toBe("content-only answer");
        expect(thinking).toEqual([]);
      } else {
        expect(thinking.join("")).toBe("content-only answer");
        expect(text).toEqual([]);
      }
    },
  );

  it.each(
    CAPABILITY_MATRIX.filter((entry) => entry.reasoningModes.some((mode) => mode !== "none")),
  )(
    "$modelId keeps a content-only reply visible when reasoning is enabled but never arrives",
    (entry) => {
      const adapter = getModelAdapter(entry.modelId);
      const activeMode = entry.reasoningModes.find((mode) => mode !== "none") ?? "none";
      const { router, thinking, text } = createRouter(adapter, activeMode);

      router.handleContent("plain answer without reasoning");
      router.flush();

      expect(text.join("")).toBe("plain answer without reasoning");
      expect(thinking).toEqual([]);
    },
  );

  it.each(CAPABILITY_MATRIX)(
    "$modelId routes separate reasoning_content before the answer",
    (entry) => {
      const adapter = getModelAdapter(entry.modelId);
      const activeMode = entry.reasoningModes.find((mode) => mode !== "none") ?? "none";
      const { router, thinking, text } = createRouter(adapter, activeMode);

      router.handleReasoningContent("reasoning");
      router.handleContent("ans");
      router.handleContent("wer");
      router.flush();

      expect(thinking.join("")).toBe("reasoning");
      expect(text.join("")).toBe("answer");
    },
  );

  it.each(CAPABILITY_MATRIX)("$modelId handles split open and close think tags", (entry) => {
    const adapter = getModelAdapter(entry.modelId);
    const activeMode = entry.reasoningModes.find((mode) => mode !== "none") ?? "none";
    const { router, thinking, text } = createRouter(adapter, activeMode);
    const openPrefix = entry.thinkTag === "mm:think" ? "<mm:th" : "<th";
    const openSuffix = "ink>reasoning";
    const closePrefix = entry.thinkTag === "mm:think" ? "</mm:th" : "</th";

    router.handleContent(openPrefix);
    router.handleContent(openSuffix);
    router.handleContent(closePrefix);
    router.handleContent("ink>answer");
    router.flush();

    expect(thinking.join("")).toBe("reasoning");
    expect(text.join("")).toBe("answer");
  });

  it.each(CAPABILITY_MATRIX)("$modelId accepts split native tool-call arguments", (entry) => {
    const emitted: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const skipped: string[] = [];
    const aggregator = new ToolCallStreamAggregator({
      options: {
        modelOptions: {},
        tools: [
          {
            name: "lookup_city",
            description: "Look up a city",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      } as never,
      messages: [],
      onEmitToolCall: (id, name, args) => emitted.push({ id, name, args }),
      onSkipToolCall: (name) => skipped.push(name),
    });

    aggregator.handleToolCalls([
      {
        index: 0,
        id: `${entry.modelId}:call-1`,
        type: "function",
        function: { name: "lookup_city", arguments: '{"city":' },
      } as never,
    ]);
    aggregator.handleToolCalls([
      {
        index: 0,
        function: { arguments: '"Tokyo"}' },
      } as never,
    ]);
    aggregator.flushRemaining();

    expect(entry.toolCallProtocol).toBe("native-and-text");
    expect(emitted).toEqual([
      {
        id: `${entry.modelId}:call-1`,
        name: "lookup_city",
        args: { city: "Tokyo" },
      },
    ]);
    expect(skipped).toEqual([]);
  });

  it.each(CAPABILITY_MATRIX)("$modelId accepts the text tool-call fallback", (entry) => {
    const parser = getModelAdapter(entry.modelId).parseTextEmbeddedToolCalls!;
    const parsed = parser(
      '<|tool_call_begin|>lookup_city<|tool_call_argument_begin|>{"city":"Tokyo"}<|tool_call_end|>',
    );

    expect(entry.toolCallProtocol).toBe("native-and-text");
    expect(parsed.incompleteText).toBe("");
    expect(parsed.segments).toEqual([
      {
        type: "toolCall",
        toolCall: { name: "lookup_city", args: { city: "Tokyo" } },
      },
    ]);
  });

  it.each(CAPABILITY_MATRIX)(
    "$modelId classifies malformed and truncated text tool calls",
    (entry) => {
      const parser = getModelAdapter(entry.modelId).parseTextEmbeddedToolCalls!;
      const malformed = parser(
        '<|tool_call_begin|>lookup_city<|tool_call_argument_begin|>{"city":"Tokyo"<|tool_call_end|>',
      );
      const truncated = parser(
        '<|tool_call_begin|>lookup_city<|tool_call_argument_begin|>{"city":"Tok',
      );

      expect(malformed.segments).toEqual([{ type: "invalidToolCall", name: "lookup_city" }]);
      expect(malformed.incompleteText).toBe("");
      expect(truncated.segments).toEqual([]);
      expect(getIncompleteTextToolCallName(truncated.incompleteText)).toBe("lookup_city");
    },
  );

  it.each(CAPABILITY_MATRIX.filter((entry) => entry.catalog.supportsVision))(
    "$modelId explicitly supports vision input",
    (entry) => {
      expect(MODEL_LIST[entry.modelId].supportsVision).toBe(true);
    },
  );

  it.each(CAPABILITY_MATRIX.filter((entry) => !entry.catalog.supportsVision))(
    "$modelId explicitly rejects vision input",
    (entry) => {
      expect(MODEL_LIST[entry.modelId].supportsVision).toBe(false);
    },
  );

  it("uses curated capabilities instead of trusting an API capability default", () => {
    const normalized = normalizeNvidiaModels([
      {
        id: "deepseek-ai/deepseek-v4-flash-0731",
        capabilities: { tool_calling: false, vision: true },
      },
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({
        supportsTools: true,
        supportsVision: false,
      }),
    ]);
  });

  it("fails closed for models outside the curated whitelist", () => {
    expect(
      normalizeNvidiaModels([
        {
          id: "new-provider/model-with-every-capability",
          capabilities: { tool_calling: true, vision: true },
          metadata: { context_window: 1000000, max_output_tokens: 100000 },
        },
      ]),
    ).toEqual([]);
  });
});
