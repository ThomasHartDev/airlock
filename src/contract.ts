export type RunStatus =
  | "ok"
  | "timeout"
  | "assertion-failed"
  | "error"
  | "out-of-memory"
  | "output-too-large";

export type RunResult<T> =
  | { status: "ok"; value: T; durationMs: number }
  | { status: "timeout"; timeoutMs: number }
  | { status: "assertion-failed"; value: T }
  | { status: "error"; error: unknown }
  | { status: "out-of-memory"; maxOldGenerationSizeMb: number }
  | { status: "output-too-large"; maxOutputBytes: number; actualBytes: number };

export type Task<T> = (signal: AbortSignal) => T | Promise<T>;

export type Assertion<T> = (value: T) => boolean | Promise<boolean>;

export interface VerifiedRunOptions<T> {
  timeoutMs: number;
  assert: Assertion<T>;

  signal?: AbortSignal;

  maxOutputBytes?: number;
}

export function isVerified<T>(
  result: RunResult<T>,
): result is Extract<RunResult<T>, { status: "ok" }> {
  return result.status === "ok";
}
