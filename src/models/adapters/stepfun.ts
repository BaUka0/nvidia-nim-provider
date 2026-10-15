import { BaseModelAdapter } from "./base";

/**
 * StepFun Step 5 Preview. Reasoning is always on and arrives in a separate
 * `reasoning_content` field. No reasoning parameter is sent: the endpoint
 * accepts `reasoning_effort`, but no level changed the reasoning length, and
 * `reasoning_effort: "none"` or `chat_template_kwargs` `enable_thinking` /
 * `thinking: false` keep the model reasoning while moving the trace into
 * `content` behind a bare `</think>` (verified on hosted NIM on 2026-10-15).
 */
export class StepfunAdapter extends BaseModelAdapter {
  readonly idPattern = /(^|[\/_-])step([\/_-]|$)/i;
}
