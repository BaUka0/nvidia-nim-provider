import { NimChatMessage } from "../../types";
import { ParsedTextToolCallResult } from "../../tools/parser";

export interface NvidiaModelRequestProfile {
  defaultTemperature: number;
  toolTemperature?: number;
  extraSystemMessages: string[];
}

export interface ModelAdapter {
  readonly idPattern: RegExp;
  matches(modelId: string): boolean;
  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile;
  applyMessagesWorkaround?(messages: NimChatMessage[]): NimChatMessage[];
  parseTextEmbeddedToolCalls?(text: string): ParsedTextToolCallResult;
  applyReasoningMode?(request: import("../../types").NimChatRequest, mode: string): void;
  readonly supportedReasoningModes?: string[];
  readonly alwaysReasons?: boolean;
}

export const DEFAULT_TEMPERATURE = 0.7;

export abstract class BaseModelAdapter implements ModelAdapter {
  abstract readonly idPattern: RegExp;
  abstract readonly defaultTemperature: number;
  readonly toolTemperature?: number;
  readonly toolSystemMessage?: string;

  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile {
    return {
      defaultTemperature: this.defaultTemperature,
      toolTemperature: this.toolTemperature,
      extraSystemMessages:
        options.toolsEnabled && this.toolSystemMessage ? [this.toolSystemMessage] : [],
    };
  }

  matches(modelId: string): boolean {
    return this.idPattern.test(modelId);
  }
}
