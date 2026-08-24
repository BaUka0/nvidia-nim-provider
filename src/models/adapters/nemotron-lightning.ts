import { BaseModelAdapter } from "./base";

export const LIGHTNING_MAX_OUTPUT_TOKENS = 32768;

const REASONING_BUDGET_RATIOS: Record<string, number> = {
  none: 0,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
};

export function lightningReasoningBudget(mode: string, maxTokens?: number): number {
  const ratio = REASONING_BUDGET_RATIOS[mode];
  if (ratio === undefined || ratio <= 0) {
    return 0;
  }
  const outputBudget =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? maxTokens
      : LIGHTNING_MAX_OUTPUT_TOKENS;
  return Math.min(LIGHTNING_MAX_OUTPUT_TOKENS, Math.max(0, Math.round(outputBudget * ratio)));
}

export class NemotronLightningAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3\.5-lightning([\/_-]|$)/i;
  readonly defaultTemperature = 1;
  readonly toolTemperature = 1;
  readonly defaultTopP = 0.95;
  readonly toolSystemMessage =
    'You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, you must invoke tools directly when needed to accomplish the user\'s task. NEVER start your response with "Let me fix", "Let me run", "Let me check" or similar preamble when a tool is needed — emit the tool call immediately. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.';

  readonly supportedReasoningModes = ["none", "medium", "high", "xhigh"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    request.chat_template_kwargs = request.chat_template_kwargs || {};
    const reasoningBudget = lightningReasoningBudget(mode, request.max_tokens);
    request.chat_template_kwargs.enable_thinking = reasoningBudget > 0;
    request.chat_template_kwargs.reasoning_budget = reasoningBudget;
  }
}
