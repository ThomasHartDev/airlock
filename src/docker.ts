import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import type { Assertion, RunResult } from "./contract.js";
import { checkOutputSize, validateResourceLimits } from "./limits.js";

export const DEFAULT_DOCKER_IMAGE = "node:20-alpine";
export const DOCKER_CONTAINER_NAME_PREFIX = "airlock-";
export const DEFAULT_MAX_WIRE_BYTES = 1_048_576;
/** Framed result line prefix: AIRLOCK1:<base64(v8.serialize(envelope))> */
export const DOCKER_WIRE_PREFIX = "AIRLOCK1:";
const WIRE_FRAMING_SLACK = 65_536;
const STDERR_DIAG_CAP = 4_096;
const SYNC_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";
const OOM_EXIT = 137;
const FORCE_RM_TIMEOUT_MS = 5_000;

export interface DockerRunOptions<T> {
  timeoutMs: number;
  assert: Assertion<T>;
  /** JSON-serializable capabilities only. */
  grant?: Readonly<Record<string, unknown>>;
  /**
   * Container cgroup memory ceiling in MiB (also reported as
   * `maxOldGenerationSizeMb` on out-of-memory for RunResult union parity).
   */
  maxMemoryMb?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  image?: string;
  dockerPath?: string;
}

export interface DockerSecurityOptions { maxMemoryMb?: number; }

export function wireByteLimit(maxOutputBytes?: number): number {
  return maxOutputBytes === undefined
    ? DEFAULT_MAX_WIRE_BYTES
    : Math.max(maxOutputBytes + WIRE_FRAMING_SLACK, WIRE_FRAMING_SLACK);
}

export function uniqueContainerName(): string {
  return `${DOCKER_CONTAINER_NAME_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`;
}

/** Hardening flags shared by every container run. */

export function dockerSecurityArgs(opts: DockerSecurityOptions = {}): string[] {
  const args = [
    "--network=none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "65534:65534", "--env", "HOME=/tmp",
  ];
  if (opts.maxMemoryMb !== undefined) {
    args.push("--memory", `${opts.maxMemoryMb}m`, "--memory-swap", `${opts.maxMemoryMb}m`);
  }
  return args;
}

// Guest is self-contained. settleWithDeadline covers never-settling async:
// cross-realm vm Promises do not pin the event loop on their own.
// Result channel is v8.serialize (structured clone) framed as AIRLOCK1:<base64>
// so NaN/Infinity/Map/Date/TypedArray round-trip; non-cloneable values fail closed.

const GUEST_SOURCE = [
  "'use strict';",
  "const fs=require('node:fs'),vm=require('node:vm'),v8=require('node:v8');",
  "function frame(msg){return 'AIRLOCK1:'+v8.serialize(msg).toString('base64')+'\\n';}",
  "function emit(msg){try{fs.writeSync(1,frame(msg));}catch(ser){try{fs.writeSync(1,frame({ok:false,error:{name:'TypeError',message:String(ser&&ser.message||ser),code:'ERR_AIRLOCK_VALUE_NOT_CLONEABLE'}}));}catch(_){fs.writeSync(1,'AIRLOCK1:FAIL\\n');}}}",
  "function settleWithDeadline(v,ms){return new Promise((res,rej)=>{const t=setTimeout(()=>{const e=new Error('deadline exceeded');Object.defineProperty(e,'code',{value:'ERR_SCRIPT_EXECUTION_TIMEOUT'});rej(e);},ms);Promise.resolve(v).then(x=>{clearTimeout(t);res(x);},e=>{clearTimeout(t);rej(e);});});}",
  "(async()=>{try{const p=JSON.parse(fs.readFileSync('/airlock/payload.json','utf8'));const c=vm.createContext(Object.assign({},p.grant||{}));const s=new vm.Script(p.code,{filename:p.filename||'airlock-docker.js'});const value=await settleWithDeadline(s.runInContext(c,{timeout:p.timeoutMs}),p.timeoutMs);emit({ok:true,value});}catch(error){emit({ok:false,error:{name:error&&error.name,message:error&&error.message,stack:error&&error.stack,code:error&&error.code}});}})();",
].join("\n");

type GuestErr = { name?: string; message?: string; stack?: string; code?: string };
type GuestMessage = { ok: true; value: unknown } | { ok: false; error: GuestErr };
type SpawnSignal = "timeout" | "abort" | "output-too-large" | null;

/**
 * Run untrusted source in Docker (`--network=none`, `--read-only`, dropped
 * caps, no host env) behind the same {@link RunResult} contract as
 * {@link run} / {@link runInWorker}. Requires a docker daemon.
 *
 * Return values cross the host boundary via `v8.serialize` / `v8.deserialize`
 * (structured clone), matching worker fidelity for Map/Date/TypedArray/NaN/
 * Infinity. Non-cloneable values fail closed as `status: "error"`.
 */

export async function runInDocker<T>(
  code: string,
  opts: DockerRunOptions<T>,
): Promise<RunResult<T>> {
  const { timeoutMs, assert, grant, maxMemoryMb, maxOutputBytes, signal,
    image = DEFAULT_DOCKER_IMAGE, dockerPath = "docker" } = opts;
  validateResourceLimits({
    timeoutMs,
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  });
  if (maxMemoryMb !== undefined && (!Number.isInteger(maxMemoryMb) || maxMemoryMb <= 0)) {
    throw new RangeError("maxMemoryMb must be a positive integer");
  }
  let payloadJson: string;
  try {
    payloadJson = serializePayload({
      code,
      grant: grant ?? {},
      timeoutMs,
      filename: "airlock-docker.js",
    });
  } catch (error) {
    return { status: "error", error };
  }
  const workdir = await mkdtemp(join(tmpdir(), "airlock-docker-"));
  const containerName = uniqueContainerName();
  const maxWireBytes = wireByteLimit(maxOutputBytes);
  const started = performance.now();
  try {
    await writeFile(join(workdir, "guest.js"), GUEST_SOURCE, "utf8");
    await writeFile(join(workdir, "payload.json"), payloadJson, "utf8");
    // nobody (65534) cannot read a 0o700 mkdtemp dir.
    await chmod(workdir, 0o755);
    await chmod(join(workdir, "guest.js"), 0o444);
    await chmod(join(workdir, "payload.json"), 0o444);
    const spawned = await spawnDocker({
      dockerPath,
      args: [
        "run", "--rm", "--name", containerName,
        ...dockerSecurityArgs({ ...(maxMemoryMb !== undefined ? { maxMemoryMb } : {}) }),
        "--mount", `type=bind,source=${workdir},target=/airlock,readonly`,
        image, "node", "/airlock/guest.js",
      ],
      timeoutMs, signal, containerName, maxWireBytes,
    });
    if (spawned.signalled === "timeout") return { status: "timeout", timeoutMs };
    if (spawned.signalled === "abort") return { status: "error", error: signal?.reason };
    if (spawned.signalled === "output-too-large") {
      return {
        status: "output-too-large",
        maxOutputBytes: maxOutputBytes ?? maxWireBytes,
        actualBytes: spawned.wireBytes,
      };
    }
    // Prefer a parseable envelope over exit code. Map 137 → OOM only when a
    // memory ceiling was set and the guest produced no harness line.
    const message = parseGuestStdout(spawned.stdout);
    if (!message) {
      if (spawned.exitCode === OOM_EXIT && maxMemoryMb !== undefined) {
        return { status: "out-of-memory", maxOldGenerationSizeMb: maxMemoryMb };
      }
      const detail = (spawned.stdout || spawned.stderr).slice(0, 500);
      return {
        status: "error",
        error: new Error(
          spawned.exitCode === 0
            ? "docker guest produced no parseable result"
            : `docker exited with code ${spawned.exitCode}: ${detail}`,
        ),
      };
    }
    if (!message.ok) {
      if (message.error.code === SYNC_TIMEOUT_CODE) return { status: "timeout", timeoutMs };
      return { status: "error", error: reviveError(message.error) };
    }
    const value = message.value as T;
    if (maxOutputBytes !== undefined) {
      const size = checkOutputSize(value, maxOutputBytes);
      if (size.exceeded) {
        return { status: "output-too-large", maxOutputBytes, actualBytes: size.bytes };
      }
    }
    try {
      const passed = await assert(value);
      return passed
        ? { status: "ok", value, durationMs: performance.now() - started }
        : { status: "assertion-failed", value };
    } catch (error) {
      return { status: "error", error };
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function spawnDocker(opts: {
  dockerPath: string; args: string[]; timeoutMs: number;
  signal: AbortSignal | undefined; containerName: string; maxWireBytes: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; signalled: SpawnSignal; wireBytes: number }> {
  const { dockerPath, args, timeoutMs, signal, containerName, maxWireBytes } = opts;
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let signalled: SpawnSignal = null;
    let wireBytes = 0;
    const chunks: Buffer[] = [];
    let stderr = "";
    const child = spawn(dockerPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: dockerCliEnv(),
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(chunks).toString("utf8"), stderr, exitCode, signalled, wireBytes });
    };
    const stop = (reason: Exclude<SpawnSignal, null>) => {
      if (stopping || settled) return;
      stopping = true;
      signalled = reason;
      // Container first so a SIGKILL'd CLI cannot orphan the guest.
      forceRemoveContainer(dockerPath, containerName).finally(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      });
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("abort");
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || stopping) return;
      wireBytes += chunk.length;
      if (wireBytes > maxWireBytes) {
        stop("output-too-large");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_DIAG_CAP) {
        stderr = (stderr + chunk.toString("utf8")).slice(0, STDERR_DIAG_CAP);
      }
    });
    child.on("error", (e) => {
      if (stderr.length < STDERR_DIAG_CAP) {
        stderr = (stderr + e.message).slice(0, STDERR_DIAG_CAP);
      }
      finish(1);
    });
    child.on("close", (code) => finish(code));
  });
}

function forceRemoveContainer(dockerPath: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn(dockerPath, ["rm", "-f", name], {
      stdio: "ignore",
      env: dockerCliEnv(),
    });
    const timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve();
    }, FORCE_RM_TIMEOUT_MS);
    killer.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseGuestStdout(stdout: string): GuestMessage | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.startsWith(DOCKER_WIRE_PREFIX)) continue;
    const b64 = line.slice(DOCKER_WIRE_PREFIX.length);
    if (!b64 || b64 === "FAIL") continue;
    try {
      const parsed: unknown = deserialize(Buffer.from(b64, "base64"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "ok" in parsed &&
        typeof (parsed as { ok: unknown }).ok === "boolean"
      ) {
        return parsed as GuestMessage;
      }
    } catch {
      /* scan */
    }
  }
  return null;
}

function reviveError(shape: GuestErr): Error {
  const error = new Error(shape.message ?? "docker guest error");
  if (shape.name) error.name = shape.name;
  if (shape.stack) error.stack = shape.stack;
  if (shape.code) (error as Error & { code?: string }).code = shape.code;
  return error;
}

export async function isDockerAvailable(dockerPath = "docker"): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(dockerPath, ["info"], { stdio: "ignore", env: dockerCliEnv() });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function dockerCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

/** Throw on functions/symbols/bigints so grants cannot silently drop fields. */

function serializePayload(payload: unknown): string {
  return JSON.stringify(payload, (_k, value: unknown) => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError("grant must be JSON-serializable");
    }
    return value;
  });
}
