import { LanguageModelChatRequestOptions } from "vscode";
import { debugLog } from "../shared/logging";
import { CONTEXT_WINDOW_SAFETY_MARGIN, DEFAULT_MAX_OUTPUT_TOKENS } from "../shared/constants";

export class TokenCounter {
  static calculateRequestedMaxTokens(
    options: LanguageModelChatRequestOptions,
    contextWindow: number,
    estimatedInputTokens: number,
  ): number {
    const defaultMaxTokens = DEFAULT_MAX_OUTPUT_TOKENS;
    const requestedMaxTokens = options.modelOptions?.max_tokens;
    let computedMaxTokens = defaultMaxTokens;

    if (
      typeof requestedMaxTokens === "number" &&
      !isNaN(requestedMaxTokens) &&
      requestedMaxTokens > 0
    ) {
      computedMaxTokens = Math.floor(requestedMaxTokens);
    } else {
      const remainingContext = Math.max(0, contextWindow - estimatedInputTokens);
      if (remainingContext > 0) {
        computedMaxTokens = Math.min(defaultMaxTokens, remainingContext);
      }
    }

    if (computedMaxTokens + estimatedInputTokens > contextWindow + CONTEXT_WINDOW_SAFETY_MARGIN) {
      debugLog(
        "NimChatModelProvider",
        `Requested max_tokens (${computedMaxTokens}) + estimated input (${estimatedInputTokens}) exceeds context window (${contextWindow}). Relying on API limits.`,
      );
    }

    return computedMaxTokens;
  }

  static calculateMaxToolResultChars(options: LanguageModelChatRequestOptions): number | undefined {
    const maxToolChars = options.modelOptions?.max_tool_result_chars;
    if (typeof maxToolChars === "number" && !isNaN(maxToolChars) && maxToolChars > 0) {
      return Math.floor(maxToolChars);
    }
    return undefined;
  }
}
