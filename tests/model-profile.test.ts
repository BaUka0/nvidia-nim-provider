import { getModelAdapter } from "../src/models/adapters";
import { NimChatRequest } from "../src/types";

describe("getModelAdapter", () => {
  it.each([
    ["kimi-k3", 0.2, 0.1, "Do not reveal chain-of-thought"],
    ["zai-org/glm-4.5", 0.1, 0.05, "strict JSON arguments"],
    ["z-ai/glm-5.2", 0.1, 0.05, "strict JSON arguments"],
    ["nemotron-70b", 0.2, 0.1, "Do not wrap tool arguments in markdown fences"],
  ])(
    "returns a specialized tool-enabled profile for %s",
    (
      modelId: string,
      expectedDefaultTemperature: number,
      expectedToolTemperature: number,
      expectedMessageSnippet: string,
    ) => {
      const adapter = getModelAdapter(modelId);
      const profile = adapter.getProfile({ toolsEnabled: true });

      expect(profile.defaultTemperature).toBe(expectedDefaultTemperature);
      expect(profile.toolTemperature).toBe(expectedToolTemperature);
      expect(profile.extraSystemMessages).toEqual(
        expect.arrayContaining([expect.stringContaining(expectedMessageSnippet)]),
      );
    },
  );

  it("does not add extra system guidance when tools are disabled", () => {
    const adapter = getModelAdapter("kimi-k2.6");
    const profile = adapter.getProfile({ toolsEnabled: false });

    expect(profile.defaultTemperature).toBe(0.2);
    expect(profile.extraSystemMessages).toEqual([]);
  });

  it("falls back to the default profile for unknown models", () => {
    const adapter = getModelAdapter("unknown-model");
    const profile = adapter.getProfile({ toolsEnabled: true });

    expect(profile.defaultTemperature).toBe(0.7);
    expect(profile.extraSystemMessages).toEqual([
      "You are an expert AI programming assistant. Provide correct, concise, production-ready code. Prefer simple solutions. Analyze the problem before coding. When tools are available, answer with concise user-facing text or a valid tool call. Do not include disclaimers or apologies.",
    ]);
  });

  it("does not add extra system guidance when tools are disabled for unknown models", () => {
    const adapter = getModelAdapter("unknown-model");
    const profile = adapter.getProfile({ toolsEnabled: false });

    expect(profile.defaultTemperature).toBe(0.7);
    expect(profile.extraSystemMessages).toEqual([]);
  });
});

describe("applyReasoningMode", () => {
  it("sets chat_template_kwargs.thinking_mode to disabled for MiniMax none", () => {
    const adapter = getModelAdapter("minimaxai/minimax-m3");
    const request: NimChatRequest = {
      model: "minimaxai/minimax-m3",
      messages: [],
    };
    adapter.applyReasoningMode!(request, "none");
    expect(request.chat_template_kwargs).toEqual({ thinking_mode: "disabled" });
  });

  it("sets chat_template_kwargs.thinking_mode to enabled for MiniMax on", () => {
    const adapter = getModelAdapter("minimaxai/minimax-m3");
    const request: NimChatRequest = {
      model: "minimaxai/minimax-m3",
      messages: [],
    };
    adapter.applyReasoningMode!(request, "on");
    expect(request.chat_template_kwargs).toEqual({ thinking_mode: "enabled" });
  });

  it("sets chat_template_kwargs.thinking_mode to adaptive for MiniMax adaptive", () => {
    const adapter = getModelAdapter("minimaxai/minimax-m3");
    const request: NimChatRequest = {
      model: "minimaxai/minimax-m3",
      messages: [],
    };
    adapter.applyReasoningMode!(request, "adaptive");
    expect(request.chat_template_kwargs).toEqual({ thinking_mode: "adaptive" });
  });

  it("exposes adaptive in MiniMax supportedReasoningModes", () => {
    const adapter = getModelAdapter("minimaxai/minimax-m3");
    expect(adapter.supportedReasoningModes).toEqual(["none", "on", "adaptive"]);
  });

  it("exposes Kimi reasoning effort modes and sends the selected mode", () => {
    const adapter = getModelAdapter("moonshotai/kimi-k3");
    const request: NimChatRequest = {
      model: "moonshotai/kimi-k3",
      messages: [],
    };

    expect(adapter.supportedReasoningModes).toEqual(["none", "low", "high", "max"]);

    adapter.applyReasoningMode!(request, "high");
    expect(request.reasoning_effort).toBe("high");

    adapter.applyReasoningMode!(request, "none");
    expect(request.reasoning_effort).toBe("none");
  });

  it("sets chat_template_kwargs.enable_thinking to false for GLM none", () => {
    const adapter = getModelAdapter("z-ai/glm-5.2");
    const request: NimChatRequest = {
      model: "z-ai/glm-5.2",
      messages: [],
    };
    adapter.applyReasoningMode!(request, "none");
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("sets chat_template_kwargs.enable_thinking and clear_thinking for GLM on", () => {
    const adapter = getModelAdapter("z-ai/glm-5.2");
    const request: NimChatRequest = {
      model: "z-ai/glm-5.2",
      messages: [],
    };
    adapter.applyReasoningMode!(request, "on");
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: true, clear_thinking: false });
  });

  it("exposes Inkling reasoning effort modes and sends the selected mode", () => {
    const adapter = getModelAdapter("thinkingmachines/inkling");
    const request: NimChatRequest = {
      model: "thinkingmachines/inkling",
      messages: [],
    };

    expect(adapter.supportedReasoningModes).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    adapter.applyReasoningMode!(request, "high");
    expect(request.reasoning_effort).toBe("high");

    adapter.applyReasoningMode!(request, "none");
    expect(request.reasoning_effort).toBe("none");
  });

  it("exposes Muse Glimmer reasoning effort modes and sends the selected mode", () => {
    const adapter = getModelAdapter("meta/muse-glimmer-30b");
    const request: NimChatRequest = {
      model: "meta/muse-glimmer-30b",
      messages: [],
    };

    expect(adapter.supportedReasoningModes).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(adapter.getProfile({ toolsEnabled: true }).defaultTemperature).toBe(1);

    adapter.applyReasoningMode!(request, "high");
    expect(request.reasoning_effort).toBe("high");

    adapter.applyReasoningMode!(request, "none");
    expect(request.reasoning_effort).toBe("none");
  });

  it("maps Lightning reasoning modes to OpenRouter-style reasoning_budget percentages", () => {
    const adapter = getModelAdapter("nvidia/nemotron-3.5-lightning-30b-a3b");
    const request: NimChatRequest = {
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      messages: [],
    };

    expect(adapter.supportedReasoningModes).toEqual(["none", "medium", "high", "xhigh"]);
    expect(adapter.getProfile({ toolsEnabled: true }).defaultTemperature).toBe(1);
    expect(adapter.getProfile({ toolsEnabled: true }).toolTemperature).toBe(1);

    adapter.applyReasoningMode!(request, "medium");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 16384,
    });
    expect(request.reasoning_effort).toBeUndefined();

    adapter.applyReasoningMode!(request, "high");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 26214,
    });

    adapter.applyReasoningMode!(request, "xhigh");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 31130,
    });

    adapter.applyReasoningMode!(request, "none");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: false,
      reasoning_budget: 0,
    });
  });

  it("scales Lightning reasoning_budget from the request max_tokens cap", () => {
    const adapter = getModelAdapter("nvidia/nemotron-3.5-lightning-30b-a3b");
    const request: NimChatRequest = {
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      messages: [],
      max_tokens: 8000,
    };

    adapter.applyReasoningMode!(request, "medium");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 4000,
    });

    adapter.applyReasoningMode!(request, "high");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 6400,
    });

    adapter.applyReasoningMode!(request, "xhigh");
    expect(request.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 7600,
    });
  });
});
