import {
  parseContextOverflowDetail,
  isContextOverflowError,
  classifyApiError,
  NvidiaApiError,
} from "../src/api/errors";
import { calculateSafetyMargin } from "../src/shared/constants";

describe("parseContextOverflowDetail", () => {
  it("extracts reportedMaximum and actualUsage from NVIDIA NIM error format", () => {
    const msg =
      "This model's maximum context length is 262144 tokens. However, your message has 524288 tokens.";
    const result = parseContextOverflowDetail(msg);
    expect(result.reportedMaximum).toBe(262144);
    expect(result.actualUsage).toBe(524288);
  });

  it("extracts from 'N > M' format", () => {
    const msg = "prompt is too long: 1048576 > 262144";
    const result = parseContextOverflowDetail(msg);
    // usageMatch second regex matches 'prompt is too long: 1048576'
    expect(result.actualUsage).toBe(1048576);
    // maxMatch doesn't match this format — reportedMaximum stays undefined
    expect(result.reportedMaximum).toBeUndefined();
  });

  it("extracts from 'maximum token' format", () => {
    const msg = "maximum token limit is 204800";
    const result = parseContextOverflowDetail(msg);
    expect(result.reportedMaximum).toBe(204800);
  });

  it("returns empty object for non-matching message", () => {
    const msg = "Something went wrong";
    const result = parseContextOverflowDetail(msg);
    expect(result.reportedMaximum).toBeUndefined();
    expect(result.actualUsage).toBeUndefined();
  });

  it("handles commas in numbers", () => {
    const msg = "This model's maximum context length is 1,048,576 tokens.";
    const result = parseContextOverflowDetail(msg);
    expect(result.reportedMaximum).toBe(1048576);
  });

  it("returns empty object for empty string", () => {
    const result = parseContextOverflowDetail("");
    expect(result.reportedMaximum).toBeUndefined();
    expect(result.actualUsage).toBeUndefined();
  });

  it("matches case-insensitively for has/had pattern", () => {
    const msg = "Your message HAS 524288 tokens";
    const result = parseContextOverflowDetail(msg);
    expect(result.actualUsage).toBe(524288);
  });

  it("extracts both limits from 'resulted in' format", () => {
    const msg =
      "This model's maximum context length is 262144 tokens. However, your messages resulted in 270981 tokens. Please reduce the length of the messages.";
    const result = parseContextOverflowDetail(msg);
    expect(result.reportedMaximum).toBe(262144);
    expect(result.actualUsage).toBe(270981);
  });

  it.each([202752, 262144, 524288, 1000000])(
    "parses 'resulted in' format for limit %i",
    (limit) => {
      const msg = `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${limit + 8837} tokens. Please reduce the length of the messages.`;
      const result = parseContextOverflowDetail(msg);
      expect(result.reportedMaximum).toBe(limit);
      expect(result.actualUsage).toBe(limit + 8837);
    },
  );

  it("ignores unrelated 400 responses without context patterns", () => {
    const msg = "Invalid value for 'temperature': must be <= 2.";
    expect(isContextOverflowError(msg)).toBe(false);
    const result = parseContextOverflowDetail(msg);
    expect(result.reportedMaximum).toBeUndefined();
    expect(result.actualUsage).toBeUndefined();
  });
});

describe("isContextOverflowError", () => {
  it("returns true for context length errors", () => {
    expect(isContextOverflowError("This model's maximum context length is 262144 tokens")).toBe(
      true,
    );
  });

  it("returns true for token limit exceeded errors", () => {
    expect(isContextOverflowError("token limit exceeded")).toBe(true);
  });

  it("returns true for prompt too long errors", () => {
    expect(isContextOverflowError("prompt is too long")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isContextOverflowError("rate limited")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  it("returns false for max_tokens parameter validation errors", () => {
    expect(
      isContextOverflowError("Invalid value for 'max_tokens': must be a positive integer."),
    ).toBe(false);
    expect(isContextOverflowError("'max_tokens' must be at most 8192 for this model.")).toBe(false);
  });

  it("returns true for explicit max-token excess phrasings", () => {
    expect(isContextOverflowError("max tokens exceeded")).toBe(true);
    expect(isContextOverflowError("maximum token limit is 204800")).toBe(true);
    expect(
      isContextOverflowError("This request exceeds the maximum number of tokens allowed."),
    ).toBe(true);
  });
});

describe("classifyApiError context overflow", () => {
  it("classifies HTTP 400 with context overflow detail as context_overflow", () => {
    const error = new Error(
      "HTTP 400 Bad Request: This model's maximum context length is 262144 tokens. However, your message has 524288 tokens.",
    );
    const classified = classifyApiError(error, {
      status: 400,
      operation: "stream",
      detail:
        "This model's maximum context length is 262144 tokens. However, your message has 524288 tokens.",
    });
    expect(classified).toBeInstanceOf(NvidiaApiError);
    expect((classified as NvidiaApiError).kind).toBe("context_overflow");
    expect((classified as NvidiaApiError).contextOverflow?.reportedMaximum).toBe(262144);
    expect((classified as NvidiaApiError).contextOverflow?.actualUsage).toBe(524288);
  });

  it("keeps HTTP 400 as invalid_request when detail is unrelated", () => {
    const error = new Error("HTTP 400 Bad Request: invalid model");
    const classified = classifyApiError(error, {
      status: 400,
      operation: "stream",
      detail: "invalid model",
    });
    expect(classified).toBeInstanceOf(NvidiaApiError);
    expect((classified as NvidiaApiError).kind).toBe("invalid_request");
  });

  it("keeps HTTP 400 max_tokens validation errors as invalid_request", () => {
    const detail = "Invalid value for 'max_tokens': must be a positive integer.";
    const classified = classifyApiError(new Error(`HTTP 400 Bad Request: ${detail}`), {
      status: 400,
      operation: "stream",
      detail,
    });
    expect(classified).toBeInstanceOf(NvidiaApiError);
    expect((classified as NvidiaApiError).kind).toBe("invalid_request");
    expect((classified as NvidiaApiError).contextOverflow).toBeUndefined();
  });

  it("classifies HTTP 429 as rate_limited", () => {
    const error = new Error("HTTP 429 Too Many Requests");
    const classified = classifyApiError(error, { status: 429 });
    expect(classified).toBeInstanceOf(NvidiaApiError);
    expect((classified as NvidiaApiError).kind).toBe("rate_limited");
  });

  it("classifies 'resulted in' format as context_overflow with correct values", () => {
    const detail =
      "This model's maximum context length is 262144 tokens. However, your messages resulted in 270981 tokens. Please reduce the length of the messages.";
    const classified = classifyApiError(new Error(`HTTP 400 Bad Request: ${detail}`), {
      status: 400,
      operation: "stream",
      detail,
    });
    expect(classified).toBeInstanceOf(NvidiaApiError);
    expect((classified as NvidiaApiError).kind).toBe("context_overflow");
    expect((classified as NvidiaApiError).contextOverflow?.reportedMaximum).toBe(262144);
    expect((classified as NvidiaApiError).contextOverflow?.actualUsage).toBe(270981);
  });
});

describe("calculateSafetyMargin", () => {
  it("returns 4096 for small context windows", () => {
    expect(calculateSafetyMargin(128000)).toBe(4096);
    expect(calculateSafetyMargin(200000)).toBe(4096);
  });

  it("returns 1% for large context windows (>=400K) where 1% exceeds 4096", () => {
    // 262144: max(4096, ceil(262144*0.01)) = max(4096, 2622) = 4096
    expect(calculateSafetyMargin(262144)).toBe(4096);
    // 500000: max(4096, ceil(500000*0.01)) = max(4096, 5000) = 5000
    expect(calculateSafetyMargin(500000)).toBe(5000);
    // 1000000: max(4096, ceil(1000000*0.01)) = max(4096, 10000) = 10000
    expect(calculateSafetyMargin(1000000)).toBe(10000);
  });

  it("never returns less than 4096", () => {
    expect(calculateSafetyMargin(128000)).toBeGreaterThanOrEqual(4096);
    expect(calculateSafetyMargin(256000)).toBeGreaterThanOrEqual(4096);
    expect(calculateSafetyMargin(400000)).toBeGreaterThanOrEqual(4096);
  });
});
