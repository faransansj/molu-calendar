export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_IP_FAILURES = 5;
export const MAX_GLOBAL_FAILURES = 50;

function oldestFailure(failures: number[]): number {
  let oldest = Infinity;
  for (const timestamp of failures) oldest = Math.min(oldest, timestamp);
  return oldest;
}

export function loginDecision(
  ipFailures: number[],
  globalFailures: number[],
  now: number,
):
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfter: number } {
  const ipBlocked = ipFailures.length >= MAX_IP_FAILURES;
  const globalBlocked = globalFailures.length >= MAX_GLOBAL_FAILURES;
  if (!ipBlocked && !globalBlocked) {
    return { allowed: true, remaining: MAX_IP_FAILURES - ipFailures.length };
  }
  const retryAt = Math.max(
    ipBlocked ? oldestFailure(ipFailures) + LOGIN_WINDOW_MS : now,
    globalBlocked ? oldestFailure(globalFailures) + LOGIN_WINDOW_MS : now,
  );
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)),
  };
}
