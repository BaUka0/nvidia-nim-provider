import * as vscode from "vscode";
import { MODEL_LIST } from "../src/models/catalog";
import { NvidiaModelDiscoveryService } from "../src/models/discovery";
import { getThinkingPartValue } from "../src/messages/parts";
import { NimRequestBuilder } from "../src/provider/request-builder";
import { ConfigManager } from "../src/shared/config";
import { makeChatMessages, makeChatOptions, makeModel, makeSecrets } from "./helpers/fakes";

const lookupTool = {
  name: "lookup_city",
  description: "Look up a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

async function prepare(
  modelId: string,
  options: { tools?: boolean; temperature?: number; topP?: number } = {},
) {
  return NimRequestBuilder.prepareRequest({
    model: makeModel({
      id: modelId,
      name: modelId,
      maxInputTokens: 100_000,
      maxOutputTokens: MODEL_LIST[modelId]?.maxOutputTokens ?? 4096,
    }),
    messages: makeChatMessages({
      role: 1,
      content: [new vscode.LanguageModelTextPart("hello")],
    }),
    options: makeChatOptions({
      ...(options.tools ? { tools: [lookupTool] } : {}),
      modelOptions: {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      },
    }),
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: false,
    apiKey: "test-key",
    userAgent: "test-agent",
    config: ConfigManager.getNimConfig(),
  });
}

describe("NVIDIA model card compliance", () => {
  it("caps Nemotron 3 Ultra and 3.5 Lightning output at the documented 32768 max_tokens", () => {
    expect(MODEL_LIST["nvidia/nemotron-3-ultra-550b-a55b"].maxOutputTokens).toBe(32768);
    expect(MODEL_LIST["nvidia/nemotron-3.5-lightning-30b-a3b"].maxOutputTokens).toBe(32768);
  });

  it("uses NVIDIA's default 262144 max_tokens for DeepSeek V4.1 Flash", async () => {
    const id = "deepseek-ai/deepseek-v4.1-flash";
    expect(MODEL_LIST[id].maxOutputTokens).toBe(262144);

    const discovery = new NvidiaModelDiscoveryService(makeSecrets(), "test-ua");
    const [info] = discovery.mapToChatInformation([{ id, ...MODEL_LIST[id] }]);
    // Input budget = window - output reservation - safety margin (1%).
    expect(info.maxInputTokens).toBe(1_048_576 - 262_144 - 10_486);
    expect(info.maxContextWindowTokens).toBe(1_048_576);

    const prepared = await NimRequestBuilder.prepareRequest({
      model: makeModel({
        id,
        name: "DeepSeek V4.1 Flash",
        maxInputTokens: info.maxInputTokens,
        maxOutputTokens: info.maxOutputTokens,
      }),
      messages: makeChatMessages({ role: 1, content: [new vscode.LanguageModelTextPart("hi")] }),
      options: makeChatOptions(),
      contextWindow: 1_048_576,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });
    expect(prepared.requestBody.max_tokens).toBe(262144);
  });

  it("never sends top_p to Kimi K3, even when a caller sets it", async () => {
    const prepared = await prepare("moonshotai/kimi-k3", { topP: 0.5 });

    expect(prepared.requestBody).not.toHaveProperty("top_p");
    expect(prepared.requestBody.reasoning_effort).toBe("high");
  });

  it("still sends top_p to models that accept it", async () => {
    const prepared = await prepare("z-ai/glm-5.3");

    expect(prepared.requestBody.top_p).toBe(0.95);
  });

  it("clamps temperature to the documented maximum of 1", async () => {
    const prepared = await prepare("z-ai/glm-5.3", { temperature: 1.7 });

    expect(prepared.requestBody.temperature).toBe(1);
  });

  // On hosted NIM streaming, force_nonempty_content stops the endpoint from
  // splitting reasoning out: the trace and a literal </think> land in content
  // and show up in the chat. Never send it, with or without tools.
  it.each(["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b"])(
    "%s never sends force_nonempty_content",
    async (modelId) => {
      const withTools = await prepare(modelId, { tools: true });
      const withoutTools = await prepare(modelId);

      expect(withTools.requestBody.chat_template_kwargs).not.toHaveProperty(
        "force_nonempty_content",
      );
      expect(withoutTools.requestBody.chat_template_kwargs).not.toHaveProperty(
        "force_nonempty_content",
      );
    },
  );

  it("keeps the calibrated 0.6 tool temperature on Nemotron", async () => {
    const prepared = await prepare("nvidia/nemotron-3-ultra-550b-a55b", { tools: true });

    expect(prepared.requestBody.temperature).toBe(0.6);
    expect(prepared.requestBody).not.toHaveProperty("reasoning_effort");
  });

  it("reads thinking parts whose value is an array of strings", () => {
    expect(getThinkingPartValue({ type: "thinking", value: ["first ", "second"] })).toBe(
      "first second",
    );
    expect(getThinkingPartValue({ type: "thinking", value: ["ok", 1] })).toBeUndefined();
  });
});
