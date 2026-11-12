export const PBKDF2_ITERATIONS = 100_000;

const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      encoded += BASE64URL[(value >>> bits) & 63];
    }
  }
  if (bits > 0) encoded += BASE64URL[(value << (6 - bits)) & 63];
  return encoded;
}

function decodeBase64Url(encoded: string): Uint8Array<ArrayBuffer> | null {
  if (
    encoded.length === 0 ||
    /[^A-Za-z0-9_-]/.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    return null;
  }
  const bytes = new Uint8Array(Math.floor((encoded.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const character of encoded) {
    value = (value << 6) | BASE64URL.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (value >>> bits) & 255;
    }
  }
  // Unused trailing bits must be zero for an unpadded canonical encoding.
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return bytes;
}

async function derivePassword(
  password: string,
  iterations: number,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations, salt },
    key,
    256,
  );
  return new Uint8Array(hash);
}

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
  salt = crypto.getRandomValues(new Uint8Array(16)),
): Promise<string> {
  if (password.length > 64) {
    throw new RangeError("Password must be at most 64 characters.");
  }
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > PBKDF2_ITERATIONS
  ) {
    throw new RangeError("PBKDF2 iterations must be between 1 and 100000.");
  }
  if (salt.length === 0) throw new RangeError("Salt must not be empty.");
  const hash = await derivePassword(password, iterations, salt);
  return `pbkdf2-sha256$${iterations}$${encodeBase64Url(salt)}$${encodeBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (password.length > 64) return false;
  const fields = stored.split("$");
  if (fields.length !== 4) return false;
  const [algorithm, iterationField, saltField, hashField] = fields;
  if (
    algorithm !== "pbkdf2-sha256" ||
    !iterationField ||
    !saltField ||
    !hashField ||
    hashField.length !== 43
  ) {
    return false;
  }
  const iterations = Number(iterationField);
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > PBKDF2_ITERATIONS ||
    String(iterations) !== iterationField
  ) {
    return false;
  }
  const salt = decodeBase64Url(saltField);
  const expected = decodeBase64Url(hashField);
  if (!salt || !expected || expected.length !== 32) return false;
  const actual = await derivePassword(password, iterations, salt);
  let difference = 0;
  for (let index = 0; index < 32; index++) {
    difference |= actual[index]! ^ expected[index]!;
  }
  return difference === 0;
}
