import { NimChatRequest } from "../../types";
import { ensureChatTemplateKwargs, resolveReasoningMode } from "./base";
import { NemotronFamilyAdapter } from "./nemotron";

/** Documented `reasoning_budget` maximum on the NIM reference. */
export const OMNI_MAX_REASONING_BUDGET = 32768;

// High is NVIDIA's default budget (16384); xhigh is the documented maximum.
const OMNI_REASONING_BUDGETS: Record<string, number> = {
  medium: 8192,
  high: 16384,
  xhigh: OMNI_MAX_REASONING_BUDGET,
};

/**
 * Reasoning budget for a mode, capped at half of `max_tokens`. Hosted NIM
 * lets a budget above `max_tokens` override the output cap (a 4096 budget
 * with `max_tokens: 512` returned 3839 completion tokens, probed 2026-10-05),
 * so the cap keeps the turn inside the context window and leaves room for
 * the answer and tool calls.
 */
export function omniReasoningBudget(mode: string, maxTokens?: number): number {
  const budget = OMNI_REASONING_BUDGETS[mode];
  if (budget === undefined) {
    return 0;
  }
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.min(budget, Math.floor(maxTokens / 2));
  }
  return budget;
}

/**
 * Nemotron 3 Nano Omni. Thinking is controlled by `enable_thinking` plus a
 * hard `reasoning_budget`; both are always sent explicitly, because a request
 * without `chat_template_kwargs` has returned the reasoning trace duplicated
 * into `content`.
 */
export class NemotronOmniAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3-nano-omni([\/_-]|$)/i;

  // Model card: thinking mode temperature 0.5-0.7, top_p 0.95.
  override readonly defaultTemperature = 0.6;
  // The NIM reference documents a 0-2 temperature range for this model.
  override readonly maxTemperature = 2;

  readonly supportedReasoningModes = ["none", "medium", "high", "xhigh"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: NimChatRequest, mode: string): void {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    const kwargs = ensureChatTemplateKwargs(request);
    const reasoningBudget = omniReasoningBudget(resolved, request.max_tokens);
    kwargs.enable_thinking = reasoningBudget > 0;
    if (reasoningBudget > 0) {
      kwargs.reasoning_budget = reasoningBudget;
    } else {
      delete kwargs.reasoning_budget;
    }
  }
}
