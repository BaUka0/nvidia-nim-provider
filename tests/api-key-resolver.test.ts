import { getApiKeyFingerprint, NvidiaApiKeyResolver } from "../src/api/key-resolver";

describe("NvidiaApiKeyResolver", () => {
  const createSecrets = (value?: string) => ({
    get: jest.fn(async () => value),
  });

  it("prefers a configured provider-group key over legacy SecretStorage", async () => {
    const secrets = createSecrets("legacy-key");
    const resolver = new NvidiaApiKeyResolver(secrets);

    await expect(resolver.resolveConfiguredOrLegacy(" configured-key ")).resolves.toEqual({
      value: "configured-key",
      source: "configured",
    });
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("falls back to legacy SecretStorage for empty provider configuration", async () => {
    const secrets = createSecrets("legacy-key");
    const resolver = new NvidiaApiKeyResolver(secrets);

    await expect(resolver.resolveConfiguredOrLegacy("   ")).resolves.toEqual({
      value: "legacy-key",
      source: "legacy",
    });
    expect(secrets.get).toHaveBeenCalledWith("nvidia-nim.apiKey");
  });

  it("resolves a provider-group key by model identity and cloned model id", async () => {
    const secrets = createSecrets(undefined);
    const resolver = new NvidiaApiKeyResolver(secrets);
    const model = { id: "deepseek-ai/deepseek-v4-flash" };
    resolver.registerModelKey(model, "configured-key");

    await expect(resolver.resolveForModel(model)).resolves.toEqual({
      value: "configured-key",
      source: "runtime",
    });
    await expect(resolver.resolveForModel({ id: model.id })).resolves.toEqual({
      value: "configured-key",
      source: "runtime",
    });
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("clears runtime provider-group bindings and returns to the legacy fallback", async () => {
    const secrets = createSecrets("legacy-key");
    const resolver = new NvidiaApiKeyResolver(secrets);
    const model = { id: "deepseek-ai/deepseek-v4-flash" };
    resolver.registerModelKey(model, "configured-key");

    resolver.clearRuntimeBindings();

    await expect(resolver.resolveForModel(model)).resolves.toEqual({
      value: "legacy-key",
      source: "legacy",
    });
  });

  it("exposes a single runtime key to tools and keeps the fingerprint non-empty", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets(undefined));
    resolver.rememberRuntimeKey("configured-key", "group-a");

    await expect(resolver.resolveForTool()).resolves.toEqual({
      value: "configured-key",
      source: "runtime",
    });
    expect(getApiKeyFingerprint("configured-key")).toMatch(/^[a-f0-9]{64}$/);
    expect(getApiKeyFingerprint("configured-key")).not.toBe("configured-key");
  });

  it("clears only the requested provider-group binding", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets(undefined));
    const modelA = { id: "model-a" };
    const modelB = { id: "model-b" };
    resolver.registerModelKey(modelA, "key-a", "group-a");
    resolver.registerModelKey(modelB, "key-b", "group-b");

    resolver.clearRuntimeBindings("group-b");

    await expect(resolver.resolveForModel(modelA)).resolves.toEqual({
      value: "key-a",
      source: "runtime",
    });
    await expect(resolver.resolveForModel(modelB)).resolves.toBeUndefined();
    await expect(resolver.resolveForTool()).resolves.toEqual({
      value: "key-a",
      source: "runtime",
    });
  });

  it("keeps cloned duplicate model ids bound to their own provider-group keys", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets(undefined));
    const modelA = { id: "shared-model" };
    const modelB = { id: "shared-model" };
    resolver.registerModelKey(modelA, "key-a", "group-a");
    resolver.registerModelKey(modelB, "key-b", "group-b");

    await expect(resolver.resolveForModel({ ...modelA })).resolves.toEqual({
      value: "key-a",
      source: "runtime",
    });
    await expect(resolver.resolveForModel({ ...modelB })).resolves.toEqual({
      value: "key-b",
      source: "runtime",
    });
    await expect(resolver.resolveForModel({ id: "shared-model" })).resolves.toBeUndefined();
    await expect(resolver.resolveForTool()).resolves.toBeUndefined();
    await expect(
      resolver.resolveForTool({ cacheKeyFingerprint: getApiKeyFingerprint("key-a") }),
    ).resolves.toEqual({
      value: "key-a",
      source: "runtime",
    });
  });

  it("does not use a legacy tool key when cache ownership is ambiguous", async () => {
    const secrets = createSecrets("legacy-key");
    const resolver = new NvidiaApiKeyResolver(secrets);
    resolver.rememberRuntimeKey("key-a", "group-a");
    resolver.rememberRuntimeKey("key-b", "group-b");

    await expect(resolver.resolveForTool()).resolves.toBeUndefined();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("fails closed for ambiguous frozen model clones even when legacy storage has a key", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets("legacy-key"));
    const modelA = Object.freeze({ id: "shared-model" });
    const modelB = Object.freeze({ id: "shared-model" });
    resolver.registerModelKey(modelA, "key-a", "group-a");
    resolver.registerModelKey(modelB, "key-b", "group-b");

    await expect(resolver.resolveForModel({ id: "shared-model" })).resolves.toBeUndefined();
  });

  it("does not use a different runtime key for a cache whose owner disappeared", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets(undefined));
    resolver.rememberRuntimeKey("key-a", "group-a");

    await expect(
      resolver.resolveForTool({ cacheKeyFingerprint: getApiKeyFingerprint("removed-key") }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveForTool({
        cacheKeyFingerprint: getApiKeyFingerprint("removed-key"),
        allowUnmatchedRuntimeKey: true,
      }),
    ).resolves.toEqual({ value: "key-a", source: "runtime" });
  });

  it("fails closed for stale model clones when another group reuses the model id", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets(undefined));
    const modelA = { id: "shared-model" };
    const modelB = { id: "shared-model" };
    resolver.registerModelKey(modelA, "key-a", "group-a");
    resolver.registerModelKey(modelB, "key-b", "group-b");

    resolver.clearRuntimeBindings("group-a");

    await expect(resolver.resolveForModel(modelA)).resolves.toBeUndefined();
    await expect(resolver.resolveForModel({ ...modelA })).resolves.toBeUndefined();
  });

  it("does not fall back to legacy storage while a changed group key is unresolved", async () => {
    const resolver = new NvidiaApiKeyResolver(createSecrets("legacy-key"));
    const model = { id: "shared-model" };
    resolver.registerModelKey(model, "old-key", "group-a");

    resolver.rememberRuntimeKey("new-key", "group-a");

    await expect(resolver.resolveForModel(model)).resolves.toBeUndefined();
  });
});
