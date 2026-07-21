# airlock

Ephemeral, zero-credential, self-verifying execution for untrusted or agent-written code.

## What this demonstrates

An airlock is the safe way to run code you do not trust: an LLM-generated snippet, a plugin, a user-submitted function. This repo builds that primitive from the ground up in TypeScript. The guarantee is that a caller never reads an output unless the run stayed inside its deadline and its output satisfies a post-condition the caller supplied. Untrusted code is guilty until proven correct, and the type system makes you prove it before you can touch the value.

The first slice was the contract and the in-process runner that enforces it. The second slice added `run(code, opts)`, which executes untrusted source in a fresh `node:vm` context with no ambient authority. The third slice, here, adds `runInWorker(code, opts)`: the same contract, but the code runs in a `worker_threads` isolate. That is a separate V8 heap on a separate OS thread, started with an empty `process.env` and frozen globals. It closes the in-process gap where a constructor walk reaches the host realm, because an escape now lands in the worker's own realm, which carries no host credentials and can be hard-killed. Later slices add a Docker-backed tier for stronger isolation and a growing suite of documented escape-attempt tests.

## Concepts demonstrated

- **Verification-gated results.** The output value is reachable only through the `ok` variant of a discriminated union, so an unverified run is unrepresentable at the call site.
- **Post-condition contracts.** A run is trusted when a caller-supplied assertion holds over its output, a design-by-contract style check applied to untrusted code.
- **Deadline enforcement with cooperative cancellation.** An internal timer races the task and aborts the `AbortSignal` it runs under, composed with any caller-owned signal.
- **Total error handling.** Thrown errors, blown deadlines, and failed assertions are all values in the result union rather than exceptions, so no failure mode escapes as a rejection.
- **Capability-security framing.** The task receives only the abort capability it needs; `run` extends this to source code, which sees zero ambient authority and only the capabilities passed in the `grant` object.
- **Zero-credential invariant.** Untrusted source runs in a `node:vm` context that carries none of the host's authority: no `process`, `process.env`, `require`, `fetch`, timers, or `Buffer`. The invariant is a named denylist, probed at context-build time so a run fails closed if authority ever leaks in.
- **Realm isolation and its limits.** The context has its own set of ECMAScript intrinsics, so a host secret on `globalThis` is unreachable and the sandbox's own `Function` compiles in-realm. The known in-process gap, `this.constructor.constructor` reaching the host realm through the borrowed global prototype, is pinned by an escape-attempt test rather than hidden.
- **Thread-level isolation with `worker_threads`.** `runInWorker` runs untrusted source in a dedicated V8 isolate on its own thread. The in-process constructor-walk escape reaches only the worker's realm, which is started with an empty `process.env` and cannot see the host's environment. An escape-attempt test walks the same constructor chain and confirms a host secret placed in `process.env` stays out of reach.
- **Frozen realm hardening.** Before any untrusted code runs, the worker freezes `globalThis` and the core intrinsics and their prototypes, so an escape into the worker realm cannot repave shared state that later runs in the same isolate would rely on.
- **Hard preemption and resource limits.** A synchronous spin, an async task that never settles, and a heap that outgrows `maxOldGenerationSizeMb` are all terminal: the first two are killed by terminating the thread on the deadline, and the third is reported as `out-of-memory` by V8's resource limits. In-process `run` can only abandon a hung async task; the worker actually reclaims the thread.
- **Layered preemption.** A synchronous spin is killed by V8's `timeout`; an async task that never settles is aborted by the deadline race. `run` composes both so neither class of runaway can wedge the caller.
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

To run untrusted **source code** instead of a trusted closure, use `run`. The code executes with no ambient authority, so `process`, `require`, `fetch`, and timers are all undefined inside it. Any capability it needs is passed explicitly through `grant`:

```ts
import { run, isVerified } from "airlock";

const result = await run<number>(
  "add(rows.length, 1)",
  {
    timeoutMs: 50,
    assert: (n) => Number.isInteger(n) && n > 0,
    grant: {
      rows: [{ id: 1 }, { id: 2 }],
      add: (a: number, b: number) => a + b,
    },
  },
);

if (isVerified(result)) {
  console.log("verified:", result.value); // 3
}

// a synchronous infinite loop is preempted and reported as a timeout
await run("while (true) {}", { timeoutMs: 25, assert: () => true });
// -> { status: "timeout", timeoutMs: 25 }
```

For stronger isolation, `runInWorker` runs the same source in a `worker_threads` isolate: a separate V8 heap and thread with an empty `process.env`, frozen globals, and an optional heap cap. The `grant` and the returned value cross by structured clone, so pass data rather than live functions.

```ts
import { runInWorker, isVerified } from "airlock";

const result = await runInWorker<number>(
  "rows.reduce((sum, r) => sum + r.n, 0)",
  {
    timeoutMs: 500,
    assert: (total) => total === 6,
    grant: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    maxOldGenerationSizeMb: 32,
  },
);

if (isVerified(result)) console.log("verified:", result.value); // 6

// a runaway allocation is capped and reported instead of taking the host down
await runInWorker("const a = []; while (true) a.push(new Array(1e6));", {
  timeoutMs: 10_000,
  assert: () => true,
  maxOldGenerationSizeMb: 16,
});
// -> { status: "out-of-memory", maxOldGenerationSizeMb: 16 }
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
- `src/sandbox.ts`: `run(code, opts)` executes untrusted source in a zero-credential `node:vm` context (no `process`/`require`/`fetch`/timers), grants only what the caller passes, preempts synchronous spins via V8's timeout, and fails closed with a probed `ZeroCredentialViolation` if ambient authority leaks in. Includes documented escape-attempt tests.
- `src/worker.ts`: `runInWorker(code, opts)` runs untrusted source in a `worker_threads` isolate started with an empty `process.env` and frozen globals, caps the heap with `maxOldGenerationSizeMb` (reported as `out-of-memory`), and hard-kills the thread on the deadline so a sync spin and a never-settling async task are both preempted. An escape-attempt test confirms the constructor walk that reaches the host realm in-process reaches only the credential-free worker realm here.
