# Security model

Airlock runs untrusted or agent-written JavaScript under a capability boundary and only hands the caller a value when a post-condition passes. This document is the threat model for the TypeScript tiers that ship today: the in-process `run` sandbox and the `runInWorker` isolate.

## Trust boundaries

| Tier | API | Boundary | Kills runaways with |
|---|---|---|---|
| Contract | `runVerified` | Trusted closures only | Cooperative `AbortSignal` deadline |
| Sandbox | `run` | Fresh `node:vm` context, no ambient bindings | V8 script `timeout` + async deadline |
| Isolate | `runInWorker` | Separate OS thread, empty `process.env`, frozen intrinsics | `worker.terminate()` + V8 heap cap |

A stronger Docker tier (network-none, read-only root, dropped caps) is the intended home for process and filesystem hard walls after a realm escape. It is not claimed by the tests below until that executor lands.

## Guarantees (default boundary)

Inside the `vm` context, with no constructor-walk escape and no explicit `grant` / `allowedModules` expansion:

1. **No ambient credentials.** `process`, `require`, `fetch`, timers, and `Buffer` are unbound unless the caller grants them.
2. **Infinite loops are contained.** A synchronous spin hits the script timeout (and, on the worker tier, thread terminate). A never-settling promise hits the wall-clock deadline.
3. **Process spawn is denied.** `child_process` and `cluster` are unreachable without an allowlist entry; omitting `allowedModules` leaves `require` undefined.
4. **Filesystem exfil is denied.** `fs` loads and relative/absolute path specifiers are refused by the gated loader.
5. **Environment exfil is denied.** `process` is unbound, so `process.env` cannot be read from guest code.
6. **Verified output only.** Callers receive a trusted value only as `{ status: "ok" }` after the assertion passes and resource ceilings hold.

These properties are regression-tested by the threat catalog in `src/threats.ts` and `test/threats.test.ts`.

## Attack classes under test

| Class | Example payload | Expected containment |
|---|---|---|
| Infinite loop (sync) | `while (true) {}` | `timeout` |
| Infinite loop (async) | `new Promise(() => {})` | `timeout` |
| Fork bomb | `require('child_process')` with `allowedModules: []` | `ModuleNotAllowedError` |
| Fork bomb | `typeof require` with no allowlist | `"undefined"` |
| FS exfil | `require('fs').readFileSync(...)` | `ModuleNotAllowedError` |
| FS exfil | `require('./secrets.json')` even if `fs` is allowed | `ModuleNotAllowedError` |
| Env exfil | `typeof process` / `process.env.*` | `"undefined"` / `ReferenceError` |

Run them with the rest of the suite:

```bash
pnpm test
```

## Residual risks (documented, not claimed fixed)

`node:vm` contexts borrow the host realm's global prototype chain. Guest code can walk `this.constructor.constructor` and obtain the host (or worker-realm) `Function`. That escape is intentional to pin, not hide.

| Residual | Tier | What an attacker gets | Mitigation path |
|---|---|---|---|
| Host `process.env` | sandbox | Full host environment after constructor walk | Prefer `runInWorker`; never put secrets in the process that hosts `run` for hostile code |
| Empty but present `process` | worker | Realm `process` with `env: {}` after walk | Env canary stays undefined; still not a full process sandbox |
| Realm `require('fs')` | worker | Host filesystem via worker-realm require | Docker tier: read-only root + no mounts |
| Realm `require('child_process')` | worker | Process spawn after walk | Docker tier: no new privileges, dropped caps, pid limits |

`RESIDUAL_RISKS` in `src/threats.ts` and the matching tests assert these observations so a future hardening change cannot silently flip them without review.

## Hardening layers (defense in depth)

```
caller assertion
    ↑
resource ceilings (time, heap, output bytes)
    ↑
deny-by-default module allowlist
    ↑
zero-credential vm context
    ↑
worker isolate (empty env, frozen intrinsics, terminate)
    ↑
container tier (planned): network-none, read-only root, user namespaces
```

Each layer catches a different failure class. Resource limits stop wedging the host when the guest is still inside the context. Capability denial stops direct I/O and spawn. The isolate stops env inheritance. The container tier is what closes residual process and filesystem access after a realm escape.

## Reporting

If you find a path that breaks a **guarantee** above without using a listed residual technique, open an issue with a minimal payload and the tier (`run` vs `runInWorker`) it affects.
