import type { RunResult, Task, VerifiedRunOptions } from "./contract.js";
import { checkOutputSize, validateResourceLimits } from "./limits.js";
import { selfVerify } from "./verify.js";

const DEADLINE = Symbol("deadline");

/**
 * The core airlock primitive. Runs `task` under a deadline, then self-verifies
 * the produced value with the supplied post-condition, and hands back
 * `verified: true` only when both the deadline and the assertion pass.
 *
 * The deadline is enforced by racing an internal timer and aborting the signal
 * the task receives. That stops async and cooperative work, but a task that
 * blocks the event loop with a synchronous spin cannot be interrupted here;
 * true preemption is the job of the isolate and container tiers built on top
 * of this contract.
 */
export async function runVerified<T>(
  task: Task<T>,
  opts: VerifiedRunOptions<T>,
): Promise<RunResult<T>> {
  const { timeoutMs, assert, signal, maxOutputBytes } = opts;
  validateResourceLimits({
    timeoutMs,
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  });

  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", relayAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
      resolve(DEADLINE);
    }, timeoutMs);
  });

  const started = performance.now();
  const running = Promise.resolve().then(() => task(controller.signal));
  // A task that loses the race still settles; swallow late rejections so they
  // don't surface as unhandled once we've already returned a timeout.
  running.catch(() => {});

  try {
    const outcome = await Promise.race([running, deadline]);
    if (outcome === DEADLINE) {
      return { status: "timeout", verified: false, timeoutMs };
    }

    const value = outcome as T;
    if (maxOutputBytes !== undefined) {
      const size = checkOutputSize(value, maxOutputBytes);
      if (size.exceeded) {
        return {
          status: "output-too-large",
          verified: false,
          maxOutputBytes,
          actualBytes: size.bytes,
        };
      }
    }

    const check = await selfVerify(value, assert);
    if (check.verified) {
      return {
        status: "ok",
        verified: true,
        value: check.value,
        durationMs: performance.now() - started,
      };
    }
    return check.reason !== undefined
      ? {
          status: "assertion-failed",
          verified: false,
          value: check.value,
          reason: check.reason,
        }
      : { status: "assertion-failed", verified: false, value: check.value };
  } catch (error) {
    return { status: "error", verified: false, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", relayAbort);
  }
}
