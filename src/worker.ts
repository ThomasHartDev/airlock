import { Worker } from "node:worker_threads";
import type { Assertion, RunResult } from "./contract.js";
import { checkOutputSize, validateResourceLimits } from "./limits.js";
import { createGatedRequire } from "./modules.js";

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

  grant?: Readonly<Record<string, unknown>>;

  allowedModules?: readonly string[];

  maxOldGenerationSizeMb?: number;

  maxOutputBytes?: number;
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

// worker body is a string so dist ships without a separate worker entry
const BOOTSTRAP = `
'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

(${freezeRealm.toString()})(globalThis, ${JSON.stringify(FROZEN_INTRINSICS)});
const createGatedRequire = ${createGatedRequire.toString()};

(async () => {
  try {
    const { code, grant, timeoutMs, filename, allowedModules } = workerData;
    const bindings = { ...(grant || {}) };
    if (Array.isArray(allowedModules)) {
      const hostRequire = createRequire(path.join(process.cwd(), 'airlock-worker.js'));
      bindings.require = createGatedRequire(allowedModules, hostRequire);
    }
    const context = vm.createContext(bindings);
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

export function runInWorker<T>(
  code: string,
  opts: WorkerRunOptions<T>,
): Promise<RunResult<T>> {
  const {
    timeoutMs,
    assert,
    grant,
    allowedModules,
    maxOldGenerationSizeMb,
    maxOutputBytes,
    signal,
    filename,
  } = opts;
  validateResourceLimits({
    timeoutMs,
    ...(maxOldGenerationSizeMb !== undefined ? { maxOldGenerationSizeMb } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  });

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
        allowedModules:
          allowedModules === undefined ? undefined : [...allowedModules],
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
      // terminate always: deadline, abort, OOM, and success all hard-kill isolate
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
        if (maxOutputBytes !== undefined) {
          const size = checkOutputSize(value, maxOutputBytes);
          if (size.exceeded) {
            finish({
              status: "output-too-large",
              maxOutputBytes,
              actualBytes: size.bytes,
            });
            return;
          }
        }
        void Promise.resolve(assert(value)).then(
          (passed) =>
            finish(
              passed
                ? {
                    status: "ok",
                    value,
                    durationMs: performance.now() - started,
                  }
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
