import {
  estimateNimMessagesTokensByCategory,
  IMAGE_TOKEN_CAP,
  IMAGE_TOKEN_FLOOR,
  IMAGE_UNKNOWN_SIZE_TOKENS,
  MESSAGE_OVERHEAD_TOKENS,
  readImageSize,
} from "../src/messages/token-estimate";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([...Buffer.from("GIF89a")]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...new Array(12).fill(0)]);
}

function webp(chunk: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([...Buffer.from("RIFF")]);
  bytes.set([...Buffer.from("WEBP")], 8);
  bytes.set([...Buffer.from(chunk)], 12);
  const w = width - 1;
  const h = height - 1;
  if (chunk === "VP8X") {
    bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
    bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  } else if (chunk === "VP8L") {
    bytes[20] = 0x2f;
    bytes.set(
      [w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f],
      21,
    );
  } else {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    new DataView(bytes.buffer).setUint16(26, width, true);
    new DataView(bytes.buffer).setUint16(28, height, true);
  }
  return bytes;
}

function imageMessageTokens(data: Uint8Array): number {
  const url = `data:image/png;base64,${Buffer.from(data).toString("base64")}`;
  return estimateNimMessagesTokensByCategory([
    { role: "user", content: [{ type: "image_url", image_url: { url } }] },
  ]).images;
}

describe("readImageSize", () => {
  it.each([
    ["PNG", png(1130, 317)],
    ["GIF", gif(1130, 317)],
    ["JPEG", jpeg(1130, 317)],
    ["WebP VP8X", webp("VP8X", 1130, 317)],
    ["WebP VP8L", webp("VP8L", 1130, 317)],
    ["WebP VP8", webp("VP8 ", 1130, 317)],
  ])("reads %s dimensions", (_format, data) => {
    expect(readImageSize(data)).toEqual({ width: 1130, height: 317 });
  });

  it("returns undefined for unknown or truncated data", () => {
    expect(readImageSize(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
    expect(readImageSize(png(100, 100).slice(0, 20))).toBeUndefined();
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeUndefined();
  });
});

describe("image token estimate", () => {
  it("charges 28 px patches, matching NIM's count for a 1920x1080 screenshot", () => {
    // ceil(1920/28) * ceil(1080/28) + 2 = 69 * 39 + 2, as GLM 5.3 Flash and Muse Glimmer report.
    expect(imageMessageTokens(png(1920, 1080))).toBe(2693);
  });

  it("ignores payload size: same dimensions cost the same", () => {
    const small = png(512, 512);
    const large = new Uint8Array(200_000);
    large.set(small);
    expect(imageMessageTokens(large)).toBe(imageMessageTokens(small));
  });

  it("applies the per-image floor and cap", () => {
    expect(imageMessageTokens(png(64, 64))).toBe(IMAGE_TOKEN_FLOOR);
    expect(imageMessageTokens(png(8000, 8000))).toBe(IMAGE_TOKEN_CAP);
  });

  it("charges an unreadable image as a 1080p screenshot", () => {
    expect(imageMessageTokens(new Uint8Array(5000))).toBe(IMAGE_UNKNOWN_SIZE_TOKENS);
    expect(IMAGE_UNKNOWN_SIZE_TOKENS).toBe(2693);
  });

  it("finds a JPEG frame header behind more than 64 KB of metadata", () => {
    const segment = [0xff, 0xe1, 0xff, 0xf0, ...new Array(0xfff0 - 2).fill(0)];
    const plain = jpeg(1024, 1024);
    const withMetadata = new Uint8Array([0xff, 0xd8, ...segment, ...segment, ...plain.slice(2)]);
    // 37 * 37 + 2; distinct from the unknown-size fallback.
    expect(imageMessageTokens(withMetadata)).toBe(1371);
  });
});

describe("message overhead", () => {
  it("adds template tokens to each message's category", () => {
    const breakdown = estimateNimMessagesTokensByCategory([
      { role: "system", content: "" },
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ]);
    expect(breakdown.system).toBe(MESSAGE_OVERHEAD_TOKENS);
    expect(breakdown.user).toBe(MESSAGE_OVERHEAD_TOKENS);
    expect(breakdown.assistant).toBe(MESSAGE_OVERHEAD_TOKENS);
  });
});
