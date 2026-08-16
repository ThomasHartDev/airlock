/**
 * Self-verification is a separate phase from execution: take a produced value
 * and a caller-supplied post-condition, and tag the value as trusted only when
 * the assertion holds. Execution tiers (vm, worker, later Docker) hand results
 * here; this module never runs untrusted code itself.
 */

export type AssertOutcome =
  | boolean
  | { pass: true }
  | { pass: false; reason?: string };

export type AssertionFn<T> = (
  value: T,
) => AssertOutcome | Promise<AssertOutcome>;

export type VerifyResult<T> =
  | { verified: true; value: T }
  | { verified: false; value: T; reason?: string };

export function normalizeAssertOutcome(outcome: AssertOutcome): {
  passed: boolean;
  reason?: string;
} {
  if (typeof outcome === "boolean") {
    return { passed: outcome };
  }
  if (outcome.pass) {
    return { passed: true };
  }
  return outcome.reason !== undefined
    ? { passed: false, reason: outcome.reason }
    : { passed: false };
}

/**
 * Pure post-condition check. `verified: true` is returned only when the
 * assertion resolves to a passing outcome; every other result is untrusted.
 */
export async function selfVerify<T>(
  value: T,
  assert: AssertionFn<T>,
): Promise<VerifyResult<T>> {
  const outcome = await assert(value);
  const { passed, reason } = normalizeAssertOutcome(outcome);
  if (passed) {
    return { verified: true, value };
  }
  return reason !== undefined
    ? { verified: false, value, reason }
    : { verified: false, value };
}

/** Conjoin assertions: every one must pass for the value to be trusted. */
export function allAssertions<T>(
  ...asserts: readonly AssertionFn<T>[]
): AssertionFn<T> {
  return async (value) => {
    for (const assert of asserts) {
      const { passed, reason } = normalizeAssertOutcome(await assert(value));
      if (!passed) {
        return reason !== undefined
          ? { pass: false, reason }
          : { pass: false };
      }
    }
    return { pass: true };
  };
}

/** Disjoin assertions: one passing check is enough. */
export function anyAssertion<T>(
  ...asserts: readonly AssertionFn<T>[]
): AssertionFn<T> {
  return async (value) => {
    let lastReason: string | undefined;
    for (const assert of asserts) {
      const { passed, reason } = normalizeAssertOutcome(await assert(value));
      if (passed) return { pass: true };
      if (reason !== undefined) lastReason = reason;
    }
    return lastReason !== undefined
      ? { pass: false, reason: lastReason }
      : { pass: false };
  };
}
