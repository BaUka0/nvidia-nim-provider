import { cloneNimChatRequest } from "../src/provider/request-snapshot";
import { NimChatRequest } from "../src/types";

describe("cloneNimChatRequest", () => {
  it("deep-copies chat_template_kwargs so retries cannot mutate the baseline", () => {
    const body: NimChatRequest = {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      chat_template_kwargs: { thinking: { enabled: true } },
    };
    const clone = cloneNimChatRequest(body);
    (clone.chat_template_kwargs as { thinking: { enabled: boolean } }).thinking.enabled = false;
    expect((body.chat_template_kwargs as { thinking: { enabled: boolean } }).thinking.enabled).toBe(
      true,
    );
  });
});
