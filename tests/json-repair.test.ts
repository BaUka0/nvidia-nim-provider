import { MAX_JSON_REPAIR_CHARS } from "../src/shared/constants";
import {
  parseJsonObjectOrRepair,
  parseJsonOrRepair,
  tryParseJsonOrRepair,
} from "../src/shared/json-repair";

describe("parseJsonOrRepair", () => {
  it("parses strict JSON without repair", () => {
    expect(parseJsonOrRepair('{"a":1}')).toEqual({ a: 1 });
  });

  it("repairs slightly invalid JSON", () => {
    expect(parseJsonOrRepair("{a:1}")).toEqual({ a: 1 });
  });

  it("refuses to repair oversized payloads", () => {
    const huge = `{${"a".repeat(MAX_JSON_REPAIR_CHARS)}`;
    expect(() => parseJsonOrRepair(huge)).toThrow(/repair limit/);
    expect(tryParseJsonOrRepair(huge)).toBe(huge);
  });

  it("parseJsonObjectOrRepair rejects arrays", () => {
    expect(() => parseJsonObjectOrRepair("[1]")).toThrow(/JSON object/);
  });
});
