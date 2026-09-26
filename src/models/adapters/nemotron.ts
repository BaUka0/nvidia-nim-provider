import { BaseModelAdapter, ReasoningEffortAdapter } from "./base";

export abstract class NemotronFamilyAdapter extends BaseModelAdapter {
  override readonly toolTemperature = 0.6;
  override readonly defaultTopP = 0.95;
}

export class NemotronAdapter extends ReasoningEffortAdapter {
  override readonly toolTemperature = 0.6;
  override readonly defaultTopP = 0.95;

  constructor() {
    super(/(^|[\/_-])nemotron([\/_-]|$)/i, ["none", "medium", "high"]);
  }
}
