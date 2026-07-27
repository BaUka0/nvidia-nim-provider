import * as vscode from "vscode";
import { fetchWithRetry } from "../api/client";
import { classifyApiError } from "../api/errors";
import {
  BASE_URL,
  EXTENSION_VERSION,
  MODELS_CACHE_KEY_FINGERPRINT_STATE_KEY,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
} from "../shared/constants";
import { ELITE_MODELS_WHITELIST, isNormalizedNvidiaModel } from "../models/catalog";
import { NvidiaApiKeyResolver } from "../api/key-resolver";

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
    const visionModel = Array.isArray(cachedModels)
      ? cachedModels.find(
          (model) =>
            isNormalizedNvidiaModel(model) &&
            Object.prototype.hasOwnProperty.call(ELITE_MODELS_WHITELIST, model.id) &&
            ELITE_MODELS_WHITELIST[model.id].supportsVision &&
            model.supportsVision,
        )
      : undefined;

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
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(`${PROVIDER_DISPLAY_NAME} API key not found`);
    }
    const model = this.getVisionModelId();
    const ua = `nvidia-nim-provider/${EXTENSION_VERSION} VSCode/${vscode.version}`;

    const response = await fetchWithRetry(
      `${BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": ua,
        },
        body: JSON.stringify({
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
        }),
        signal,
      },
      3,
      { operation: "vision", model },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw classifyApiError(new Error(`HTTP ${response.status} ${response.statusText}`), {
        operation: "vision",
        status: response.status,
        detail: errorText,
      });
    }

    try {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return data.choices?.[0]?.message?.content ?? "Failed to analyze image";
    } catch (error) {
      throw classifyApiError(error, { operation: "vision", model });
    }
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
    const { image_data, prompt } = options.input;
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
  const CancellationError = (vscode as typeof vscode & { CancellationError?: new () => Error })
    .CancellationError;
  return CancellationError ? new CancellationError() : createAbortError();
}
