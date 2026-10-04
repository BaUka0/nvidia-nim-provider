import * as vscode from "vscode";
import { chatCompletion } from "../src/api/client";
import { ReasoningStreamRouter } from "../src/messages/reasoning-router";
import {
  getModelAdapter,
  resolveDefaultReasoningMode,
  withReasoningOff,
} from "../src/models/adapters";
import { MODEL_LIST, NormalizedNvidiaModel } from "../src/models/catalog";
import { NvidiaModelDiscoveryService } from "../src/models/discovery";
import { summarizeOldMessages } from "../src/models/summarizer";
import { NimRequestBuilder } from "../src/provider/request-builder";
import { ConfigManager } from "../src/shared/config";
import { makeChatMessages, makeChatOptions, makeModel, makeSecrets } from "./helpers/fakes";

jest.mock("../src/api/client", () => ({
  chatCompletion: jest.fn(),
}));

const LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b";
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
const DEFAULTS = { mode: "high", explicit: false };

/** Point `nvidia-nim.reasoning.mode` at a user value, or back to the default. */
function setReasoningSetting(mode?: string): void {
  (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
    get: (key: string, defaultValue?: unknown) =>
      key === "reasoning.mode" && mode !== undefined ? mode : defaultValue,
    inspect: (key: string) =>
      key === "reasoning.mode" && mode !== undefined ? { key, globalValue: mode } : undefined,
  }));
}

function pickerDefault(id: string): unknown {
  const entry = MODEL_LIST[id];
  const model: NormalizedNvidiaModel = {
    id,
    displayName: entry.displayName,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    supportsTools: entry.supportsTools,
    supportsVision: entry.supportsVision,
  };
  const discovery = new NvidiaModelDiscoveryService(makeSecrets(), "test-ua");
  return discovery.mapToChatInformation([model])[0].configurationSchema?.properties.reasoningEffort
    ?.default;
}

afterEach(() => {
  setReasoningSetting(undefined);
  jest.clearAllMocks();
});

describe("default reasoning mode", () => {
  it("uses high for every curated model except Lightning, which uses medium", () => {
    for (const id of Object.keys(MODEL_LIST)) {
      const expected = id === LIGHTNING ? "medium" : "high";
      expect([id, resolveDefaultReasoningMode(getModelAdapter(id), DEFAULTS)]).toEqual([
        id,
        expected,
      ]);
    }
  });

  it("applies an explicit setting to Lightning too, mapped onto its modes", () => {
    const adapter = getModelAdapter(LIGHTNING);

    expect(resolveDefaultReasoningMode(adapter, { mode: "none", explicit: true })).toBe("none");
    expect(resolveDefaultReasoningMode(adapter, { mode: "max", explicit: true })).toBe("xhigh");
  });

  it("maps an explicit none onto the lowest effort for models that always think", () => {
    expect(
      resolveDefaultReasoningMode(getModelAdapter("moonshotai/kimi-k3"), {
        mode: "none",
        explicit: true,
      }),
    ).toBe("low");
  });

  it("makes the model picker default follow the setting", () => {
    expect(pickerDefault("moonshotai/kimi-k3")).toBe("high");
    expect(pickerDefault(LIGHTNING)).toBe("medium");

    setReasoningSetting("none");

    expect(pickerDefault(ULTRA)).toBe("none");
    expect(pickerDefault("moonshotai/kimi-k3")).toBe("low");
    expect(pickerDefault(LIGHTNING)).toBe("none");
  });

  it("uses the model default for a request without a picker choice", async () => {
    const prepared = await NimRequestBuilder.prepareRequest({
      model: makeModel({
        id: LIGHTNING,
        name: "Lightning",
        maxInputTokens: 100_000,
        maxOutputTokens: 32768,
      }),
      messages: makeChatMessages({ role: 1, content: [new vscode.LanguageModelTextPart("hi")] }),
      options: makeChatOptions(),
      contextWindow: 200_000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_budget: 16384,
    });
  });

  it("lets a picker choice override the default", async () => {
    const prepared = await NimRequestBuilder.prepareRequest({
      model: makeModel({
        id: ULTRA,
        name: "Ultra",
        maxInputTokens: 100_000,
        maxOutputTokens: 32768,
      }),
      messages: makeChatMessages({ role: 1, content: [new vscode.LanguageModelTextPart("hi")] }),
      options: makeChatOptions({ modelConfiguration: { reasoningMode: "none" } }),
      contextWindow: 200_000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });

    expect(prepared.requestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  describe("picker key", () => {
    const prepareWith = (modelConfiguration: Record<string, string>) =>
      NimRequestBuilder.prepareRequest({
        model: makeModel({
          id: ULTRA,
          name: "Ultra",
          maxInputTokens: 100_000,
          maxOutputTokens: 32768,
        }),
        messages: makeChatMessages({ role: 1, content: [new vscode.LanguageModelTextPart("hi")] }),
        options: makeChatOptions({ modelConfiguration }),
        contextWindow: 200_000,
        supportsTools: false,
        supportsVision: false,
        apiKey: "test-key",
        userAgent: "test-agent",
        config: ConfigManager.getNimConfig(),
      });

    it("exposes the choice as reasoningEffort so the agent host offers it", () => {
      const discovery = new NvidiaModelDiscoveryService(makeSecrets(), "test-ua");
      const model: NormalizedNvidiaModel = { id: ULTRA, ...MODEL_LIST[ULTRA] };
      const properties = discovery.mapToChatInformation([model])[0].configurationSchema?.properties;

      expect(properties).not.toHaveProperty("reasoningMode");
      expect(properties?.reasoningEffort).toMatchObject({
        enum: ["none", "medium", "high"],
        default: "high",
        group: "navigation",
      });
    });

    it("applies reasoningEffort sent by the picker or the agent host", async () => {
      const prepared = await prepareWith({ reasoningEffort: "none" });
      expect(prepared.requestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it("still honors a saved reasoningMode from before the rename", async () => {
      const prepared = await prepareWith({ reasoningMode: "none" });
      expect(prepared.requestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it("prefers reasoningEffort when both keys are present", async () => {
      const prepared = await prepareWith({ reasoningEffort: "medium", reasoningMode: "none" });
      expect(prepared.requestBody.chat_template_kwargs).toEqual({
        enable_thinking: true,
        medium_effort: true,
      });
    });
  });
});

describe("internal single-shot calls", () => {
  it("turns reasoning off, or to the lowest effort when the model always thinks", () => {
    expect(withReasoningOff({ model: ULTRA, messages: [] }).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
    expect(withReasoningOff({ model: "moonshotai/kimi-k3", messages: [] }).reasoning_effort).toBe(
      "low",
    );
    expect(withReasoningOff({ model: "unknown/model", messages: [] })).toEqual({
      model: "unknown/model",
      messages: [],
    });
  });

  it("sends the summarization request with reasoning off", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("summary");

    await summarizeOldMessages([{ role: "user", content: "old turn" }], "key", "ua");

    const body = (chatCompletion as jest.Mock).mock.calls[0][1];
    expect(body.model).toBe(LIGHTNING);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, reasoning_budget: 0 });
  });
});

describe("ReasoningStreamRouter pending text", () => {
  it("reports content held while it waits for reasoning", () => {
    const text: string[] = [];
    const router = new ReasoningStreamRouter({
      reasoningIsolationExpected: true,
      onThinking: () => undefined,
      onText: (value) => text.push(value),
    });

    router.handleContent("Working on it");

    expect(router.hasPendingText()).toBe(true);
    expect(text).toEqual([]);
    router.flush();
    expect(router.hasPendingText()).toBe(false);
    expect(text.join("")).toBe("Working on it");
  });
});
