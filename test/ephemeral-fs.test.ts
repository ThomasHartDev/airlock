import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FixturePathError,
  assertSafeFixtureKey,
  createEphemeralWorkspace,
  isVerified,
  run,
  runInWorker,
  withEphemeralWorkspace,
} from "../src/index.js";

const leftovers: string[] = [];
afterEach(async () => {
  for (const dir of leftovers.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function hostFile(name: string, body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "airlock-fixture-"));
  leftovers.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, body, "utf8");
  return file;
}

const RO_DENY = expect.stringMatching(/^(EACCES|EPERM)$/);

describe("assertSafeFixtureKey", () => {
  it.each(["", "../x", "..", "/abs", "C:\\win"])("rejects %s", (key) => {
    expect(() => assertSafeFixtureKey(key)).toThrow(FixturePathError);
  });
  it("accepts nested relative keys", () => {
    expect(() => assertSafeFixtureKey("data/in.json")).not.toThrow();
  });
});

describe("createEphemeralWorkspace", () => {
  it("creates a writable root and wipes on dispose (idempotent)", async () => {
    const ws = await createEphemeralWorkspace({ prefix: "airlock-ut-" });
    leftovers.push(ws.root);
    expect(ws.fixturePaths).toEqual([]);
    await fs.writeFile(path.join(ws.root, "scratch.txt"), "hi", "utf8");
    await ws.dispose();
    await expect(fs.stat(ws.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ws.dispose()).resolves.toBeUndefined();
  });

  it("mounts RO file/dir fixtures without mutating host; rejects path escape", async () => {
    const seed = await hostFile("seed.txt", "fixture-body");
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "airlock-fixture-"));
    leftovers.push(hostDir);
    await fs.mkdir(path.join(hostDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(hostDir, "nested", "a.txt"), "A", "utf8");

    const ws = await createEphemeralWorkspace({
      fixtures: { "in/seed.txt": seed, pack: hostDir },
    });
    leftovers.push(ws.root);
    const mounted = path.join(ws.root, "in/seed.txt");
    await expect(fs.readFile(mounted, "utf8")).resolves.toBe("fixture-body");
    await expect(fs.writeFile(mounted, "x", "utf8")).rejects.toMatchObject({
      code: RO_DENY,
    });
    await expect(fs.readFile(seed, "utf8")).resolves.toBe("fixture-body");
    await expect(
      fs.readFile(path.join(ws.root, "pack/nested/a.txt"), "utf8"),
    ).resolves.toBe("A");
    await ws.dispose();
    await expect(fs.stat(mounted)).rejects.toMatchObject({ code: "ENOENT" });

    const before = await fs.readdir(os.tmpdir());
    await expect(
      createEphemeralWorkspace({ fixtures: { "../escape.txt": seed } }),
    ).rejects.toBeInstanceOf(FixturePathError);
    const after = await fs.readdir(os.tmpdir());
    expect(
      after.filter((n) => n.startsWith("airlock-") && !before.includes(n)),
    ).toEqual([]);
  });

  it("isolates concurrent workspaces", async () => {
    const [a, b] = await Promise.all([
      createEphemeralWorkspace({ prefix: "airlock-c-" }),
      createEphemeralWorkspace({ prefix: "airlock-c-" }),
    ]);
    leftovers.push(a.root, b.root);
    expect(a.root).not.toBe(b.root);
    await fs.writeFile(path.join(a.root, "only-a"), "1", "utf8");
    await expect(fs.stat(path.join(b.root, "only-a"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await Promise.all([a.dispose(), b.dispose()]);
  });
});

describe("withEphemeralWorkspace", () => {
  it("wipes after success and after throw", async () => {
    let successRoot = "";
    await withEphemeralWorkspace({}, async (ws) => {
      successRoot = ws.root;
    });
    await expect(fs.stat(successRoot)).rejects.toMatchObject({ code: "ENOENT" });

    let failRoot = "";
    await expect(
      withEphemeralWorkspace({}, async (ws) => {
        failRoot = ws.root;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(failRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("run / runInWorker with ephemeralFs", () => {
  it("injects workdir, overrides grant, wipes after run and after worker error", async () => {
    const result = await run<string>("workdir", {
      timeoutMs: 100,
      assert: (v) => typeof v === "string" && v.length > 0,
      ephemeralFs: true,
      grant: { workdir: "forged" },
    });
    expect(isVerified(result)).toBe(true);
    if (isVerified(result)) {
      expect(result.value).not.toBe("forged");
      await expect(fs.stat(result.value)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    const seed = await hostFile("answer.txt", "42");
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "airlock-base-"));
    leftovers.push(baseDir);

    const failed = await runInWorker(
      `(() => {
        const fs = require('node:fs');
        const path = require('node:path');
        fs.writeFileSync(path.join(workdir, 'guest.out'), 'x');
        throw new Error('after-write');
      })()`,
      {
        timeoutMs: 2000,
        assert: () => true,
        ephemeralFs: { baseDir, prefix: "run-" },
        allowedModules: ["fs", "path"],
      },
    );
    expect(failed.status).toBe("error");
    expect(
      (await fs.readdir(baseDir)).filter((n) => n.startsWith("run-")),
    ).toEqual([]);

    const ok = await runInWorker<{ body: string; writeCode: string; workdir: string }>(
      `(() => {
        const fs = require('node:fs');
        const path = require('node:path');
        const p = path.join(workdir, 'data', 'answer.txt');
        const body = fs.readFileSync(p, 'utf8');
        let writeCode = 'ok';
        try { fs.writeFileSync(p, 'nope'); } catch (e) { writeCode = e && e.code; }
        return { body, writeCode, workdir };
      })()`,
      {
        timeoutMs: 2000,
        assert: (v) =>
          v != null &&
          v.body === "42" &&
          (v.writeCode === "EACCES" || v.writeCode === "EPERM"),
        ephemeralFs: {
          baseDir,
          prefix: "run-",
          fixtures: { "data/answer.txt": seed },
        },
        allowedModules: ["fs", "path"],
      },
    );
    expect(ok.status).toBe("ok");
    if (isVerified(ok)) {
      await expect(fs.stat(ok.value.workdir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await expect(fs.readFile(seed, "utf8")).resolves.toBe("42");
  });
});
