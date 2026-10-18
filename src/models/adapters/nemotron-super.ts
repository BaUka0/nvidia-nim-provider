import { ensureChatTemplateKwargs, resolveReasoningMode } from "./base";
import { NemotronFamilyAdapter } from "./nemotron";

export const SUPER_VL_LOW_REASONING_BUDGET = 8192;

/**
 * Nemotron 3.5 Super VL. The playground offers none/low/high like Super 3, but on
 * hosted NIM `low_effort` is ignored (unknown template keys are dropped): on a
 * multi-step counting task it reasoned 14.6K-16.3K tokens against 11.6K-14.4K
 * for plain thinking, and `reasoning_effort: "low"` ran longer still. Only
 * `reasoning_budget` bounds it, cutting reasoning at the budget and answering
 * right after (verified 2026-10-15), so Low sends a budget instead.
 */
export class NemotronSuperVlAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron-3\.5-super([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "low", "high"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    const kwargs = ensureChatTemplateKwargs(request);
    kwargs.enable_thinking = resolved !== "none";
    if (resolved === "low") {
      // Reasoning shares max_tokens, so keep at least half of it for the answer.
      const maxTokens = request.max_tokens;
      kwargs.reasoning_budget =
        typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
          ? Math.min(SUPER_VL_LOW_REASONING_BUDGET, Math.floor(maxTokens / 2))
          : SUPER_VL_LOW_REASONING_BUDGET;
    } else {
      delete kwargs.reasoning_budget;
    }
  }
}
