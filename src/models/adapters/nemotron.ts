import { NimChatRequest } from "../../types";
import { BaseModelAdapter, ensureChatTemplateKwargs, resolveReasoningMode } from "./base";

/**
 * Nemotron 3 family. `chat_template_kwargs.force_nonempty_content` is never
 * sent: the model cards suggest it for coding agents on self-hosted vLLM, but
 * on hosted NIM streaming it turns off reasoning separation, so the whole
 * reasoning trace and a literal `</think>` arrive in `content` (verified
 * against Super and Ultra on 2026-09-29).
 */
export abstract class NemotronFamilyAdapter extends BaseModelAdapter {
  override readonly toolTemperature = 0.6;
  override readonly defaultTopP = 0.95;
}

/**
 * Nemotron 3 Ultra. The NIM reference documents `reasoning_effort` only as a
 * snippet-level field that is translated into `chat_template_kwargs`, so the
 * adapter sends the translated form directly.
 */
export class NemotronAdapter extends NemotronFamilyAdapter {
  readonly idPattern = /(^|[\/_-])nemotron([\/_-]|$)/i;

  readonly supportedReasoningModes = ["none", "medium", "high"];
  readonly reasoningParameterFormat = "chat_template_kwargs" as const;

  applyReasoningMode(request: NimChatRequest, mode: string): void {
    const resolved = resolveReasoningMode(mode, this.supportedReasoningModes);
    const kwargs = ensureChatTemplateKwargs(request);
    kwargs.enable_thinking = resolved !== "none";
    if (resolved === "medium") {
      kwargs.medium_effort = true;
    } else {
      delete kwargs.medium_effort;
    }
  }
}
