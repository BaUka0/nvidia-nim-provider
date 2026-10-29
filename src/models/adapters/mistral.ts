import { ReasoningEffortAdapter } from "./base";

/**
 * Mistral Large 4. Always reasons; the trace arrives in `reasoning_content`.
 * The NIM schema lists every `reasoning_effort` level, but only `low`,
 * `medium` and `high` are accepted (`none`, `minimal`, `xhigh`, `max` return
 * 400), and `chat_template_kwargs` thinking switches are ignored (verified on
 * hosted NIM on 2026-10-29). `none` maps to `low`.
 */
export class MistralAdapter extends ReasoningEffortAdapter {
  constructor() {
    super(/(^|[\/_-])mistral([\/_-]|$)/i, ["low", "medium", "high"]);
  }
}
