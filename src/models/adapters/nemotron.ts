import { NimChatRequest } from "../../types";
import { BaseModelAdapter, ensureChatTemplateKwargs, resolveReasoningMode } from "./base";

export abstract class NemotronFamilyAdapter extends BaseModelAdapter {
  override readonly toolTemperature = 0.6;
  override readonly defaultTopP = 0.95;
}

/**
 * Nemotron 3 Super and Ultra model cards ask coding agents to send
 * `force_nonempty_content`; Ultra's card requires it on tool requests so the
 * endpoint parses both reasoning and tool calls.
 */
export function applyNemotronToolTurnOptions(
  request: NimChatRequest,
  context: { toolsEnabled: boolean },
): void {
  if (context.toolsEnabled) {
    ensureChatTemplateKwargs(request).force_nonempty_content = true;
  }
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

  applyTurnOptions(request: NimChatRequest, context: { toolsEnabled: boolean }): void {
    applyNemotronToolTurnOptions(request, context);
  }
}
