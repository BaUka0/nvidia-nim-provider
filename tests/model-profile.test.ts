import { getModelRequestProfile } from "../src/model-profile";

describe("getModelRequestProfile", () => {
  it.each([
    ["kimi-k2.6", 0.2, "Do not reveal chain-of-thought"],
    ["zai-org/glm-4.5", 0.1, "strict JSON arguments"],
    ["meta/llama-4-maverick-17b-128e-instruct", 0.2, "Do not emit pseudo tool syntax"],
  ])(
    "returns a specialized tool-enabled profile for %s",
    (modelId: string, expectedTemperature: number, expectedMessageSnippet: string) => {
      const profile = getModelRequestProfile(modelId, { toolsEnabled: true });

      expect(profile.defaultTemperature).toBe(expectedTemperature);
      expect(profile.extraSystemMessages).toEqual(
        expect.arrayContaining([expect.stringContaining(expectedMessageSnippet)]),
      );
    },
  );

  it("does not add extra system guidance when tools are disabled", () => {
    const profile = getModelRequestProfile("kimi-k2.6", { toolsEnabled: false });

    expect(profile.defaultTemperature).toBe(0.2);
    expect(profile.extraSystemMessages).toEqual([]);
  });

  it("falls back to the default profile for unknown models", () => {
    const profile = getModelRequestProfile("unknown-model", { toolsEnabled: true });

    expect(profile.defaultTemperature).toBe(0.7);
    expect(profile.extraSystemMessages).toEqual([]);
  });
});
