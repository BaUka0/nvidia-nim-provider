import { BaseModelAdapter, ReasoningEffortAdapter } from "./base";

export const NEMOTRON_TOOL_SYSTEM_MESSAGE =
  "You are an expert AI programming assistant. Provide correct, concise, production-ready code. When tools are available, invoke the appropriate tool directly via native function calls. Emit user-facing text only to explain results or ask necessary clarifying questions.";

export abstract class NemotronFamilyAdapter extends BaseModelAdapter {
  readonly toolSystemMessage = NEMOTRON_TOOL_SYSTEM_MESSAGE;
}

export class NemotronAdapter extends ReasoningEffortAdapter {
  readonly toolSystemMessage = NEMOTRON_TOOL_SYSTEM_MESSAGE;

  constructor() {
    super(/(^|[\/_-])nemotron([\/_-]|$)/i, ["none", "medium", "high"]);
  }
}
