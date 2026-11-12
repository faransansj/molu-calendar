import { beforeAll, describe, expect, test } from "vitest";
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from "./password.ts";

const password = "만마전";
let stored: string;

beforeAll(async () => {
  stored = await hashPassword(password);
});

describe("password hashing", () => {
  test("round trips with the default workerd-compatible iteration count", async () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(stored).toMatch(
      /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    );
    await expect(verifyPassword(password, stored)).resolves.toBe(true);
  });

  test("rejects a wrong password", async () => {
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  test("normalizes both hashing and verification to NFC", async () => {
    await expect(
      verifyPassword(password.normalize("NFD"), stored),
    ).resolves.toBe(true);
    const salt = new Uint8Array(16).fill(255);
    await expect(
      hashPassword(password.normalize("NFD"), 1, salt),
    ).resolves.toBe(await hashPassword(password, 1, salt));
  });

  test("supports explicit salt and iteration count", async () => {
    const hash = await hashPassword(password, 1, new Uint8Array(16));
    expect(hash).toMatch(/^pbkdf2-sha256\$1\$AAAAAAAAAAAAAAAAAAAAAA\$/);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
  });

  test("generates a fresh salt for each hash", async () => {
    const first = await hashPassword(password, 1);
    const second = await hashPassword(password, 1);
    expect(first.split("$")[2]).not.toBe(second.split("$")[2]);
  });

  test("rejects passwords longer than 64 characters", async () => {
    await expect(verifyPassword("a".repeat(65), stored)).resolves.toBe(false);
    await expect(hashPassword("a".repeat(65), 1)).rejects.toThrow(RangeError);
    const longest = "a".repeat(64);
    const hash = await hashPassword(longest, 1);
    await expect(verifyPassword(longest, hash)).resolves.toBe(true);
  });

  test.each([0, -1, 1.5, 100_001, NaN, Infinity])(
    "rejects invalid hashing iteration count %s",
    async (iterations) => {
      await expect(hashPassword(password, iterations)).rejects.toThrow(
        RangeError,
      );
    },
  );

  test("rejects an empty hashing salt", async () => {
    await expect(hashPassword(password, 1, new Uint8Array(0))).rejects.toThrow(
      RangeError,
    );
  });
});

describe("stored password validation", () => {
  test.each(["", "not a hash", "pbkdf2-sha256$100000", "$$$"])(
    "rejects malformed stored value %j",
    async (value) => {
      await expect(verifyPassword(password, value)).resolves.toBe(false);
    },
  );

  test.each([
    "0",
    "-1",
    "100001",
    "1.5",
    "1e5",
    "01",
    "+1",
    "",
    "Infinity",
    "100000\n",
  ])(
    "rejects malformed or out-of-range stored iteration count %j",
    async (iterations) => {
      const fields = stored.split("$");
      fields[1] = iterations;
      await expect(verifyPassword(password, fields.join("$"))).resolves.toBe(
        false,
      );
    },
  );

  test.each(["", "A", "AB", "AA=", "AA+", "AA/", "A A", "AAA\n"])(
    "rejects invalid or noncanonical base64url salt %j",
    async (salt) => {
      const fields = stored.split("$");
      fields[2] = salt;
      await expect(verifyPassword(password, fields.join("$"))).resolves.toBe(
        false,
      );
    },
  );

  test.each(["", "AA", "A".repeat(42), "A".repeat(44), "_".repeat(43)])(
    "rejects invalid hash encoding or byte length %j",
    async (hash) => {
      const fields = stored.split("$");
      fields[3] = hash;
      await expect(verifyPassword(password, fields.join("$"))).resolves.toBe(
        false,
      );
    },
  );

  test("rejects other algorithms and extra fields", async () => {
    await expect(
      verifyPassword(password, stored.replace("pbkdf2-sha256", "pbkdf2-sha1")),
    ).resolves.toBe(false);
    await expect(verifyPassword(password, `${stored}$extra`)).resolves.toBe(
      false,
    );
  });
});
