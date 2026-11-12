import { describe, expect, test } from "vitest";
import { MAX_UPLOAD_BYTES, sniffImage } from "./images.ts";

describe("sniffImage", () => {
  test("exposes the five MiB upload limit", () => {
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  });

  test("reads a PNG IHDR without depending on a filename or MIME type", () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52, 0, 0, 2, 128, 0, 0, 1, 104, 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(sniffImage(bytes)).toEqual({
      type: "image/png",
      ext: "png",
      width: 640,
      height: 360,
    });
    for (let length = 0; length < bytes.length; length++) {
      expect(sniffImage(bytes.subarray(0, length))).toBeNull();
    }
    bytes[12] = 0x49;
    bytes[13] = 0x44;
    expect(sniffImage(bytes)).toBeNull();
    bytes[13] = 0x48;
    bytes[11] = 12;
    expect(sniffImage(bytes)).toBeNull();
  });

  test.each([0xc0, 0xc1, 0xc2])("reads JPEG SOF marker %i", (marker) => {
    const bytes = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      4,
      0,
      0,
      0xff,
      0xff,
      marker,
      0,
      11,
      8,
      1,
      104,
      2,
      128,
      1,
      1,
      0x11,
      0,
    ]);
    expect(sniffImage(bytes)).toEqual({
      type: "image/jpeg",
      ext: "jpg",
      width: 640,
      height: 360,
    });
    for (let length = 0; length < bytes.length; length++) {
      expect(sniffImage(bytes.subarray(0, length))).toBeNull();
    }
  });

  test("rejects broken JPEG segment lengths and missing supported frames", () => {
    for (const bytes of [
      [0xff, 0xd8, 0xff, 0xe0, 0, 1],
      [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff],
      [0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 1, 104, 2, 128, 1],
      [0xff, 0xd8, 0xff, 0xc3, 0, 11, 8, 1, 104, 2, 128, 1, 1, 17, 0],
      [0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xc0],
      [0xff, 0xd8, 0xff, 0xd9],
      [0xff, 0xd8, 0xff, 0],
    ]) {
      expect(sniffImage(new Uint8Array(bytes))).toBeNull();
    }
  });

  test("reads a WebP VP8X canvas and rejects every truncated header", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
      0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 127, 2, 0, 103, 1, 0,
    ]);
    expect(sniffImage(bytes)).toEqual({
      type: "image/webp",
      ext: "webp",
      width: 640,
      height: 360,
    });
    for (let length = 0; length < bytes.length; length++) {
      expect(sniffImage(bytes.subarray(0, length))).toBeNull();
    }
    bytes[16] = 9;
    expect(sniffImage(bytes)).toBeNull();
    bytes[16] = 11;
    expect(sniffImage(bytes)).toBeNull();
  });

  test("reads a WebP VP8 keyframe and masks its scaling bits", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
      0x38, 0x20, 10, 0, 0, 0, 0x10, 0, 0, 0x9d, 0x01, 0x2a, 128, 0xc2, 104,
      0x81,
    ]);
    expect(sniffImage(bytes)).toEqual({
      type: "image/webp",
      ext: "webp",
      width: 640,
      height: 360,
    });
    bytes[20] = 1;
    expect(sniffImage(bytes)).toBeNull();
    bytes[20] = 0x10;
    bytes[23] = 0;
    expect(sniffImage(bytes)).toBeNull();
  });

  test("reads packed WebP VP8L dimensions after a padded unknown chunk", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 28, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x4a, 0x55,
      0x4e, 0x4b, 1, 0, 0, 0, 42, 0, 0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f,
      0x7f, 0xc2, 0x59, 0x10, 0,
    ]);
    expect(sniffImage(bytes)).toEqual({
      type: "image/webp",
      ext: "webp",
      width: 640,
      height: 360,
    });
    bytes[34] = 0x30;
    expect(sniffImage(bytes)).toBeNull();
    bytes[34] = 0x10;
    bytes[30] = 0;
    expect(sniffImage(bytes)).toBeNull();
  });

  test.each([
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "GIF89a",
    "<!doctype html><html></html>",
    "RIFF\u0004\u0000\u0000\u0000WAVE",
    "",
  ])("rejects unsupported content %j", (text) => {
    expect(sniffImage(new TextEncoder().encode(text))).toBeNull();
  });

  test.each<[number, number, boolean]>([
    [16, 16, true],
    [8192, 8192, true],
    [15, 360, false],
    [640, 15, false],
    [8193, 360, false],
    [640, 8193, false],
    [0, 360, false],
    [0xffffffff, 360, false],
  ])("checks dimensions %i × %i across formats", (width, height, valid) => {
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      0x49,
      0x48,
      0x44,
      0x52,
      width >>> 24,
      (width >>> 16) & 255,
      (width >>> 8) & 255,
      width & 255,
      height >>> 24,
      (height >>> 16) & 255,
      (height >>> 8) & 255,
      height & 255,
      8,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0,
      11,
      8,
      height >>> 8,
      height & 255,
      width >>> 8,
      width & 255,
      1,
      1,
      17,
      0,
    ]);
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      22,
      0,
      0,
      0,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x58,
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      (width - 1) & 255,
      ((width - 1) >>> 8) & 255,
      ((width - 1) >>> 16) & 255,
      (height - 1) & 255,
      ((height - 1) >>> 8) & 255,
      ((height - 1) >>> 16) & 255,
    ]);
    for (const bytes of [png, jpeg, webp]) {
      const result = sniffImage(bytes);
      if (valid) {
        expect(result).toMatchObject({ width, height });
      } else {
        expect(result).toBeNull();
      }
    }
  });
});
