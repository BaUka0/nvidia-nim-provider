import * as vscode from "vscode";
import { BASE_URL, PROVIDER_DISPLAY_NAME, SECRET_STORAGE_KEY } from "./constants";

/**
 * Temporary image-analysis fallback retained until the dedicated NVIDIA image path is implemented.
 */
export class OcGoMcpClient {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private async getApiKey(): Promise<string> {
    return (await this.secrets.get(SECRET_STORAGE_KEY)) ?? "";
  }

  async analyzeImage(imageData: string, prompt: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(`${PROVIDER_DISPLAY_NAME} API key not found`);
    }

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "mimo-v2-omni",
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
