import { emitThinkingPart } from "../src/shared/proposed-apis";

jest.mock("vscode", () => ({
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "reasoning.showInChat" ? true : defaultValue,
      ),
    })),
  },
}));

describe("emitThinkingPart", () => {
  it("falls back to text when ThinkingPart is missing and showInChat is enabled", () => {
    const report = jest.fn();
    const result = emitThinkingPart({ report }, "thought");
    expect(result).toEqual({ didReport: true, emittedVisible: true });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ value: " thought" }));
  });
});
