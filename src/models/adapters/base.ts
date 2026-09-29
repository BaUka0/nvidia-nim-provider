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
  /** False when the NIM endpoint fixes top_p and does not accept it (Kimi K3). */
  topPSupported: boolean;
  /** Upper bound of the endpoint's documented temperature range. */
  maxTemperature: number;
  parallelToolCalls?: boolean;
  extraSystemMessages: string[];
}

export interface ModelAdapter {
  readonly idPattern: RegExp;
  matches(modelId: string): boolean;
  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile;
  applyMessagesWorkaround?(messages: NimChatMessage[]): NimChatMessage[];
  applyReasoningMode?(request: import("../../types").NimChatRequest, mode: string): void;
  /**
   * Model-card request options that depend on the turn rather than the
   * reasoning mode. Called after tools are attached to the request.
   */
  applyTurnOptions?(
    request: import("../../types").NimChatRequest,
    context: { toolsEnabled: boolean },
  ): void;
  isContentOnlyMode?(mode: string): boolean;
  readonly supportedReasoningModes?: string[];
  /** Model-specific default used until the user sets `nvidia-nim.reasoning.mode`. */
  readonly defaultReasoningMode?: string;
  readonly reasoningParameterFormat?: ReasoningParameterFormat;
  readonly toolCallProtocol?: ToolCallProtocol;
  readonly isolateUntaggedReasoning?: boolean;

  getCapabilityContract(): ModelAdapterCapabilityContract;
}

export const DEFAULT_TEMPERATURE = 1.0;
export const DEFAULT_TOP_P = 0.95;
/**
 * Every published NIM API reference for the curated models caps temperature
 * at 1 (DeepSeek V4.1 Flash has no reference page; its card recommends 1.0).
 */
export const DEFAULT_MAX_TEMPERATURE = 1.0;

export function resolveReasoningMode(
  requested: string | undefined,
  supportedModes: readonly string[] | undefined,
): string {
  if (!supportedModes || supportedModes.length === 0) {
    return requested ?? "none";
  }

  const defaultMode = supportedModes.includes("none") ? "none" : supportedModes[0];
  if (!requested) {
    return defaultMode;
  }

  const normalized = requested.toLowerCase().trim();
  const matched = supportedModes.find((m) => m.toLowerCase() === normalized);
  if (matched) {
    return matched;
  }

  const nonNoneModes = supportedModes.filter(
    (m) => m.toLowerCase() !== "none" && m.toLowerCase() !== "off",
  );

  if (normalized === "none" || normalized === "off") {
    return (
      supportedModes.find((m) => m.toLowerCase() === "none") ??
      supportedModes.find((m) => m.toLowerCase() === "off") ??
      defaultMode
    );
  }

  const candidatePreferences: Record<string, string[]> = {
    on: ["high", "medium", "low", "max", "xhigh"],
    auto: ["high", "medium", "low", "max", "xhigh"],
    high: ["high", "max", "xhigh", "medium", "low"],
    max: ["max", "xhigh", "high", "medium", "low"],
    xhigh: ["xhigh", "max", "high", "medium", "low"],
    medium: ["medium", "low", "high", "max", "xhigh"],
    low: ["low", "medium", "high", "max", "xhigh"],
  };

  const preferences = candidatePreferences[normalized] ?? ["high", "medium", "low", "max", "xhigh"];
  for (const pref of preferences) {
    const found = supportedModes.find((m) => m.toLowerCase() === pref);
    if (found) {
      return found;
    }
  }

  if (nonNoneModes.length > 0) {
    return nonNoneModes[0];
  }

  return defaultMode;
}

/**
 * Default reasoning mode for a model: the adapter's own default until the user
 * sets `nvidia-nim.reasoning.mode`, then that setting mapped onto the modes the
 * model supports. Used for the model picker default and for requests that
 * carry no per-model choice.
 */
export function resolveDefaultReasoningMode(
  adapter: Pick<ModelAdapter, "supportedReasoningModes" | "defaultReasoningMode">,
  reasoning: { mode: string; explicit: boolean },
): string {
  const modes = adapter.supportedReasoningModes;
  if (!modes || modes.length === 0) {
    return reasoning.mode;
  }
  if (!reasoning.explicit && adapter.defaultReasoningMode) {
    return resolveReasoningMode(adapter.defaultReasoningMode, modes);
  }
  return resolveReasoningMode(reasoning.mode, modes);
}

export function assignReasoningEffort(
  request: import("../../types").NimChatRequest,
  mode: string,
  supportedModes: readonly string[],
): void {
  request.reasoning_effort = resolveReasoningMode(mode, supportedModes);
}

export function ensureChatTemplateKwargs(
  request: import("../../types").NimChatRequest,
): Record<string, unknown> {
  request.chat_template_kwargs = request.chat_template_kwargs ?? {};
  return request.chat_template_kwargs;
}

/**
 * Single source of the reasoning-isolation routing rule used by the request
 * builder and the capability matrix: when an adapter sends a reasoning
 * parameter for `mode` and does not opt out of isolation, reasoning content
 * must arrive as isolated thinking parts rather than inline text.
 */
export function isReasoningIsolationExpected(
  adapter: Pick<
    ModelAdapter,
    "applyReasoningMode" | "isolateUntaggedReasoning" | "isContentOnlyMode"
  >,
  mode: string,
): boolean {
  if (!adapter.applyReasoningMode || adapter.isolateUntaggedReasoning === false) {
    return false;
  }
  if (typeof adapter.isContentOnlyMode === "function") {
    return !adapter.isContentOnlyMode(mode);
  }
  return mode !== "none";
}

export abstract class BaseModelAdapter implements ModelAdapter {
  abstract readonly idPattern: RegExp;
  readonly defaultTemperature: number = DEFAULT_TEMPERATURE;
  readonly toolTemperature?: number = DEFAULT_TEMPERATURE;
  readonly defaultTopP?: number = DEFAULT_TOP_P;
  readonly topPSupported: boolean = true;
  readonly maxTemperature: number = DEFAULT_MAX_TEMPERATURE;
  readonly parallelToolCalls?: boolean;
  readonly toolSystemMessage?: string;
  readonly supportedReasoningModes?: string[];
  readonly isolateUntaggedReasoning?: boolean;
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

  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile {
    return {
      defaultTemperature: this.defaultTemperature,
      toolTemperature: this.toolTemperature,
      defaultTopP: this.topPSupported ? this.defaultTopP : undefined,
      topPSupported: this.topPSupported,
      maxTemperature: this.maxTemperature,
      parallelToolCalls: options.toolsEnabled ? this.parallelToolCalls : undefined,
      extraSystemMessages: [],
    };
  }

  matches(modelId: string): boolean {
    return this.idPattern.test(modelId);
  }
}

export class ReasoningEffortAdapter extends BaseModelAdapter {
  constructor(
    readonly idPattern: RegExp,
    readonly supportedReasoningModes: string[],
    readonly isolateUntaggedReasoning?: boolean,
    readonly defaultTemperature: number = DEFAULT_TEMPERATURE,
  ) {
    super();
  }

  readonly reasoningParameterFormat = "reasoning_effort" as const;

  applyReasoningMode(request: import("../../types").NimChatRequest, mode: string): void {
    assignReasoningEffort(request, mode, this.supportedReasoningModes);
  }
}
