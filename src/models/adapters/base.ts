import { NimChatMessage } from "../../types";
import { parseTextEmbeddedToolCalls, ParsedTextToolCallResult } from "../../tools/parser";

export type ReasoningParameterFormat = "none" | "reasoning_effort" | "chat_template_kwargs";

export type ToolCallProtocol = "native-and-text" | "native-only";

export type ReasoningRouting = "direct-content" | "isolated" | "always-isolated";

export interface ModelAdapterCapabilityContract {
  readonly reasoningModes: readonly string[];
  readonly reasoningParameterFormat: ReasoningParameterFormat;
  readonly toolCallProtocol: ToolCallProtocol;
  readonly responseSanitization: "none" | "model-specific";
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
  parseTextEmbeddedToolCalls?(text: string): ParsedTextToolCallResult;
  applyReasoningMode?(request: import("../../types").NimChatRequest, mode: string): void;
  sanitizeResponseText?(text: string): string;
  readonly supportedReasoningModes?: string[];
  readonly reasoningParameterFormat?: ReasoningParameterFormat;
  readonly toolCallProtocol?: ToolCallProtocol;
  readonly isolateUntaggedReasoning?: boolean;
  readonly alwaysReasons?: boolean;
  readonly supportsPresencePenalty?: boolean;
  readonly supportsFrequencyPenalty?: boolean;
  readonly supportsRepetitionPenalty?: boolean;

  getCapabilityContract(): ModelAdapterCapabilityContract;
}

export const DEFAULT_TEMPERATURE = 0.7;

/** Shared visible-reply hygiene. Prefer this over growing the stream sanitizer. */
export const VISIBLE_REPLY_HYGIENE_MESSAGE =
  "Visible replies must be markdown only. Do not emit XML section wrappers such as <steps>, <suggested_fix>, <next_steps>, <analysis>, or <plan>. Do not emit _vscodecontentref_ URLs or markdown links to them; write plain file names.";

export abstract class BaseModelAdapter implements ModelAdapter {
  abstract readonly idPattern: RegExp;
  abstract readonly defaultTemperature: number;
  readonly toolTemperature?: number;
  readonly defaultTopP?: number;
  readonly toolSystemMessage?: string;
  readonly supportedReasoningModes?: string[];
  readonly isolateUntaggedReasoning?: boolean;
  readonly alwaysReasons?: boolean;
  readonly supportsPresencePenalty?: boolean;
  readonly supportsFrequencyPenalty?: boolean;
  readonly supportsRepetitionPenalty?: boolean;
  sanitizeResponseText?(text: string): string;
  readonly reasoningParameterFormat: ReasoningParameterFormat = "none";
  readonly toolCallProtocol: ToolCallProtocol = "native-and-text";

  parseTextEmbeddedToolCalls(text: string): ParsedTextToolCallResult {
    return parseTextEmbeddedToolCalls(text);
  }

  getCapabilityContract(): ModelAdapterCapabilityContract {
    return {
      reasoningModes: this.supportedReasoningModes ?? [],
      reasoningParameterFormat: this.reasoningParameterFormat,
      toolCallProtocol: this.toolCallProtocol,
      responseSanitization: this.sanitizeResponseText ? "model-specific" : "none",
      reasoningRouting: this.alwaysReasons
        ? "always-isolated"
        : this.isolateUntaggedReasoning === false
          ? "direct-content"
          : "isolated",
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
      extraSystemMessages:
        options.toolsEnabled && this.toolSystemMessage
          ? [this.toolSystemMessage, VISIBLE_REPLY_HYGIENE_MESSAGE]
          : [],
    };
  }

  matches(modelId: string): boolean {
    return this.idPattern.test(modelId);
  }
}
