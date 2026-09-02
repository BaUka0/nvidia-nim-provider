import { ReasoningEffortAdapter } from "./base";

export class InklingAdapter extends ReasoningEffortAdapter {
  constructor() {
    super(
      /(^|[\/_-])inkling([\/_-]|$)/i,
      1,
      ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      false,
    );
  }
}
