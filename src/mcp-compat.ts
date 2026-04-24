import * as vscode from "vscode";
import { BASE_URL } from "./constants";

/**
 * Temporary compatibility shim for the copied OpenCode Go image-analysis fallback.
 * Task 1 removes src/mcp.ts, but the scaffold still needs the copied runtime behavior.
 * TODO(Task 2): Remove this file after NVIDIA-specific secret names and image handling land.
 */
export const LEGACY_OPENCODE_GO_API_KEY_SECRET = "opencode-go.apiKey";

export class OcGoMcpClient {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private async getApiKey(): Promise<string> {
    return (await this.secrets.get(LEGACY_OPENCODE_GO_API_KEY_SECRET)) ?? "";
  }

  async analyzeImage(imageData: string, prompt: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error("OpenCode Go API key not found");
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
