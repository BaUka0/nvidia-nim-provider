import { ContextLimitStore } from "../../src/provider/context-limit-store";

describe("ContextLimitStore", () => {
  let store: ContextLimitStore;

  beforeEach(() => {
    store = new ContextLimitStore();
  });

  it("returns undefined for unknown model", () => {
    expect(store.get("unknown-model", "fp1")).toBeUndefined();
  });

  it("round-trips set and get", () => {
    store.set("model-a", 262144, "fp1");
    expect(store.get("model-a", "fp1")).toBe(262144);
  });

  it("isolates limits by model ID", () => {
    store.set("model-a", 262144, "fp1");
    store.set("model-b", 524288, "fp1");
    expect(store.get("model-a", "fp1")).toBe(262144);
    expect(store.get("model-b", "fp1")).toBe(524288);
  });

  it("returns undefined and clears entry when key fingerprint changes", () => {
    store.set("model-a", 262144, "fp1");
    expect(store.get("model-a", "fp2")).toBeUndefined();
    expect(store.get("model-a", "fp1")).toBeUndefined();
  });

  it("overwrites previous limit for same model", () => {
    store.set("model-a", 262144, "fp1");
    store.set("model-a", 202752, "fp1");
    expect(store.get("model-a", "fp1")).toBe(202752);
  });

  it("ignores implausibly small or oversized reported limits", () => {
    store.set("model-a", 100, "fp1", 1_000_000);
    expect(store.get("model-a", "fp1")).toBeUndefined();
    store.set("model-a", 2_000_000, "fp1", 1_000_000);
    expect(store.get("model-a", "fp1")).toBeUndefined();
    store.set("model-a", 262144, "fp1", 1_000_000);
    expect(store.get("model-a", "fp1")).toBe(262144);
  });

  it("clear removes all entries", () => {
    store.set("model-a", 262144, "fp1");
    store.set("model-b", 524288, "fp1");
    store.clear();
    expect(store.get("model-a", "fp1")).toBeUndefined();
    expect(store.get("model-b", "fp1")).toBeUndefined();
  });
});
