import { ReasoningEffortAdapter } from "./base";

export class MuseGlimmerAdapter extends ReasoningEffortAdapter {
  constructor() {
    super(
      /(^|[\/_-])muse-glimmer([\/_-]|$)/i,
      1,
      ["none", "low", "medium", "high", "xhigh"],
      false,
    );
  }
}
