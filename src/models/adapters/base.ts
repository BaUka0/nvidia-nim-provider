import { NimChatMessage } from "../../types";

export type ReasoningParameterFormat = "none" | "reasoning_effort" | "chat_template_kwargs";

export type ToolCallProtocol = "native-and-text" | "native-only";

export type ReasoningRouting = "direct-content" | "isolated";

export interface ModelAdapterCapabilityContract {
  readonly reasoningModes: readonly string[];
  readonly reasoningParameterFormat: ReasoningParameterFormat;
  readonly toolCallProtocol: ToolCallProtocol;
  readonly reasoningRouting: ReasoningRouting;
}

export interface NvidiaModelRequestProfile {
  defaultTemperature: number;
  toolTemperature?: number;
  defaultTopP?: number;
  defaultFrequencyPenalty?: number;
  defaultPresencePenalty?: number;
  extraSystemMessages: string[];
}

export interface ModelAdapter {
  readonly idPattern: RegExp;
  matches(modelId: string): boolean;
  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile;
  applyMessagesWorkaround?(messages: NimChatMessage[]): NimChatMessage[];
  applyReasoningMode?(request: import("../../types").NimChatRequest, mode: string): void;
  readonly supportedReasoningModes?: string[];
  readonly reasoningParameterFormat?: ReasoningParameterFormat;
  readonly toolCallProtocol?: ToolCallProtocol;
  readonly isolateUntaggedReasoning?: boolean;
  readonly supportsPresencePenalty?: boolean;
  readonly supportsFrequencyPenalty?: boolean;
  readonly supportsRepetitionPenalty?: boolean;

  getCapabilityContract(): ModelAdapterCapabilityContract;
}

export const DEFAULT_TEMPERATURE = 0.7;

export function assignReasoningEffort(
  request: import("../../types").NimChatRequest,
  mode: string,
  supportedModes: readonly string[],
): void {
  request.reasoning_effort = supportedModes.includes(mode) ? mode : "none";
}

export function ensureChatTemplateKwargs(
  request: import("../../types").NimChatRequest,
): Record<string, unknown> {
  request.chat_template_kwargs = request.chat_template_kwargs ?? {};
  return request.chat_template_kwargs;
}

/** Shared visible-reply hygiene. Prefer this over growing the stream sanitizer. */
export const VISIBLE_REPLY_HYGIENE_MESSAGE =
  "Visible replies must be markdown only. Do not emit XML section wrappers such as <steps>, <suggested_fix>, <next_steps>, <analysis>, or <plan>. Do not emit _vscodecontentref_ URLs or markdown links to them; write plain file names.";

/**
 * Single source of the reasoning-isolation routing rule used by the request
 * builder and the capability matrix: when an adapter sends a reasoning
 * parameter for `mode` and does not opt out of isolation, reasoning content
 * must arrive as isolated thinking parts rather than inline text.
 */
export function isReasoningIsolationExpected(
  adapter: Pick<ModelAdapter, "applyReasoningMode" | "isolateUntaggedReasoning">,
  mode: string,
): boolean {
  return (
    Boolean(adapter.applyReasoningMode) &&
    mode !== "none" &&
    adapter.isolateUntaggedReasoning !== false
  );
}

export abstract class BaseModelAdapter implements ModelAdapter {
  abstract readonly idPattern: RegExp;
  abstract readonly defaultTemperature: number;
  readonly toolTemperature?: number;
  readonly defaultTopP?: number;
  readonly toolSystemMessage?: string;
  readonly supportedReasoningModes?: string[];
  readonly isolateUntaggedReasoning?: boolean;
  readonly supportsPresencePenalty?: boolean;
  readonly supportsFrequencyPenalty?: boolean;
  readonly supportsRepetitionPenalty?: boolean;
  readonly reasoningParameterFormat: ReasoningParameterFormat = "none";
  readonly toolCallProtocol: ToolCallProtocol = "native-and-text";

  getCapabilityContract(): ModelAdapterCapabilityContract {
    return {
      reasoningModes: this.supportedReasoningModes ?? [],
      reasoningParameterFormat: this.reasoningParameterFormat,
      toolCallProtocol: this.toolCallProtocol,
      reasoningRouting: isReasoningIsolationExpected(this, "high") ? "isolated" : "direct-content",
    };
  }

  readonly defaultFrequencyPenalty?: number;
  readonly defaultPresencePenalty?: number;

  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile {
    return {
      defaultTemperature: this.defaultTemperature,
      toolTemperature: this.toolTemperature,
      defaultTopP: this.defaultTopP,
      defaultFrequencyPenalty: this.defaultFrequencyPenalty,
      defaultPresencePenalty: this.defaultPresencePenalty,
      extraSystemMessages: options.toolsEnabled
        ? [
            ...(this.toolSystemMessage ? [this.toolSystemMessage] : []),
            VISIBLE_REPLY_HYGIENE_MESSAGE,
          ]
        : [],
    };
  }

  matches(modelId: string): boolean {
    return this.idPattern.test(modelId);
  }
}

export class ReasoningEffortAdapter extends BaseModelAdapter {
  constructor(
    readonly idPattern: RegExp,
    readonly defaultTemperature: number,
    readonly supportedReasoningModes: string[],
    readonly isolateUntaggedReasoning?: boolean,
  ) {
    super();
  }

  readonly reasoningParameterFormat = "reasoning_effort" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    assignReasoningEffort(request, mode, this.supportedReasoningModes);
  }
}
