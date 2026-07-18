# airlock

Ephemeral, zero-credential, self-verifying execution for untrusted or agent-written code.

## What this demonstrates

An airlock is the safe way to run code you do not trust: an LLM-generated snippet, a plugin, a user-submitted function. This repo builds that primitive from the ground up in TypeScript. The guarantee is that a caller never reads an output unless the run stayed inside its deadline and its output satisfies a post-condition the caller supplied. Untrusted code is guilty until proven correct, and the type system makes you prove it before you can touch the value.

This first slice is the contract and the in-process runner that enforces it. Later slices harden the sandbox itself: an [`isolated-vm`](https://github.com/laverdet/isolated-vm) tier with no ambient `env` or network and a hard memory cap, a Docker-backed tier for stronger isolation, and a suite of documented escape-attempt tests.

## Concepts demonstrated

- **Verification-gated results.** The output value is reachable only through the `ok` variant of a discriminated union, so an unverified run is unrepresentable at the call site.
- **Post-condition contracts.** A run is trusted when a caller-supplied assertion holds over its output, a design-by-contract style check applied to untrusted code.
- **Deadline enforcement with cooperative cancellation.** An internal timer races the task and aborts the `AbortSignal` it runs under, composed with any caller-owned signal.
- **Total error handling.** Thrown errors, blown deadlines, and failed assertions are all values in the result union rather than exceptions, so no failure mode escapes as a rejection.
- **Capability-security framing.** The task receives only the abort capability it needs; the stronger isolation tiers extend this to zero ambient authority (no `env`, no network, no filesystem).
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, no `any`.

## The primitive contract

```
runVerified(task, { timeoutMs, assert, signal? }) -> RunResult
```

- The value is returned **only** as `{ status: "ok", value, durationMs }`, and only when the task finished before `timeoutMs` and `assert(value)` returned true.
- Every other outcome is an explicit refusal: `timeout`, `assertion-failed` (carries the value for diagnostics, never as trusted), or `error`.
- The task is handed an `AbortSignal` that fires on the deadline or on the caller's own signal, so well-behaved async work can stop early.

The in-process tier cannot preempt code that blocks the event loop with a synchronous spin; that is what the isolate and container tiers are for. This tier defines the contract those tiers implement.

## Usage

```ts
import { runVerified, isVerified } from "airlock";

const result = await runVerified(
  async (signal) => {
    const res = await fetch("https://example.com/data.json", { signal });
    return (await res.json()) as { total: number };
  },
  {
    timeoutMs: 2000,
    assert: (data) => Number.isInteger(data.total) && data.total >= 0,
  },
);

if (isVerified(result)) {
  console.log("trusted output:", result.value.total);
} else {
  console.warn("refused:", result.status);
}
```

## Develop

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## What's implemented

- Scaffold: pnpm + strict TypeScript, tsup build, vitest, CI, and the `runVerified` primitive contract (deadline + post-condition gating over a discriminated-union result).
