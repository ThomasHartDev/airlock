import type { RunResult, Task, VerifiedRunOptions } from "./contract.js";
import { checkOutputSize, validateResourceLimits } from "./limits.js";

const DEADLINE = Symbol("deadline");

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
  // swallow late rejections after timeout so they are not unhandled
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
