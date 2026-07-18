export type RunStatus = "ok" | "timeout" | "assertion-failed" | "error";

/**
 * A run only counts as verified when it carries `status: "ok"`. Every other
 * variant is a refusal, so a caller cannot read `value` without first proving
 * the run passed both the deadline and the post-condition.
 */
export type RunResult<T> =
  | { status: "ok"; value: T; durationMs: number }
  | { status: "timeout"; timeoutMs: number }
  | { status: "assertion-failed"; value: T }
  | { status: "error"; error: unknown };

export type Task<T> = (signal: AbortSignal) => T | Promise<T>;

/** Post-condition. A run's output is trusted only if this returns true. */
export type Assertion<T> = (value: T) => boolean | Promise<boolean>;

export interface VerifiedRunOptions<T> {
  timeoutMs: number;
  assert: Assertion<T>;
  /** Caller-owned cancellation, merged with the internal deadline. */
  signal?: AbortSignal;
}

export function isVerified<T>(
  result: RunResult<T>,
): result is Extract<RunResult<T>, { status: "ok" }> {
  return result.status === "ok";
}
