import { NimChatRequest } from "../../types";
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

  /**
   * The chat template rejects a trailing assistant message with a bare 400
   * ("Invalid request"); `prefix: true` is rejected too. vLLM's
   * `continue_final_message` renders it as a prefill the model continues.
   * Retry nudges appended later leave a user tail, which NIM still accepts
   * with the flag set (verified on hosted NIM on 2026-10-30).
   */
  applyRequestWorkaround(request: NimChatRequest): void {
    const last = request.messages.at(-1);
    if (last?.role !== "assistant" || last.tool_calls?.length) {
      return;
    }
    request.continue_final_message = true;
    request.add_generation_prompt = false;
  }
}
