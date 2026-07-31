import type { AssertionFn } from "./verify.js";

export type RunStatus =
  | "ok"
  | "timeout"
  | "assertion-failed"
  | "error"
  | "out-of-memory"
  | "output-too-large";

/**
 * A run only counts as verified when it carries `verified: true`. Every other
 * variant is a refusal, so a caller cannot treat a value as trusted without
 * first proving the run passed both the deadline and the post-condition.
 * The literal `true` / `false` on each arm makes the trust boundary visible
 * at the type level, not only as a status string.
 */
export type RunResult<T> =
  | { status: "ok"; verified: true; value: T; durationMs: number }
  | { status: "timeout"; verified: false; timeoutMs: number }
  | {
      status: "assertion-failed";
      verified: false;
      value: T;
      reason?: string;
    }
  | { status: "error"; verified: false; error: unknown }
  | {
      status: "out-of-memory";
      verified: false;
      maxOldGenerationSizeMb: number;
    }
  | {
      status: "output-too-large";
      verified: false;
      maxOutputBytes: number;
      actualBytes: number;
    };

export type Task<T> = (signal: AbortSignal) => T | Promise<T>;

/** Post-condition. A run's output is trusted only if this returns a pass. */
export type Assertion<T> = AssertionFn<T>;

export interface VerifiedRunOptions<T> {
  timeoutMs: number;
  assert: Assertion<T>;
  /** Caller-owned cancellation, merged with the internal deadline. */
  signal?: AbortSignal;
  /** Refuse values whose measured UTF-8 payload exceeds this many bytes. */
  maxOutputBytes?: number;
}

export function isVerified<T>(
  result: RunResult<T>,
): result is Extract<RunResult<T>, { verified: true }> {
  return result.verified === true;
}
