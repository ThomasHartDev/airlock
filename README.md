# airlock

Ephemeral, zero-credential, self-verifying execution for untrusted or agent-written code.

## What this demonstrates

An airlock is the safe way to run code you do not trust: an LLM-generated snippet, a plugin, a user-submitted function. This repo builds that primitive from the ground up in TypeScript. The guarantee is that a caller never reads an output unless the run stayed inside its resource ceilings and its output satisfies a post-condition the caller supplied. Untrusted code is guilty until proven correct, and the type system makes you prove it before you can touch the value.

The first slice was the contract and the in-process runner that enforces it. The second slice added `run(code, opts)`, which executes untrusted source in a fresh `node:vm` context with no ambient authority. The third slice added `runInWorker(code, opts)`: the same contract on a `worker_threads` isolate with frozen globals and an empty env. The fourth slice hardens the **resource limit** layer: wall-clock deadline with hard terminate on abort, V8 heap cap, and output size caps. The fifth slice adds a **deny-by-default module loader**. This slice adds the **Docker-backed tier**: `runInDocker(code, opts)` runs the same contract inside a container with `--network=none`, a read-only root filesystem, dropped capabilities, and no host env, so an escape from the V8 realm still cannot reach the host's network, credentials, or writable disk.

## Concepts demonstrated

- **Verification-gated results.** The output value is reachable only through the `ok` variant of a discriminated union, so an unverified run is unrepresentable at the call site.
- **Post-condition contracts.** A run is trusted when a caller-supplied assertion holds over its output, a design-by-contract style check applied to untrusted code.
- **Deadline enforcement with cooperative cancellation.** An internal timer races the task and aborts the `AbortSignal` it runs under, composed with any caller-owned signal.
- **Hard preemption via worker termination.** On the isolate tier, the wall-clock deadline and caller abort both call `worker.terminate()`, reclaiming the OS thread instead of abandoning a hung task.
- **Resource isolation and ceilings.** Three independent budgets gate every run: wall-clock time, V8 old-generation heap (`maxOldGenerationSizeMb`), and measured UTF-8 output size (`maxOutputBytes`). Each maps to a distinct result status (`timeout`, `out-of-memory`, `output-too-large`).
- **Budgeted output metering.** Output size is walked with an early-exit budget so a cyclic or enormous structure cannot hang the host meter, and oversized values never reach the post-condition as trusted results.
- **Total error handling.** Thrown errors, blown deadlines, failed assertions, OOM, and oversized output are all values in the result union rather than exceptions, so no failure mode escapes as a rejection.
- **Capability-security framing.** The task receives only the abort capability it needs; `run` extends this to source code, which sees zero ambient authority and only the capabilities passed in the `grant` object.
- **Zero-credential invariant.** Untrusted source runs in a `node:vm` context that carries none of the host's authority: no `process`, `process.env`, `require`, `fetch`, timers, or `Buffer`. The invariant is a named denylist, probed at context-build time so a run fails closed if authority ever leaks in.
- **Realm isolation and its limits.** The context has its own set of ECMAScript intrinsics, so a host secret on `globalThis` is unreachable and the sandbox's own `Function` compiles in-realm. The known in-process gap, `this.constructor.constructor` reaching the host realm through the borrowed global prototype, is pinned by an escape-attempt test rather than hidden.
- **Thread-level isolation with `worker_threads`.** `runInWorker` runs untrusted source in a dedicated V8 isolate on its own thread. The in-process constructor-walk escape reaches only the worker's realm, which is started with an empty `process.env` and cannot see the host's environment. An escape-attempt test walks the same constructor chain and confirms a host secret placed in `process.env` stays out of reach.
- **Frozen realm hardening.** Before any untrusted code runs, the worker freezes `globalThis` and the core intrinsics and their prototypes, so an escape into the worker realm cannot repave shared state that later runs in the same isolate would rely on.
- **Layered preemption.** A synchronous spin is killed by V8's `timeout`; an async task that never settles is aborted by the deadline race (and terminated on the worker tier). `run` composes both so neither class of runaway can wedge the caller.
- **Deny-by-default module loading.** `require` is unbound unless the caller sets `allowedModules`. An empty list injects a gate that refuses every specifier; a non-empty list is an exact-match allowlist (with bare/`node:` equivalence), never a prefix grant.
- **Capability allowlists.** Module loading is treated as ambient authority: the host's real `require` is reachable only after the gate admits the id, so unlisted builtins like `fs` stay closed even when a sibling id is granted.
- **Path-specifier refusal.** Relative and absolute paths are dropped from the allowlist and rejected at load time so filesystem resolution cannot re-open host I/O through a crafty entry.
- **OS-level container isolation.** `runInDocker` uses Linux namespaces and cgroups (`--network=none`, `--read-only` + tmpfs, `--cap-drop=ALL`, `no-new-privileges`, non-root uid) behind the same `RunResult` contract as the vm and worker tiers.
- **Escape-attempt tests as documentation.** Host env, outbound connect, write outside tmpfs, and host-only marker paths pin what the container tier blocks.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, no `any`.

## The primitive contract

```
runVerified(task, { timeoutMs, assert, signal?, maxOutputBytes? }) -> RunResult
```

- The value is returned **only** as `{ status: "ok", value, durationMs }`, and only when the task finished before `timeoutMs`, the payload stayed under `maxOutputBytes` when set, and `assert(value)` returned true.
- Every other outcome is an explicit refusal: `timeout`, `assertion-failed` (carries the value for diagnostics, never as trusted), `output-too-large`, `out-of-memory`, or `error`.
- The task is handed an `AbortSignal` that fires on the deadline or on the caller's own signal, so well-behaved async work can stop early. On the worker tier that same abort path also terminates the isolate.

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
    maxOutputBytes: 64 * 1024,
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
    maxOutputBytes: 1024,
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

For stronger isolation, `runInWorker` runs the same source in a `worker_threads` isolate: a separate V8 heap and thread with an empty `process.env`, frozen globals, heap cap, and output size cap. The `grant` and the returned value cross by structured clone, so pass data rather than live functions. Deadline and caller abort both call `worker.terminate()`.

```ts
import { runInWorker, isVerified } from "airlock";

const result = await runInWorker<number>(
  "rows.reduce((sum, r) => sum + r.n, 0)",
  {
    timeoutMs: 500,
    assert: (total) => total === 6,
    grant: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    maxOldGenerationSizeMb: 32,
    maxOutputBytes: 4096,
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

// an oversized return is refused before the post-condition runs
await runInWorker("'x'.repeat(1_000_000)", {
  timeoutMs: 1000,
  assert: () => true,
  maxOutputBytes: 1024,
});
// -> { status: "output-too-large", maxOutputBytes: 1024, actualBytes: ... }
```

Module loading is off by default. Pass `allowedModules` to inject a gated `require` on either tier. Only exact builtin or package ids resolve; paths never do.

```ts
import { run, isVerified } from "airlock";

// allowed: path (bare or node:path). denied: fs, relative paths, everything else.
const result = await run<string>("require('node:path').join('a', 'b')", {
  timeoutMs: 100,
  assert: (p) => typeof p === "string",
  allowedModules: ["path"],
});

if (isVerified(result)) console.log(result.value);

// empty allowlist still injects require, but every load throws ModuleNotAllowedError
await run("require('path')", {
  timeoutMs: 100,
  assert: () => true,
  allowedModules: [],
});
// -> { status: "error", error: ModuleNotAllowedError }
```

For the strongest isolation tier, `runInDocker` runs the same source in a disposable container with no network, a read-only rootfs, dropped caps, and no host env. Requires Docker (default image `node:20-alpine`).

**Wire format.** Grants still enter the guest as JSON (functions/symbols/bigints are refused before spawn). **Return values** leave the guest via `node:v8` `serialize` / host `deserialize` (structured clone), framed on stdout as `AIRLOCK1:<base64>`. That preserves `NaN`, `Infinity`, `Map`, `Set`, `Date`, and `TypedArray` the same way `runInWorker` does. Values that are not structured-cloneable fail closed as `{ status: "error" }` rather than a corrupted `ok`. There is no `allowedModules` on this tier: the guest has no `require` binding (escapes that reach the Node realm still run under the container posture only).

`timeoutMs` is wall-clock from Docker CLI spawn and includes cold image start. `maxMemoryMb` sets the container cgroup memory ceiling; on OOM the result reuses the shared `maxOldGenerationSizeMb` field for `RunResult` parity (it is the cgroup ceiling, not a V8 old-gen limit).

```ts
import { runInDocker, isVerified, dockerSecurityArgs } from "airlock";

console.log(dockerSecurityArgs({ maxMemoryMb: 128 })); // --network=none, --read-only, ...

const result = await runInDocker<number>("rows.reduce((s, r) => s + r.n, 0)", {
  timeoutMs: 30_000,
  assert: (total) => total === 6,
  grant: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] },
  maxMemoryMb: 128,
});
if (isVerified(result)) console.log("verified:", result.value); // 6
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
- `src/limits.ts`: shared resource ceilings for every tier. Wall-clock timeout aborts the task signal and, on the worker tier, calls `worker.terminate()` on both deadline and caller abort. Heap cap via V8 `resourceLimits`. Output size caps (`maxOutputBytes`) measure UTF-8 payload with a budgeted walk (cycle-safe, early-exit) and refuse with `output-too-large` before the post-condition runs.
- `src/modules.ts`: deny-by-default module loader with an explicit `allowedModules` allowlist. Omitted means no `require`; `[]` or a list injects `createGatedRequire` over the host/worker require. Exact match only (bare and `node:` equivalent), path specifiers always refused, and the gate wins over a grant-supplied `require`. Wired into both `run` and `runInWorker`.
- `src/docker.ts`: `runInDocker(code, opts)` runs untrusted source behind the same `RunResult` interface inside Docker with `--network=none`, `--read-only` (+ tmpfs `/tmp`), `--cap-drop=ALL`, `no-new-privileges`, and uid `65534`. Host env is not inherited. Named containers are force-removed on abort/timeout so guests cannot orphan. Host-collected stdout is byte-capped. Return values use a framed `v8.serialize` channel (`AIRLOCK1:<base64>`) so structured-clone types match worker fidelity; non-cloneable values fail closed. `dockerSecurityArgs` exposes the posture for audit. Tests cover the contract, value fidelity (NaN/Map/Uint8Array/Date), cgroup OOM, and isolation escapes. Live tests skip when the daemon is unavailable.
