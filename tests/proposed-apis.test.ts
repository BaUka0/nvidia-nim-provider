import { emitThinkingPart } from "../src/shared/proposed-apis";

jest.mock("vscode", () => ({
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
}));

describe("emitThinkingPart", () => {
  it("does not emit text when ThinkingPart constructor is missing", () => {
    const report = jest.fn();
    const result = emitThinkingPart({ report }, "thought");
    expect(result).toEqual({ didReport: false, emittedVisible: false });
    expect(report).not.toHaveBeenCalled();
  });
});
