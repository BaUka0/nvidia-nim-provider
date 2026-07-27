import { BaseModelAdapter } from "./base";

export class StepfunAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])step([\/_-]|$)/i;
  readonly defaultTemperature = 0.7;
  // StepFun may emit <think> tags, but plain content is an answer and must
  // remain visible when the model omits a separate reasoning field.
  readonly isolateUntaggedReasoning = false;
}
