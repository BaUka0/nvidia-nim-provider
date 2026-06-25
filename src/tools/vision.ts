import * as vscode from "vscode";
import { fetchWithRetry } from "../api/client";
import {
  BASE_URL,
  EXTENSION_VERSION,
  MODELS_STATE_KEY,
  PROVIDER_DISPLAY_NAME,
  SECRET_STORAGE_KEY,
} from "../shared/constants";
import { isNormalizedNvidiaModel } from "../models/catalog";

/**
 * Image-analysis client that uses a cached NVIDIA NIM vision-capable model.
 */
export class NimVisionClient {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly modelStorage?: vscode.Memento,
  ) {}

  private async getApiKey(): Promise<string> {
    return (await this.secrets.get(SECRET_STORAGE_KEY)) ?? "";
  }

  private getVisionModelId(): string {
    const cachedModels = this.modelStorage?.get<unknown>(MODELS_STATE_KEY);
    const visionModel = Array.isArray(cachedModels)
      ? cachedModels.find((model) => isNormalizedNvidiaModel(model) && model.supportsVision)
      : undefined;

    if (!visionModel || !isNormalizedNvidiaModel(visionModel)) {
      throw new Error(
        `No NVIDIA NIM vision model is available. Run "${PROVIDER_DISPLAY_NAME}: Refresh Models" after setting your API key.`,
      );
    }

    return visionModel.id;
  }

  async analyzeImage(imageData: string, prompt: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(`${PROVIDER_DISPLAY_NAME} API key not found`);
    }
    const model = this.getVisionModelId();
    const ua = `nvidia-nim-provider/${EXTENSION_VERSION} VSCode/${vscode.version}`;

    const response = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
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
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "Failed to analyze image";
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

  constructor(secrets: vscode.SecretStorage, modelStorage?: vscode.Memento) {
    this.visionClient = new NimVisionClient(secrets, modelStorage);
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ image_data: string; prompt: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { image_data, prompt } = options.input;
    try {
      const result = await this.visionClient.analyzeImage(image_data, prompt);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to analyze image: ${errorMessage}`),
      ]);
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
): vscode.Disposable {
  const analyzeImageTool = new NimAnalyzeImageTool(secrets, modelStorage);
  return vscode.Disposable.from(vscode.lm.registerTool(NimAnalyzeImageTool.id, analyzeImageTool));
}
