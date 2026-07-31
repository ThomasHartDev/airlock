import * as vm from "node:vm";
import type { Assertion, RunResult } from "./contract.js";
import { buildSandboxRequire } from "./modules.js";
import { runVerified } from "./run.js";

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

  grant?: Readonly<Record<string, unknown>>;

  allowedModules?: readonly string[];
  signal?: AbortSignal;
  filename?: string;
  maxOutputBytes?: number;
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

export async function run<T>(
  code: string,
  opts: SandboxRunOptions<T>,
): Promise<RunResult<T>> {
  const {
    timeoutMs,
    assert,
    grant,
    allowedModules,
    signal,
    filename,
    maxOutputBytes,
  } = opts;

  const bindings: Record<string, unknown> = { ...(grant ?? {}) };
  // allowedModules wins over grant.require so the allowlist cannot be bypassed
  if (allowedModules !== undefined) {
    bindings.require = buildSandboxRequire(allowedModules);
  }

  const context = vm.createContext(bindings);
  const leaked = probeAmbientAuthority(context, Object.keys(bindings));
  if (leaked.length > 0) throw new ZeroCredentialViolation(leaked);

  let script: vm.Script;
  try {
    script = new vm.Script(code, { filename: filename ?? "airlock-sandbox.js" });
  } catch (error) {
    return { status: "error", verified: false, error };
  }

  const result = await runVerified<T>(
    () =>
      script.runInContext(context, {
        timeout: timeoutMs,
        breakOnSigint: true,
      }) as T | Promise<T>,
    {
      timeoutMs,
      assert,
      ...(signal ? { signal } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    },
  );

  if (result.status === "error" && isSyncTimeout(result.error)) {
    return { status: "timeout", verified: false, timeoutMs };
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
