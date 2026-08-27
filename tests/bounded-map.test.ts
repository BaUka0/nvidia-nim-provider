import { BoundedMap } from "../src/shared/bounded-map";

describe("BoundedMap", () => {
  it("evicts the least recently used key on insert past capacity", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.get("a");
    map.set("c", 3);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.get("c")).toBe(3);
  });
});
