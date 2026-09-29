import * as vscode from "vscode";
import { chatCompletion } from "../src/api/client";
import { MODEL_LIST, NormalizedNvidiaModel } from "../src/models/catalog";
import {
  buildContextSizeProperty,
  formatContextSizeLabel,
  NvidiaModelDiscoveryService,
} from "../src/models/discovery";
import { NimRequestBuilder, resolveContextSizeLimit } from "../src/provider/request-builder";
import { ConfigManager } from "../src/shared/config";
import { makeChatMessages, makeChatOptions, makeModel, makeSecrets } from "./helpers/fakes";

jest.mock("../src/api/client", () => ({
  chatCompletion: jest.fn(),
}));

function normalized(id: string): NormalizedNvidiaModel {
  const entry = MODEL_LIST[id];
  return {
    id,
    displayName: entry.displayName,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    supportsTools: entry.supportsTools,
    supportsVision: entry.supportsVision,
  };
}

function mapModel(id: string) {
  const discovery = new NvidiaModelDiscoveryService(makeSecrets(), "test-ua");
  return discovery.mapToChatInformation([normalized(id)])[0];
}

describe("Context Size picker option", () => {
  it("offers smaller tiers plus the full input budget on a 1M model, defaulting to full", () => {
    const info = mapModel("moonshotai/kimi-k3");
    const property = info.configurationSchema?.properties.contextSize;

    expect(property).toMatchObject({
      type: "number",
      title: "Context Size",
      group: "tokens",
      enum: [128_000, 256_000, 512_000, info.maxInputTokens],
      enumItemLabels: ["128K", "256K", "512K", "1M"],
      default: info.maxInputTokens,
    });
    expect(property?.enumDescriptions).toHaveLength(4);
    // The reasoning option is kept next to the new one.
    expect(info.configurationSchema?.properties.reasoningMode).toBeDefined();
  });

  it("omits the option when no tier is smaller than the model's input budget", () => {
    const info = mapModel("meta/muse-glimmer-30b");

    expect(info.maxInputTokens).toBeLessThan(128_000);
    expect(info.configurationSchema?.properties.contextSize).toBeUndefined();
  });

  it("builds only tiers below the input budget", () => {
    expect(buildContextSizeProperty(300_000)?.enum).toEqual([128_000, 256_000, 300_000]);
    expect(buildContextSizeProperty(128_000)).toBeUndefined();
  });

  it("formats labels like Copilot's own context size option", () => {
    expect(formatContextSizeLabel(128_000)).toBe("128K");
    expect(formatContextSizeLabel(907_018)).toBe("1M");
    expect(formatContextSizeLabel(1_048_576)).toBe("1M");
    expect(formatContextSizeLabel(2_500_000)).toBe("2.5M");
  });
});

describe("resolveContextSizeLimit", () => {
  it("reads a positive numeric context size from the model configuration", () => {
    expect(
      resolveContextSizeLimit(makeChatOptions({ modelConfiguration: { contextSize: 256_000 } })),
    ).toBe(256_000);
  });

  it("ignores missing, non-numeric, and non-positive values", () => {
    expect(resolveContextSizeLimit(makeChatOptions())).toBeUndefined();
    for (const contextSize of ["big", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveContextSizeLimit(makeChatOptions({ modelConfiguration: { contextSize } })),
      ).toBeUndefined();
    }
  });
});

describe("NimRequestBuilder with a picked context size", () => {
  const messages = makeChatMessages(
    ...Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? 1 : 2,
      content: [new vscode.LanguageModelTextPart(`${index}: ${"x".repeat(1000)}`)],
    })),
  );
  const model = makeModel({
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    maxInputTokens: 200_000,
    maxOutputTokens: 1000,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function prepare(contextSize?: number) {
    return NimRequestBuilder.prepareRequest({
      model,
      messages,
      options: makeChatOptions(
        contextSize === undefined ? {} : { modelConfiguration: { contextSize } },
      ),
      contextWindow: 300_000,
      supportsTools: false,
      supportsVision: false,
      apiKey: "test-key",
      userAgent: "test-agent",
      config: ConfigManager.getNimConfig(),
    });
  }

  it("sends the history untouched when no size is picked", async () => {
    const prepared = await prepare();

    expect(chatCompletion).not.toHaveBeenCalled();
    expect(prepared.requestBody.messages).toHaveLength(10);
  });

  it("compacts history to fit a picked size below the model's input budget", async () => {
    (chatCompletion as jest.Mock).mockResolvedValueOnce("Short historical summary");

    const prepared = await prepare(3000);

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(prepared.inputTokenCount).toBeLessThanOrEqual(3000);
  });

  it("does not raise the input budget above the model's own limit", async () => {
    const prepared = await prepare(10_000_000);

    expect(chatCompletion).not.toHaveBeenCalled();
    expect(prepared.requestBody.messages).toHaveLength(10);
  });
});
