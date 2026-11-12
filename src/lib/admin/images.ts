export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface SniffedImage {
  type: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 256 + bytes[offset + 1]!;
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return uint16be(bytes, offset) * 65536 + uint16be(bytes, offset + 2);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return uint24le(bytes, offset) + bytes[offset + 3]! * 16777216;
}

function matches(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function dimensions(
  type: SniffedImage["type"],
  ext: SniffedImage["ext"],
  width: number,
  height: number,
): SniffedImage | null {
  if (width < 16 || width > 8192 || height < 16 || height > 8192) {
    return null;
  }
  return { type, ext, width, height };
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | null {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    // Dimensions must precede the scan data; stuffed bytes are not markers.
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = uint16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return null;
      const components = bytes[offset + 7]!;
      if (components === 0 || length !== 8 + components * 3) return null;
      return dimensions(
        "image/jpeg",
        "jpg",
        uint16be(bytes, offset + 5),
        uint16be(bytes, offset + 3),
      );
    }
    offset += length;
  }
  return null;
}

function sniffWebp(bytes: Uint8Array): SniffedImage | null {
  const end = uint32le(bytes, 4) + 8;
  if (end < 12 || end > bytes.length) return null;
  let offset = 12;
  while (offset + 8 <= end) {
    const length = uint32le(bytes, offset + 4);
    const payload = offset + 8;
    const next = payload + length + (length % 2);
    if (next > end) return null;
    if (matches(bytes, offset, "VP8X")) {
      if (length !== 10) return null;
      return dimensions(
        "image/webp",
        "webp",
        uint24le(bytes, payload + 4) + 1,
        uint24le(bytes, payload + 7) + 1,
      );
    }
    if (matches(bytes, offset, "VP8L")) {
      if (
        length < 5 ||
        bytes[payload] !== 0x2f ||
        (bytes[payload + 4]! & 0xe0) !== 0
      ) {
        return null;
      }
      const bits = uint32le(bytes, payload + 1);
      return dimensions(
        "image/webp",
        "webp",
        (bits & 0x3fff) + 1,
        ((bits >>> 14) & 0x3fff) + 1,
      );
    }
    if (matches(bytes, offset, "VP8 ")) {
      if (
        length < 10 ||
        (bytes[payload]! & 1) !== 0 ||
        !matches(bytes, payload + 3, "\x9d\x01\x2a")
      ) {
        return null;
      }
      return dimensions(
        "image/webp",
        "webp",
        (bytes[payload + 6]! + bytes[payload + 7]! * 256) & 0x3fff,
        (bytes[payload + 8]! + bytes[payload + 9]! * 256) & 0x3fff,
      );
    }
    offset = next;
  }
  return null;
}

// This inspects complete dimension headers, not compressed pixel data or CRCs.
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (matches(bytes, 0, "\x89PNG\r\n\x1a\n")) {
    // Include the entire 13-byte IHDR payload and its four-byte CRC.
    if (
      bytes.length < 33 ||
      uint32be(bytes, 8) !== 13 ||
      !matches(bytes, 12, "IHDR")
    ) {
      return null;
    }
    return dimensions(
      "image/png",
      "png",
      uint32be(bytes, 16),
      uint32be(bytes, 20),
    );
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return sniffJpeg(bytes);
  }
  if (matches(bytes, 0, "RIFF") && matches(bytes, 8, "WEBP")) {
    return sniffWebp(bytes);
  }
  return null;
}
