import { OcGoChatMessage } from "../types";
import { ParsedTextToolCallResult } from "../tool-parser";

export interface NvidiaModelRequestProfile {
  defaultTemperature: number;
  toolTemperature?: number;
  extraSystemMessages: string[];
}

export interface ModelAdapter {
  matches(modelId: string): boolean;
  getProfile(options: { toolsEnabled?: boolean }): NvidiaModelRequestProfile;
  applyMessagesWorkaround?(messages: OcGoChatMessage[]): OcGoChatMessage[];
  parseTextEmbeddedToolCalls?(text: string): ParsedTextToolCallResult;
}
