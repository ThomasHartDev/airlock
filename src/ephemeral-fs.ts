import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EphemeralFsOptions {
  /** Relative workspace path -> host file or directory, mounted read-only. */
  fixtures?: Readonly<Record<string, string>>;
  /** Prefix for `mkdtemp`. Default `airlock-`. */
  prefix?: string;
  /** Parent of the per-run directory. Default `os.tmpdir()`. */
  baseDir?: string;
}

export interface EphemeralWorkspace {
  readonly root: string;
  readonly fixturePaths: readonly string[];
  dispose(): Promise<void>;
}

export class FixturePathError extends Error {
  readonly fixtureKey: string;
  constructor(fixtureKey: string, reason: string) {
    super(`invalid fixture path "${fixtureKey}": ${reason}`);
    this.name = "FixturePathError";
    this.fixtureKey = fixtureKey;
  }
}

/** Reject absolute paths, `..`, and drive forms so joins cannot escape root. */
export function assertSafeFixtureKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new FixturePathError(String(key), "must be a non-empty relative path");
  }
  if (path.isAbsolute(key) || /^[A-Za-z]:[\\/]/.test(key)) {
    throw new FixturePathError(key, "must be relative");
  }
  const normalized = path.posix.normalize(key.replace(/\\/g, "/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new FixturePathError(key, "must not escape the workspace root");
  }
}

export async function createEphemeralWorkspace(
  opts: EphemeralFsOptions = {},
): Promise<EphemeralWorkspace> {
  const baseDir = opts.baseDir ?? os.tmpdir();
  const prefix = opts.prefix ?? "airlock-";
  await fs.mkdir(baseDir, { recursive: true });
  const root = await fs.mkdtemp(path.join(baseDir, prefix));

  const fixturePaths: string[] = [];
  try {
    for (const [rel, hostPath] of Object.entries(opts.fixtures ?? {})) {
      assertSafeFixtureKey(rel);
      if (typeof hostPath !== "string" || hostPath.length === 0) {
        throw new FixturePathError(rel, "host path must be a non-empty string");
      }
      await mountReadOnly(hostPath, path.join(root, rel));
      fixturePaths.push(rel.replace(/\\/g, "/"));
    }
  } catch (error) {
    await wipeTree(root);
    throw error;
  }

  let disposed = false;
  return {
    root,
    fixturePaths,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await wipeTree(root);
    },
  };
}

export async function withEphemeralWorkspace<T>(
  opts: EphemeralFsOptions | undefined,
  fn: (workspace: EphemeralWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await createEphemeralWorkspace(opts ?? {});
  try {
    return await fn(workspace);
  } finally {
    await workspace.dispose();
  }
}

async function mountReadOnly(hostPath: string, dest: string): Promise<void> {
  const stat = await fs.stat(hostPath);
  if (stat.isDirectory()) {
    await fs.cp(hostPath, dest, { recursive: true, errorOnExist: true });
    await makeTreeReadOnly(dest);
    return;
  }
  if (!stat.isFile()) {
    throw new FixturePathError(hostPath, "host path must be a file or directory");
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(hostPath, dest);
  await lockReadOnly(dest);
}

async function makeTreeReadOnly(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(full);
      await fs.chmod(full, 0o555);
    } else if (entry.isFile()) {
      await lockReadOnly(full);
    }
  }
  await fs.chmod(dir, 0o555);
}

// Mode bits alone do not stop root; chattr +i closes that hole on Linux.
async function lockReadOnly(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o444);
  await chattr(filePath, "+i");
}

async function chattr(filePath: string, flag: "+i" | "-i"): Promise<void> {
  if (process.platform !== "linux") return;
  try {
    await execFileAsync("chattr", [flag, filePath], { timeout: 5_000 });
  } catch {
    // unsupported FS: mode bits still apply for non-root guests
  }
}

async function wipeTree(root: string): Promise<void> {
  try {
    await restoreWritable(root);
  } catch {
    // best-effort before force remove
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function restoreWritable(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(target, 0o700).catch(() => {});
    for (const name of await fs.readdir(target)) {
      await restoreWritable(path.join(target, name));
    }
    return;
  }
  if (stat.isFile()) {
    await chattr(target, "-i");
    await fs.chmod(target, 0o600).catch(() => {});
  }
}
