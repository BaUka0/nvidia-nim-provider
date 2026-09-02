import * as vscode from "vscode";
import { chatCompletion } from "../api/client";
import {
  EXTENSION_VERSION,
  MAX_CHAT_IMAGE_BYTES,
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
} from "../shared/constants";
import { MODEL_LIST, isNormalizedNvidiaModel, NormalizedNvidiaModel } from "../models/catalog";
import { NvidiaApiKeyResolver } from "../api/key-resolver";
import { ConfigManager } from "../shared/config";
import { httpAttemptsFromConfig } from "../shared/fetch-attempt-budget";

/**
 * Validate that image_data is a base64 image data URL and return its decoded
 * size. Arbitrary remote URLs are rejected so the NIM vision endpoint never
 * fetches external resources on the user's behalf.
 */
function measureImageDataUrl(imageData: string): number | undefined {
  if (!imageData.startsWith("data:image/")) {
    return undefined;
  }
  const comma = imageData.indexOf(",");
  if (comma === -1) {
    return undefined;
  }
  const prefix = imageData.slice(5, comma);
  const payload = imageData.slice(comma + 1);
  if (!payload) {
    return undefined;
  }
  const headerFields = prefix.split(";");
  if (!headerFields.includes("base64")) {
    return undefined;
  }
  return Math.ceil((payload.length * 3) / 4);
}

/**
 * Image-analysis client that uses a cached NVIDIA NIM vision-capable model.
 */
export class NimVisionClient {
  constructor(
    secrets: vscode.SecretStorage,
    private readonly modelStorage?: vscode.Memento,
    private readonly keyResolver = new NvidiaApiKeyResolver(secrets),
  ) {}

  private async getApiKey(): Promise<string> {
    const storedFingerprint = this.modelStorage?.get<unknown>(
      MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
    );
    const cacheKeyFingerprint =
      typeof storedFingerprint === "string" ? storedFingerprint : undefined;
    const resolved = await this.keyResolver.resolveForTool({ cacheKeyFingerprint });
    return resolved?.value ?? "";
  }

  private getVisionModelId(): string {
    const cachedModels = this.modelStorage?.get<unknown>(MODELS_STATE_KEY);
    const visionModels = Array.isArray(cachedModels)
      ? cachedModels.filter(
          (model): model is NormalizedNvidiaModel =>
            isNormalizedNvidiaModel(model) &&
            Object.prototype.hasOwnProperty.call(MODEL_LIST, model.id) &&
            MODEL_LIST[model.id].supportsVision &&
            model.supportsVision,
        )
      : [];
    const preferredId = ConfigManager.getFallbackConfig().visionModel;
    const visionModel = visionModels.find((model) => model.id === preferredId) ?? visionModels[0];

    if (!visionModel || !isNormalizedNvidiaModel(visionModel)) {
      throw new Error(
        `No NVIDIA NIM vision model is available. Run "${PROVIDER_DISPLAY_NAME}: Refresh Models" after setting your API key.`,
      );
    }

    return visionModel.id;
  }

  async analyzeImage(imageData: string, prompt: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const imageByteLength = measureImageDataUrl(imageData);
    if (imageByteLength === undefined) {
      throw new Error(
        `${PROVIDER_DISPLAY_NAME} image analysis requires a base64 image data URL ('data:image/...;base64,...').`,
      );
    }
    if (imageByteLength > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(
        `${PROVIDER_DISPLAY_NAME} image is too large (${Math.ceil(imageByteLength / (1024 * 1024))} MB). Maximum size is ${MAX_CHAT_IMAGE_BYTES / (1024 * 1024)} MB.`,
      );
    }
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(`${PROVIDER_DISPLAY_NAME} API key not found`);
    }
    const model = this.getVisionModelId();
    const ua = `nvidia-nim-provider/${EXTENSION_VERSION} VSCode/${vscode.version}`;
    const content = await chatCompletion(
      apiKey,
      {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageData } },
            ],
          },
        ],
        max_tokens: 2000,
      },
      signal,
      ua,
      httpAttemptsFromConfig(ConfigManager.getNetworkConfig().maxHttpRetries),
      "vision",
    );
    return content || "Failed to analyze image";
  }
}

/**
 * Tool for analyzing images using a cached NVIDIA NIM vision-capable model.
 * Non-vision models can delegate image content to this tool for analysis.
 */
export class NimAnalyzeImageTool implements vscode.LanguageModelTool<{
  image_data: string;
  prompt: string;
}> {
  static readonly id = "nvidia_nim_analyze_image";

  readonly name = NimAnalyzeImageTool.id;
  readonly description =
    `Analyze an image using ${PROVIDER_DISPLAY_NAME} Vision. Use this tool when you need to ` +
    "understand or describe the content of an image, extract text from images (OCR), " +
    "or answer questions about visual content. Returns a detailed analysis of the image.";
  readonly tags = ["vision", "image", "ocr", "analysis"];

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      image_data: {
        type: "string",
        description:
          "Base64-encoded image data URL (e.g., 'data:image/png;base64,...'). The image to analyze.",
      },
      prompt: {
        type: "string",
        description:
          "The question or instruction about what to analyze in the image. Be specific about what you want to know.",
      },
    },
    required: ["image_data", "prompt"],
  };

  private readonly visionClient: NimVisionClient;

  constructor(
    secrets: vscode.SecretStorage,
    modelStorage?: vscode.Memento,
    keyResolver?: NvidiaApiKeyResolver,
  ) {
    this.visionClient = new NimVisionClient(secrets, modelStorage, keyResolver);
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ image_data: string; prompt: string }>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { image_data, prompt: rawPrompt } = options.input;
    const prompt = rawPrompt.length > 4000 ? rawPrompt.slice(0, 4000) : rawPrompt;
    const abortController = new AbortController();
    const cancellationSubscription =
      typeof token.onCancellationRequested === "function"
        ? token.onCancellationRequested(() => abortController.abort())
        : undefined;
    try {
      if (token.isCancellationRequested) {
        throw createAbortError();
      }
      const result = await this.visionClient.analyzeImage(
        image_data,
        prompt,
        abortController.signal,
      );
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    } catch (error) {
      if (
        token.isCancellationRequested ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw createVisionCancellationError();
      }
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to analyze image: ${errorMessage}`),
      ]);
    } finally {
      cancellationSubscription?.dispose();
    }
  }

  prepareInvocation?(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<{
      image_data: string;
      prompt: string;
    }>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: `Analyzing image with ${PROVIDER_DISPLAY_NAME} Vision...` };
  }
}

/**
 * Register all NVIDIA NIM tools with the Language Model API.
 * @param secrets VS Code secret storage for API key access
 * @returns Disposable for the tool registrations
 */
export function registerNimTools(
  secrets: vscode.SecretStorage,
  modelStorage?: vscode.Memento,
  keyResolver?: NvidiaApiKeyResolver,
): vscode.Disposable {
  const analyzeImageTool = new NimAnalyzeImageTool(secrets, modelStorage, keyResolver);
  return vscode.Disposable.from(vscode.lm.registerTool(NimAnalyzeImageTool.id, analyzeImageTool));
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function createVisionCancellationError(): Error {
  return typeof vscode.CancellationError === "function"
    ? new vscode.CancellationError()
    : createAbortError();
}
