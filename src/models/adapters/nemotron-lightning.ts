import { ensureChatTemplateKwargs } from "./base";
import { NemotronFamilyAdapter } from "./nemotron";

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

export class NemotronLightningAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3\.5-lightning([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "medium", "high", "xhigh"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const kwargs = ensureChatTemplateKwargs(request);
    const reasoningBudget = lightningReasoningBudget(mode, request.max_tokens);
    kwargs.enable_thinking = reasoningBudget > 0;
    kwargs.reasoning_budget = reasoningBudget;
  }
}
