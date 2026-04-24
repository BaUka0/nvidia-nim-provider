import * as vscode from "vscode";

export class OcGoAnalyzeImageTool implements vscode.LanguageModelTool<{
  image_data: string;
  prompt: string;
}> {
  static readonly id = "nvidia_nim_analyze_image";

  readonly name = OcGoAnalyzeImageTool.id;
  readonly description =
    "Direct image-analysis fallback is unavailable. Choose a vision-capable NVIDIA NIM model instead.";
  readonly tags = ["vision", "image"];

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      image_data: {
        type: "string",
        description: "Deprecated image data input.",
      },
      prompt: {
        type: "string",
        description: "Deprecated prompt input.",
      },
    },
    required: ["image_data", "prompt"],
  };

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        "Direct image-analysis fallback is unavailable. Choose a vision-capable NVIDIA NIM model instead.",
      ),
    ]);
  }

  prepareInvocation?(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Checking NVIDIA NIM vision support..." };
  }
}

export function registerOcGoTools(_secrets: vscode.SecretStorage): vscode.Disposable {
  return vscode.Disposable.from();
}
