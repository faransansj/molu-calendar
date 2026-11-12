import { describe, expect, test } from "vitest";
import {
  LOGIN_WINDOW_MS,
  loginDecision,
  MAX_GLOBAL_FAILURES,
  MAX_IP_FAILURES,
} from "./limits.ts";

const now = 1_800_000;

describe("login limits", () => {
  test("uses a fifteen-minute window with five IP and fifty global failures", () => {
    expect(LOGIN_WINDOW_MS).toBe(15 * 60_000);
    expect(MAX_IP_FAILURES).toBe(5);
    expect(MAX_GLOBAL_FAILURES).toBe(50);
    expect(loginDecision([], [], now)).toEqual({ allowed: true, remaining: 5 });
  });

  test("allows four failures with one remaining attempt", () => {
    const failures = [now - 4000, now - 3000, now - 2000, now - 1000];
    expect(loginDecision(failures, failures, now)).toEqual({
      allowed: true,
      remaining: 1,
    });
  });

  test("blocks five failures using the oldest relevant failure and ceiling", () => {
    const failures = [now - 1000, now - 60_001, now, now - 2000, now - 3000];
    expect(loginDecision(failures, failures, now)).toEqual({
      allowed: false,
      retryAfter: 840,
    });
  });

  test("blocks a new IP after fifty global failures", () => {
    const failures = Array.from(
      { length: 50 },
      (_, index) => now - 120_000 + index,
    );
    expect(loginDecision([], failures, now)).toEqual({
      allowed: false,
      retryAfter: 780,
    });
  });

  test("allows a new IP before the global threshold", () => {
    expect(loginDecision([], Array<number>(49).fill(now), now)).toEqual({
      allowed: true,
      remaining: 5,
    });
  });

  test("uses the later retry when both buckets are blocked", () => {
    const ipFailures = Array<number>(5).fill(now - 180_000);
    const globalFailures = Array<number>(50).fill(now - 60_000);
    expect(loginDecision(ipFailures, globalFailures, now)).toEqual({
      allowed: false,
      retryAfter: 840,
    });
    expect(
      loginDecision(
        globalFailures.slice(0, 5),
        ipFailures.concat(Array<number>(45).fill(now)),
        now,
      ),
    ).toEqual({ allowed: false, retryAfter: 840 });
  });

  test("returns at least one second at the window boundary", () => {
    const failures = Array<number>(5).fill(now - LOGIN_WINDOW_MS);
    expect(loginDecision(failures, failures, now)).toEqual({
      allowed: false,
      retryAfter: 1,
    });
  });

  test("does not mutate failure timestamps", () => {
    const ipFailures = [now, now - 1, now - 3, now - 2, now - 4];
    const globalFailures = [...ipFailures];
    const original = [...ipFailures];
    loginDecision(ipFailures, globalFailures, now);
    expect(ipFailures).toEqual(original);
    expect(globalFailures).toEqual(original);
  });
});
