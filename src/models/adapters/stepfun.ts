import { BaseModelAdapter } from "./base";

export class StepfunAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])step([\/_-]|$)/i;
  readonly defaultTemperature = 0.7;
  readonly alwaysReasons = true;
}
