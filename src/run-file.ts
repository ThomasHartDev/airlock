import { readFile } from "node:fs/promises";
import type { Assertion, RunResult } from "./contract.js";
import { run } from "./sandbox.js";
import { runInWorker } from "./worker.js";

export interface JsonError {
  name: string;
  message: string;
  code?: string;
}

/** JSON-serializable run outcome. Errors are DTOs, never live Error instances. */
export type JsonRunResult =
  | { status: "ok"; value: unknown; durationMs: number }
  | { status: "timeout"; timeoutMs: number }
  | { status: "assertion-failed"; value: unknown }
  | { status: "error"; error: JsonError }
  | { status: "out-of-memory"; maxOldGenerationSizeMb: number }
  | { status: "output-too-large"; maxOutputBytes: number; actualBytes: number }
  | { status: "io-error"; message: string };

export type ExecutorTier = "sandbox" | "worker";

export interface RunFileOptions {
  timeoutMs?: number;
  assert?: Assertion<unknown>;
  /** Host-side expression with `value` in scope (trusted operator input). */
  assertExpr?: string;
  grant?: Readonly<Record<string, unknown>>;
  allowedModules?: readonly string[];
  signal?: AbortSignal;
  maxOutputBytes?: number;
  maxOldGenerationSizeMb?: number;
  tier?: ExecutorTier;
  filename?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function serializeError(error: unknown): JsonError {
  // Other-realm Errors fail `instanceof`; duck-type name/message/code.
  if (typeof error === "object" && error !== null) {
    const rec = error as { name?: unknown; message?: unknown; code?: unknown };
    if (typeof rec.message === "string") {
      const base: JsonError = {
        name: typeof rec.name === "string" && rec.name ? rec.name : "Error",
        message: rec.message,
      };
      if (typeof rec.code === "string" || typeof rec.code === "number") {
        return { ...base, code: String(rec.code) };
      }
      return base;
    }
  }
  if (typeof error === "string") return { name: "Error", message: error };
  return { name: "Error", message: String(error) };
}

export function toJsonResult(result: RunResult<unknown>): JsonRunResult {
  switch (result.status) {
    case "ok":
      return { status: "ok", value: result.value, durationMs: result.durationMs };
    case "timeout":
      return { status: "timeout", timeoutMs: result.timeoutMs };
    case "assertion-failed":
      return { status: "assertion-failed", value: result.value };
    case "error":
      return { status: "error", error: serializeError(result.error) };
    case "out-of-memory":
      return { status: "out-of-memory", maxOldGenerationSizeMb: result.maxOldGenerationSizeMb };
    case "output-too-large":
      return {
        status: "output-too-large",
        maxOutputBytes: result.maxOutputBytes,
        actualBytes: result.actualBytes,
      };
  }
}

/** 0 = ok, 1 = sandbox refusal, 2 = CLI/IO failure. */
export function exitCodeFor(result: JsonRunResult): number {
  if (result.status === "ok") return 0;
  if (result.status === "io-error") return 2;
  return 1;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function") {
    return { __type: "Function", name: value.name || "anonymous" };
  }
  return value;
}

export function stringifyJsonResult(result: JsonRunResult): string {
  try {
    return JSON.stringify(result, jsonReplacer);
  } catch (error) {
    return JSON.stringify({
      status: "error",
      error: serializeError(error),
    } satisfies JsonRunResult);
  }
}

export function compileAssertExpr(expr: string): Assertion<unknown> {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error("assert expression must not be empty");
  const fn = new Function("value", `return (${trimmed});`) as (
    value: unknown,
  ) => unknown;
  // Await then coerce: Promise-returning exprs must settle before Boolean().
  return async (value) => Boolean(await fn(value));
}

export async function runSource(
  code: string,
  opts: RunFileOptions = {},
): Promise<JsonRunResult> {
  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const assert =
      opts.assert ??
      (opts.assertExpr !== undefined
        ? compileAssertExpr(opts.assertExpr)
        : () => true);
    const common = {
      timeoutMs,
      assert,
      filename: opts.filename ?? "airlock-run.js",
      ...(opts.grant ? { grant: opts.grant } : {}),
      ...(opts.allowedModules !== undefined
        ? { allowedModules: opts.allowedModules }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxOutputBytes !== undefined
        ? { maxOutputBytes: opts.maxOutputBytes }
        : {}),
    };

    if ((opts.tier ?? "sandbox") === "worker") {
      return toJsonResult(
        await runInWorker(code, {
          ...common,
          ...(opts.maxOldGenerationSizeMb !== undefined
            ? { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb }
            : {}),
        }),
      );
    }
    return toJsonResult(await run(code, common));
  } catch (error) {
    return { status: "error", error: serializeError(error) };
  }
}

export async function runFile(
  path: string,
  opts: RunFileOptions = {},
): Promise<JsonRunResult> {
  if (!path.trim()) {
    return { status: "io-error", message: "path must not be empty" };
  }
  try {
    const code = await readFile(path, "utf8");
    return await runSource(code, { ...opts, filename: opts.filename ?? path });
  } catch (error) {
    return {
      status: "io-error",
      message: error instanceof Error ? error.message : `failed to read ${path}`,
    };
  }
}
