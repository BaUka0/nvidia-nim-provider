import { ReasoningEffortAdapter } from "./base";

export class MuseGlimmerAdapter extends ReasoningEffortAdapter {
  constructor() {
    // Matches the NIM reference enum for reasoning_effort.
    super(
      /(^|[\/_-])muse-glimmer([\/_-]|$)/i,
      ["none", "minimal", "low", "medium", "high", "max"],
      false,
    );
  }
}
