import * as vm from "node:vm";
import type { Assertion, RunResult } from "./contract.js";
import { runVerified } from "./run.js";

/**
 * Ambient authority the host process carries that untrusted code must never
 * reach unless the caller hands it in explicitly. This list is the machine
 * form of the zero-credential invariant: with an empty grant, every one of
 * these must be unbound inside the context.
 */
const AMBIENT_AUTHORITY = [
  "process",
  "require",
  "module",
  "global",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Buffer",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "__dirname",
  "__filename",
] as const;

export const DENIED_AMBIENT_NAMES: readonly string[] = AMBIENT_AUTHORITY;

export interface SandboxRunOptions<T> {
  timeoutMs: number;
  assert: Assertion<T>;
  /** Capabilities the caller chooses to hand in. This is the only authority the code gets. */
  grant?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  filename?: string;
}

export class ZeroCredentialViolation extends Error {
  readonly leaked: readonly string[];
  constructor(leaked: readonly string[]) {
    super(
      `zero-credential invariant violated: ${leaked.join(
        ", ",
      )} reachable without an explicit grant`,
    );
    this.name = "ZeroCredentialViolation";
    this.leaked = leaked;
  }
}

const SYNC_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";

/**
 * Returns the ambient names that resolve to something bound inside `context`
 * and were not part of the grant. A clean context returns an empty array; a
 * non-empty result means authority leaked in and the run must be refused.
 */
export function probeAmbientAuthority(
  context: vm.Context,
  granted: readonly string[],
): string[] {
  const granting = new Set(granted);
  const leaked: string[] = [];
  for (const name of AMBIENT_AUTHORITY) {
    if (granting.has(name)) continue;
    if (vm.runInContext(`typeof ${name}`, context) !== "undefined") {
      leaked.push(name);
    }
  }
  return leaked;
}

/**
 * Run untrusted source in a fresh V8 context with no ambient authority, then
 * gate the result through the deadline and post-condition contract. The value
 * comes back only as `{ status: "ok" }`, same as {@link runVerified}.
 *
 * Two independent deadline enforcers compose here: V8's own `timeout` preempts
 * a synchronous spin that would otherwise wedge the event loop, and the
 * async deadline in `runVerified` aborts a task that hangs on an unresolved
 * promise. Neither alone covers both cases.
 *
 * This in-process tier denies *direct* ambient access (`process`, `require`,
 * `fetch`, timers) and fails closed if any leaks in. It is not an escape-proof
 * boundary: `this.constructor.constructor` still reaches the host realm's
 * `Function` because the context's global borrows the host `Object`. Closing
 * that is the job of the isolate and container tiers; see the escape-attempt
 * tests for the pinned gap.
 */
export async function run<T>(
  code: string,
  opts: SandboxRunOptions<T>,
): Promise<RunResult<T>> {
  const { timeoutMs, assert, grant, signal, filename } = opts;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive, finite number");
  }

  const context = vm.createContext({ ...(grant ?? {}) });
  const leaked = probeAmbientAuthority(context, Object.keys(grant ?? {}));
  if (leaked.length > 0) throw new ZeroCredentialViolation(leaked);

  let script: vm.Script;
  try {
    script = new vm.Script(code, { filename: filename ?? "airlock-sandbox.js" });
  } catch (error) {
    return { status: "error", error };
  }

  const result = await runVerified<T>(
    () =>
      script.runInContext(context, {
        timeout: timeoutMs,
        breakOnSigint: true,
      }) as T | Promise<T>,
    { timeoutMs, assert, ...(signal ? { signal } : {}) },
  );

  if (result.status === "error" && isSyncTimeout(result.error)) {
    return { status: "timeout", timeoutMs };
  }
  return result;
}

function isSyncTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SYNC_TIMEOUT_CODE
  );
}
