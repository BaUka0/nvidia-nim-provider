import { ReasoningEffortAdapter } from "./base";

export class MuseGlimmerAdapter extends ReasoningEffortAdapter {
  constructor() {
    super(/(^|[\/_-])muse-glimmer([\/_-]|$)/i, ["none", "low", "medium", "high", "xhigh"], false);
  }
}
