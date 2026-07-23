import type { RunResult, Task, VerifiedRunOptions } from "./contract.js";
import { checkOutputSize, validateResourceLimits } from "./limits.js";

const DEADLINE = Symbol("deadline");

/**
 * The core airlock primitive. Runs `task` under a deadline, then checks the
 * supplied post-condition, and hands back the value only when both pass.
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
      return { status: "timeout", timeoutMs };
    }

    const value = outcome as T;
    if (maxOutputBytes !== undefined) {
      const size = checkOutputSize(value, maxOutputBytes);
      if (size.exceeded) {
        return {
          status: "output-too-large",
          maxOutputBytes,
          actualBytes: size.bytes,
        };
      }
    }

    const passed = await assert(value);
    return passed
      ? { status: "ok", value, durationMs: performance.now() - started }
      : { status: "assertion-failed", value };
  } catch (error) {
    return { status: "error", error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", relayAbort);
  }
}
