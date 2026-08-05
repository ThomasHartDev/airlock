import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_MAX_WIRE_BYTES,
  DOCKER_CONTAINER_NAME_PREFIX,
  dockerSecurityArgs,
  isDockerAvailable,
  isVerified,
  runInDocker,
  uniqueContainerName,
  wireByteLimit,
} from "../src/index.js";

const dockerReady = await isDockerAvailable();
const escape = (body: string) =>
  `this.constructor.constructor(${JSON.stringify(body)})()`;
describe("dockerSecurityArgs", () => {
  it("pins network-none, read-only, cap-drop, names, and wire caps", () => {
    expect(dockerSecurityArgs()).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
        "65534:65534",
      ]),
    );
    expect(dockerSecurityArgs({ maxMemoryMb: 64 })).toContain("64m");
    expect(uniqueContainerName().startsWith(DOCKER_CONTAINER_NAME_PREFIX)).toBe(true);
    expect(wireByteLimit()).toBe(DEFAULT_MAX_WIRE_BYTES);
    expect(wireByteLimit(64)).toBeGreaterThanOrEqual(64);
  });
});
describe.runIf(dockerReady)("runInDocker", () => {
  it("covers contract, limits, abort cleanup, and isolation escapes", async () => {
    const ok = await runInDocker<number>("40 + 2", {
      timeoutMs: 60_000,
      assert: (v) => v === 42,
    });
    expect(ok.status).toBe("ok");
    if (isVerified(ok)) expect(ok.value).toBe(42);
    expect(
      await runInDocker<number>("41", { timeoutMs: 60_000, assert: (v) => v === 42 }),
    ).toEqual({ status: "assertion-failed", value: 41 });
    expect(
      await runInDocker<number>("rows.length + base", {
        timeoutMs: 60_000,
        assert: (v) => v === 5,
        grant: { rows: [1, 2, 3], base: 2 },
      }),
    ).toMatchObject({ status: "ok", value: 5 });
    expect(
      await runInDocker<string>("Promise.resolve('hi')", {
        timeoutMs: 60_000,
        assert: (v) => v === "hi",
      }),
    ).toMatchObject({ status: "ok", value: "hi" });
    expect(
      (
        await runInDocker("1", {
          timeoutMs: 5_000,
          assert: () => true,
          grant: { add: (a: number, b: number) => a + b },
        })
      ).status,
    ).toBe("error");
    const threw = await runInDocker("throw new Error('boom')", {
      timeoutMs: 60_000,
      assert: () => true,
    });
    expect(threw.status).toBe("error");
    if (threw.status === "error") expect((threw.error as Error).message).toBe("boom");
    expect(
      await runInDocker("while (true) {}", { timeoutMs: 2_000, assert: () => true }),
    ).toEqual({ status: "timeout", timeoutMs: 2_000 });
    expect(
      await runInDocker("new Promise(() => {})", { timeoutMs: 1_500, assert: () => true }),
    ).toEqual({ status: "timeout", timeoutMs: 1_500 });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const pending = runInDocker("new Promise(() => {})", {
      timeoutMs: 120_000,
      assert: () => true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 300);
    expect(await pending).toEqual({ status: "error", error: reason });
    await new Promise((r) => setTimeout(r, 400));
    const ps = spawnSync(
      "docker",
      ["ps", "--filter", `name=${DOCKER_CONTAINER_NAME_PREFIX}`, "--format", "{{.Names}}"],
      { encoding: "utf8" },
    );
    expect((ps.stdout ?? "").trim()).toBe("");
    await expect(runInDocker("1", { timeoutMs: 0, assert: () => true })).rejects.toThrow(
      RangeError,
    );
    expect(
      (
        await runInDocker("'x'.repeat(10_000)", {
          timeoutMs: 60_000,
          assert: () => true,
          maxOutputBytes: 64,
        })
      ).status,
    ).toBe("output-too-large");
    const key = "AIRLOCK_HOST_SECRET";
    process.env[key] = "super-secret-token";
    try {
      expect(
        (
          await runInDocker(escape(`return process.env.${key}`), {
            timeoutMs: 60_000,
            assert: (v) => v === undefined || v === "",
          })
        ).status,
      ).toBe("ok");
    } finally {
      delete process.env[key];
    }
    const net = await runInDocker<string>(
      escape(
        "const n=process.getBuiltinModule('net');return new Promise(r=>{const s=n.connect(80,'1.1.1.1',()=>r('connected'));s.on('error',e=>r(e.code||e.message));setTimeout(()=>{s.destroy();r('hung');},2000);});",
      ),
      { timeoutMs: 60_000, assert: (v) => v !== "connected" },
    );
    expect(net.status).toBe("ok");
    if (isVerified(net)) expect(net.value).not.toBe("connected");
    const write = await runInDocker<string>(
      escape(
        "const fs=process.getBuiltinModule('fs');try{fs.writeFileSync('/etc/airlock-write-test','x');return 'wrote';}catch(e){return e.code||e.message;}",
      ),
      { timeoutMs: 60_000, assert: (v) => v !== "wrote" },
    );
    expect(write.status).toBe("ok");
    if (isVerified(write)) expect(["EROFS", "EACCES"]).toContain(write.value);
    const markerPath = join(tmpdir(), `airlock-host-only-${randomBytes(8).toString("hex")}`);
    writeFileSync(markerPath, "host-only", "utf8");
    try {
      const probe = await runInDocker(
        escape(
          `const fs=process.getBuiltinModule('fs');return fs.existsSync(${JSON.stringify(markerPath)});`,
        ),
        { timeoutMs: 60_000, assert: (v) => v === false },
      );
      expect(probe).toMatchObject({ status: "ok", value: false });
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        /* ignore */
      }
    }
    expect(DEFAULT_DOCKER_IMAGE).toBe("node:20-alpine");
  }, 240_000);
});
describe.runIf(!dockerReady)("runInDocker (docker unavailable)", () => {
  it("skips live cases when the daemon is unreachable", () => {
    expect(dockerReady).toBe(false);
  });
});
