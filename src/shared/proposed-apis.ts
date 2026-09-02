import * as vscode from "vscode";
import { LanguageModelResponsePart, Progress } from "vscode";

/**
 * Accessors for VS Code proposed APIs that are not yet on the stable
 * `vscode` typings. Keep every `vscode as unknown as` cast here so call sites
 * stay typed.
 */

export type LanguageModelThinkingPartConstructor = new (value: string) => LanguageModelResponsePart;

interface ProposedVscodeApis {
  LanguageModelThinkingPart?: LanguageModelThinkingPartConstructor;
  LanguageModelChatToolMode?: { Required?: number };
}

function proposedVscode(): ProposedVscodeApis {
  return vscode as unknown as ProposedVscodeApis;
}

export function getLanguageModelThinkingPartConstructor():
  | LanguageModelThinkingPartConstructor
  | undefined {
  return proposedVscode().LanguageModelThinkingPart;
}

export function getLanguageModelChatToolModeRequired(): number | undefined {
  const stable = (vscode as { LanguageModelChatToolMode?: { Required?: number } })
    .LanguageModelChatToolMode?.Required;
  if (typeof stable === "number") {
    return stable;
  }
  return proposedVscode().LanguageModelChatToolMode?.Required;
}

/**
 * Report a reasoning fragment as a thinking part when the runtime supports it,
 * otherwise fall back to plain text when the turn's `showInChat` snapshot is
 * enabled. Callers pass the per-turn value so mid-turn settings edits cannot
 * flip the rendering of an in-flight stream.
 */
export function emitThinkingPart(
  progress: Progress<LanguageModelResponsePart>,
  text: string,
  showReasoning: boolean,
): { didReport: boolean; emittedVisible: boolean } {
  const ThinkingPart = getLanguageModelThinkingPartConstructor();
  if (ThinkingPart) {
    progress.report(new ThinkingPart(text));
    return { didReport: true, emittedVisible: false };
  }
  if (showReasoning) {
    progress.report(new vscode.LanguageModelTextPart(text.startsWith(" ") ? text : ` ${text}`));
    return { didReport: true, emittedVisible: true };
  }
  return { didReport: false, emittedVisible: false };
}
