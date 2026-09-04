import { BaseModelAdapter, ReasoningEffortAdapter } from "./base";

export const NEMOTRON_TOOL_SYSTEM_MESSAGE =
  'You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, you must invoke tools directly when needed to accomplish the user\'s task. NEVER start your response with "Let me fix", "Let me run", "Let me check" or similar preamble when a tool is needed — emit the tool call immediately. Do not wrap tool arguments in markdown fences, backticks, or explanatory prose.';

export abstract class NemotronFamilyAdapter extends BaseModelAdapter {
  readonly defaultTemperature = 1;
  readonly toolTemperature = 1;
  readonly defaultTopP = 0.95;
  readonly toolSystemMessage = NEMOTRON_TOOL_SYSTEM_MESSAGE;
}

export class NemotronAdapter extends ReasoningEffortAdapter {
  readonly toolTemperature = 1;
  readonly defaultTopP = 0.95;
  readonly toolSystemMessage = NEMOTRON_TOOL_SYSTEM_MESSAGE;

  constructor() {
    super(/(^|[\/_-])nemotron([\/_-]|$)/i, 1, ["none", "medium", "high"]);
  }
}
