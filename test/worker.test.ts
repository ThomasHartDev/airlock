import { describe, expect, it } from "vitest";
import {
  FROZEN_INTRINSICS,
  freezeRealm,
  isVerified,
  runInWorker,
} from "../src/index.js";

describe("runInWorker", () => {
  it("evaluates untrusted source in the isolate and returns the verified value", async () => {
    const result = await runInWorker<number>("40 + 2", {
      timeoutMs: 1000,
      assert: (v) => v === 42,
    });

    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value).toBe(42);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses the value when the post-condition fails", async () => {
    const result = await runInWorker<number>("41", {
      timeoutMs: 1000,
      assert: (v) => v === 42,
    });

    expect(result).toEqual({ status: "assertion-failed", value: 41 });
    expect(isVerified(result)).toBe(false);
  });

  it("awaits a promise the code evaluates to", async () => {
    const result = await runInWorker<string>("Promise.resolve('hi')", {
      timeoutMs: 1000,
      assert: (v) => v === "hi",
    });

    expect(result).toMatchObject({ status: "ok", value: "hi" });
  });

  it("passes structured-cloneable capabilities through grant", async () => {
    const result = await runInWorker<number>("rows.length + base", {
      timeoutMs: 1000,
      assert: (v) => v === 5,
      grant: { rows: [1, 2, 3], base: 2 },
    });

    expect(result).toMatchObject({ status: "ok", value: 5 });
  });

  it("returns an error when a grant is not structured-cloneable", async () => {
    const result = await runInWorker<number>("add(1, 2)", {
      timeoutMs: 1000,
      assert: () => true,
      grant: { add: (a: number, b: number) => a + b },
    });

    expect(result.status).toBe("error");
  });

  it("captures a runtime throw as an error result", async () => {
    const result = await runInWorker("throw new Error('boom')", {
      timeoutMs: 1000,
      assert: () => true,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).message).toBe("boom");
    }
  });

  it("hard-kills a synchronous infinite loop as a timeout", async () => {
    const result = await runInWorker("while (true) {}", {
      timeoutMs: 100,
      assert: () => true,
    });

    expect(result).toEqual({ status: "timeout", timeoutMs: 100 });
  });

  it("times out on an async task that never settles", async () => {
    const result = await runInWorker("new Promise(() => {})", {
      timeoutMs: 100,
      assert: () => true,
    });

    expect(result).toEqual({ status: "timeout", timeoutMs: 100 });
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const pending = runInWorker("new Promise(() => {})", {
      timeoutMs: 5000,
      assert: () => true,
      signal: controller.signal,
    });
    controller.abort(reason);

    const result = await pending;
    expect(result).toEqual({ status: "error", error: reason });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-finite timeout: %s",
    (bad) => {
      expect(() =>
        runInWorker("1", { timeoutMs: bad, assert: () => true }),
      ).toThrow(RangeError);
    },
  );

  it("enforces a heap cap and reports out-of-memory", async () => {
    const result = await runInWorker(
      "const acc = []; while (true) { acc.push(new Array(1_000_000).fill(0)); }",
      { timeoutMs: 10_000, assert: () => true, maxOldGenerationSizeMb: 16 },
    );

    expect(result.status).toBe("out-of-memory");
    if (result.status === "out-of-memory") {
      expect(result.maxOldGenerationSizeMb).toBe(16);
    }
  }, 15_000);
});

describe("worker zero-credential invariant", () => {
  it.each(["process", "require", "fetch", "Buffer", "setTimeout"])(
    "denies ambient access to %s inside the vm context",
    async (name) => {
      const result = await runInWorker<string>(`typeof ${name}`, {
        timeoutMs: 1000,
        assert: (v) => v === "undefined",
      });

      expect(result).toMatchObject({ status: "ok", value: "undefined" });
    },
  );

  it("starts the isolate with an empty process.env, even for a host secret", async () => {
    const key = "AIRLOCK_HOST_SECRET";
    process.env[key] = "super-secret-token";
    try {
      // Reach the worker realm's process via the constructor walk that escapes
      // the vm context, then read env. The host secret must not be there.
      const result = await runInWorker<string>(
        `this.constructor.constructor("return typeof process.env.${key}")()`,
        { timeoutMs: 1000, assert: (v) => v === "undefined" },
      );

      expect(result).toMatchObject({ status: "ok", value: "undefined" });
    } finally {
      delete process.env[key];
    }
  });
});

describe("freezeRealm", () => {
  it("freezes each named intrinsic, its prototype, and the root", () => {
    const proto = {};
    const fake = () => {};
    (fake as { prototype?: unknown }).prototype = proto;
    const root: Record<string, unknown> = { Object: fake, ignored: 1 };

    freezeRealm(root, ["Object"]);

    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(fake)).toBe(true);
    expect(Object.isFrozen(proto)).toBe(true);
  });

  it("skips names absent from the realm without throwing", () => {
    const root: Record<string, unknown> = {};
    expect(() => freezeRealm(root, ["Nonexistent"])).not.toThrow();
    expect(Object.isFrozen(root)).toBe(true);
  });

  it("covers the core intrinsics used by untrusted code", () => {
    expect(FROZEN_INTRINSICS).toContain("Object");
    expect(FROZEN_INTRINSICS).toContain("Function");
    expect(FROZEN_INTRINSICS).toContain("Array");
  });
});
