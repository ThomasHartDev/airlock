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

describe.runIf(dockerReady)("runInDocker contract", () => {
  it("returns verified ok for a simple expression", async () => {
    const ok = await runInDocker<number>("40 + 2", {
      timeoutMs: 60_000,
      assert: (v) => v === 42,
    });
    expect(ok.status).toBe("ok");
    if (isVerified(ok)) expect(ok.value).toBe(42);
  }, 90_000);

  it("returns assertion-failed with the raw value", async () => {
    expect(
      await runInDocker<number>("41", { timeoutMs: 60_000, assert: (v) => v === 42 }),
    ).toEqual({ status: "assertion-failed", value: 41 });
  }, 90_000);

  it("passes JSON-serializable grants into the guest", async () => {
    expect(
      await runInDocker<number>("rows.length + base", {
        timeoutMs: 60_000,
        assert: (v) => v === 5,
        grant: { rows: [1, 2, 3], base: 2 },
      }),
    ).toMatchObject({ status: "ok", value: 5 });
  }, 90_000);

  it("awaits thenables from guest code", async () => {
    expect(
      await runInDocker<string>("Promise.resolve('hi')", {
        timeoutMs: 60_000,
        assert: (v) => v === "hi",
      }),
    ).toMatchObject({ status: "ok", value: "hi" });
  }, 90_000);

  it("rejects non-JSON-serializable grants before docker spawn", async () => {
    expect(
      (
        await runInDocker("1", {
          timeoutMs: 5_000,
          assert: () => true,
          grant: { add: (a: number, b: number) => a + b },
        })
      ).status,
    ).toBe("error");
  });

  it("surfaces thrown guest errors", async () => {
    const threw = await runInDocker("throw new Error('boom')", {
      timeoutMs: 60_000,
      assert: () => true,
    });
    expect(threw.status).toBe("error");
    if (threw.status === "error") expect((threw.error as Error).message).toBe("boom");
  }, 90_000);

  it("times out sync spins and never-settling promises", async () => {
    expect(
      await runInDocker("while (true) {}", { timeoutMs: 2_000, assert: () => true }),
    ).toEqual({ status: "timeout", timeoutMs: 2_000 });
    expect(
      await runInDocker("new Promise(() => {})", { timeoutMs: 1_500, assert: () => true }),
    ).toEqual({ status: "timeout", timeoutMs: 1_500 });
  }, 90_000);

  it("aborts via signal and force-removes the named container", async () => {
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
  }, 90_000);

  it("rejects non-positive timeoutMs before spawn", async () => {
    await expect(runInDocker("1", { timeoutMs: 0, assert: () => true })).rejects.toThrow(
      RangeError,
    );
  });

  it("refuses oversized output under maxOutputBytes", async () => {
    expect(
      (
        await runInDocker("'x'.repeat(10_000)", {
          timeoutMs: 60_000,
          assert: () => true,
          maxOutputBytes: 64,
        })
      ).status,
    ).toBe("output-too-large");
  }, 90_000);

  it("preserves DEFAULT_DOCKER_IMAGE pin", () => {
    expect(DEFAULT_DOCKER_IMAGE).toBe("node:20-alpine");
  });
});

describe.runIf(dockerReady)("runInDocker value fidelity", () => {
  it("round-trips NaN under status ok (not null)", async () => {
    const result = await runInDocker<number>("NaN", {
      timeoutMs: 60_000,
      assert: (v) => Number.isNaN(v),
    });
    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(Number.isNaN(result.value)).toBe(true);
      expect(result.value).not.toBe(null);
    }
  }, 90_000);

  it("round-trips Infinity under status ok (not null)", async () => {
    const result = await runInDocker<number>("Infinity", {
      timeoutMs: 60_000,
      assert: (v) => v === Infinity,
    });
    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value).toBe(Infinity);
      expect(result.value).not.toBe(null);
    }
  }, 90_000);

  it("round-trips Map entries under status ok", async () => {
    const result = await runInDocker<Map<string, number>>("new Map([['a', 1], ['b', 2]])", {
      timeoutMs: 60_000,
      assert: (v) => v instanceof Map && v.get("a") === 1 && v.get("b") === 2,
    });
    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value).toBeInstanceOf(Map);
      expect(result.value.size).toBe(2);
      expect(result.value.get("a")).toBe(1);
      expect(result.value.get("b")).toBe(2);
    }
  }, 90_000);

  it("round-trips Uint8Array under status ok", async () => {
    const result = await runInDocker<Uint8Array>("new Uint8Array([1, 2, 3, 4])", {
      timeoutMs: 60_000,
      assert: (v) => v instanceof Uint8Array && v.length === 4 && v[0] === 1 && v[3] === 4,
    });
    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value).toBeInstanceOf(Uint8Array);
      expect(Array.from(result.value)).toEqual([1, 2, 3, 4]);
    }
  }, 90_000);

  it("round-trips Date under status ok as a Date instance", async () => {
    const result = await runInDocker<Date>("new Date('2020-01-15T12:00:00.000Z')", {
      timeoutMs: 60_000,
      assert: (v) => v instanceof Date && v.toISOString() === "2020-01-15T12:00:00.000Z",
    });
    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value).toBeInstanceOf(Date);
      expect(result.value.toISOString()).toBe("2020-01-15T12:00:00.000Z");
    }
  }, 90_000);

  it("fails closed when the return value is not structured-cloneable", async () => {
    const result = await runInDocker("() => 1", {
      timeoutMs: 60_000,
      assert: () => true,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      const err = result.error as Error & { code?: string };
      expect(err.code === "ERR_AIRLOCK_VALUE_NOT_CLONEABLE" || /clone|serialize|could not be cloned/i.test(err.message)).toBe(
        true,
      );
    }
  }, 90_000);
});

describe.runIf(dockerReady)("runInDocker resource limits", () => {
  it("reports out-of-memory when the cgroup ceiling is hit", async () => {
    const maxMemoryMb = 32;
    const result = await runInDocker(
      escape(
        "const acc=[];while(true){acc.push(Buffer.alloc(1<<20));}",
      ),
      { timeoutMs: 60_000, assert: () => true, maxMemoryMb },
    );
    expect(result.status).toBe("out-of-memory");
    if (result.status === "out-of-memory") {
      expect(result.maxOldGenerationSizeMb).toBe(maxMemoryMb);
    }
  }, 90_000);
});

describe.runIf(dockerReady)("runInDocker isolation", () => {
  it("does not leak host process.env into the guest", async () => {
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
  }, 90_000);

  it("blocks outbound network connects under network-none", async () => {
    const net = await runInDocker<string>(
      escape(
        "const n=process.getBuiltinModule('net');return new Promise(r=>{const s=n.connect(80,'1.1.1.1',()=>r('connected'));s.on('error',e=>r(e.code||e.message));setTimeout(()=>{s.destroy();r('hung');},2000);});",
      ),
      { timeoutMs: 60_000, assert: (v) => v !== "connected" },
    );
    expect(net.status).toBe("ok");
    if (isVerified(net)) expect(net.value).not.toBe("connected");
  }, 90_000);

  it("blocks writes to the read-only rootfs", async () => {
    const write = await runInDocker<string>(
      escape(
        "const fs=process.getBuiltinModule('fs');try{fs.writeFileSync('/etc/airlock-write-test','x');return 'wrote';}catch(e){return e.code||e.message;}",
      ),
      { timeoutMs: 60_000, assert: (v) => v !== "wrote" },
    );
    expect(write.status).toBe("ok");
    if (isVerified(write)) expect(["EROFS", "EACCES"]).toContain(write.value);
  }, 90_000);

  it("cannot see host-only marker paths outside the bind mount", async () => {
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
  }, 90_000);
});

describe.runIf(!dockerReady)("runInDocker (docker unavailable)", () => {
  it("skips live cases when the daemon is unreachable", () => {
    expect(dockerReady).toBe(false);
  });
});
