import * as vscode from "vscode";

/**
 * Register provider tools with the Language Model API.
 * The NVIDIA scaffold does not ship MCP-backed tools yet, so this is a no-op.
 */
export function registerOcGoTools(_secrets: vscode.SecretStorage): vscode.Disposable {
  return vscode.Disposable.from();
}
