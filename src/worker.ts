import { Worker } from "node:worker_threads";
import type { Assertion, RunResult } from "./contract.js";

/**
 * Intrinsics whose prototypes a sandbox escape could otherwise repave to attack
 * later runs sharing the isolate. Frozen in the worker realm before any
 * untrusted code runs, so an escape lands in a realm it cannot mutate.
 */
export const FROZEN_INTRINSICS: readonly string[] = [
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Error",
  "Promise",
  "RegExp",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "JSON",
  "Math",
  "Reflect",
];

/** Freeze each named intrinsic, its prototype, and the realm root itself. */
export function freezeRealm(
  root: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names) {
    const intrinsic = root[name];
    if (
      typeof intrinsic === "function" ||
      (typeof intrinsic === "object" && intrinsic !== null)
    ) {
      Object.freeze(intrinsic);
      const proto = (intrinsic as { prototype?: unknown }).prototype;
      if (proto) Object.freeze(proto);
    }
  }
  Object.freeze(root);
}

export interface WorkerRunOptions<T> {
  timeoutMs: number;
  assert: Assertion<T>;
  /** Structured-cloneable capabilities only; live functions can't cross the thread boundary. */
  grant?: Readonly<Record<string, unknown>>;
  /** Hard cap on the isolate's V8 old-space. Exceeding it kills the worker. */
  maxOldGenerationSizeMb?: number;
  signal?: AbortSignal;
  filename?: string;
}

interface WorkerOk {
  ok: true;
  value: unknown;
}
interface WorkerErr {
  ok: false;
  error: { name?: string; message?: string; stack?: string; code?: string };
}
type WorkerMessage = WorkerOk | WorkerErr;

const SYNC_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";
const OOM_CODE = "ERR_WORKER_OUT_OF_MEMORY";

// The worker body is a string so a single build artifact ships without a
// separate worker entry file, and so tests exercise the same code as dist.
// freezeRealm is injected by source and applied to the worker's own globals.
const BOOTSTRAP = `
'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const vm = require('node:vm');

(${freezeRealm.toString()})(globalThis, ${JSON.stringify(FROZEN_INTRINSICS)});

(async () => {
  try {
    const { code, grant, timeoutMs, filename } = workerData;
    const context = vm.createContext({ ...(grant || {}) });
    const script = new vm.Script(code, { filename });
    const value = await script.runInContext(context, { timeout: timeoutMs });
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: error && error.name,
        message: error && error.message,
        stack: error && error.stack,
        code: error && error.code,
      },
    });
  }
})();
`;

/**
 * Run untrusted source in a worker_threads isolate: a separate V8 heap on a
 * separate OS thread, started with an empty `process.env` and frozen globals,
 * then gated through the deadline and post-condition contract.
 *
 * This is the stronger sibling of the in-process {@link run}. It closes the
 * pinned in-process gap where `this.constructor.constructor` reaches the host
 * realm: here an escape from the `vm` context reaches only the WORKER's realm,
 * whose `process.env` is empty and whose globals are frozen. The thread is
 * hard-killed on the deadline, so a synchronous spin AND an async task that
 * never settles are both preempted, not merely abandoned. A caller-supplied
 * `maxOldGenerationSizeMb` caps the heap and reports `out-of-memory` when hit.
 *
 * The tradeoff for real thread isolation: the `grant` and the returned value
 * cross by structured clone, so live function capabilities can't be handed in
 * and non-cloneable outputs come back as an `error`.
 */
export function runInWorker<T>(
  code: string,
  opts: WorkerRunOptions<T>,
): Promise<RunResult<T>> {
  const { timeoutMs, assert, grant, maxOldGenerationSizeMb, signal, filename } =
    opts;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive, finite number");
  }

  let worker: Worker;
  try {
    worker = new Worker(BOOTSTRAP, {
      eval: true,
      env: {},
      workerData: {
        code,
        grant: grant ?? {},
        timeoutMs,
        filename: filename ?? "airlock-worker.js",
      },
      ...(maxOldGenerationSizeMb !== undefined
        ? { resourceLimits: { maxOldGenerationSizeMb } }
        : {}),
    });
  } catch (error) {
    // A non-cloneable grant (e.g. a function) fails at construction.
    return Promise.resolve({ status: "error", error });
  }

  const started = performance.now();

  return new Promise<RunResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: RunResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: "timeout", timeoutMs });
    }, timeoutMs);

    const onAbort = () => {
      finish({ status: "error", error: signal?.reason });
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    worker.on("message", (msg: WorkerMessage) => {
      if (settled) return;
      if (msg.ok) {
        clearTimeout(timer);
        const value = msg.value as T;
        void Promise.resolve(assert(value)).then(
          (passed) =>
            finish(
              passed
                ? { status: "ok", value, durationMs: performance.now() - started }
                : { status: "assertion-failed", value },
            ),
          (error) => finish({ status: "error", error }),
        );
        return;
      }
      if (msg.error.code === SYNC_TIMEOUT_CODE) {
        finish({ status: "timeout", timeoutMs });
        return;
      }
      finish({ status: "error", error: reviveError(msg.error) });
    });

    worker.on("error", (error: Error & { code?: string }) => {
      if (error.code === OOM_CODE) {
        finish({
          status: "out-of-memory",
          maxOldGenerationSizeMb: maxOldGenerationSizeMb ?? 0,
        });
        return;
      }
      finish({ status: "error", error });
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        finish({
          status: "error",
          error: new Error(`worker exited with code ${code}`),
        });
      }
    });
  });
}

function reviveError(shape: WorkerErr["error"]): Error {
  const error = new Error(shape.message ?? "worker error");
  if (shape.name) error.name = shape.name;
  if (shape.stack) error.stack = shape.stack;
  if (shape.code) (error as Error & { code?: string }).code = shape.code;
  return error;
}
