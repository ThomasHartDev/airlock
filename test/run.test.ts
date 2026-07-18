import { describe, expect, it } from "vitest";
import { isVerified, runVerified } from "../src/index.js";

describe("runVerified", () => {
  it("returns ok with the value when the assertion passes", async () => {
    const result = await runVerified(() => 21 * 2, {
      timeoutMs: 100,
      assert: (v) => v === 42,
    });

    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value).toBe(42);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses the value when the assertion fails", async () => {
    const result = await runVerified(() => 41, {
      timeoutMs: 100,
      assert: (v) => v === 42,
    });

    expect(result).toEqual({ status: "assertion-failed", value: 41 });
    expect(isVerified(result)).toBe(false);
  });

  it("supports async tasks and async post-conditions", async () => {
    const result = await runVerified(
      async () => {
        await Promise.resolve();
        return "ok";
      },
      { timeoutMs: 100, assert: async (v) => v.length === 2 },
    );

    expect(result).toMatchObject({ status: "ok", value: "ok" });
  });

  it("times out and aborts the task when the deadline passes", async () => {
    let aborted = false;
    const result = await runVerified(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(0);
          });
        }),
      { timeoutMs: 10, assert: () => true },
    );

    expect(result).toEqual({ status: "timeout", timeoutMs: 10 });
    expect(aborted).toBe(true);
  });

  it("captures a thrown error instead of rejecting", async () => {
    const boom = new Error("boom");
    const result = await runVerified(
      () => {
        throw boom;
      },
      { timeoutMs: 100, assert: () => true },
    );

    expect(result).toEqual({ status: "error", error: boom });
  });

  it("treats a throwing assertion as an error", async () => {
    const result = await runVerified(() => 1, {
      timeoutMs: 100,
      assert: () => {
        throw new Error("bad post-condition");
      },
    });

    expect(result.status).toBe("error");
  });

  it("honors a caller-supplied abort signal", async () => {
    const controller = new AbortController();
    const pending = runVerified(
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      { timeoutMs: 1000, assert: () => true, signal: controller.signal },
    );

    controller.abort(new Error("caller cancelled"));
    const result = await pending;

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).message).toBe("caller cancelled");
    }
  });

  it("returns immediately when the caller signal is already aborted", async () => {
    const result = await runVerified((signal) => {
      signal.throwIfAborted();
      return 1;
    }, {
      timeoutMs: 1000,
      assert: () => true,
      signal: AbortSignal.abort(new Error("pre-cancelled")),
    });

    expect(result.status).toBe("error");
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-finite timeout: %s",
    async (bad) => {
      await expect(
        runVerified(() => 1, { timeoutMs: bad, assert: () => true }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );

  it("keeps concurrent runs isolated from each other", async () => {
    const results = await Promise.all([
      runVerified(() => 1, { timeoutMs: 100, assert: (v) => v === 1 }),
      runVerified(
        (signal) =>
          new Promise<number>((resolve) =>
            signal.addEventListener("abort", () => resolve(2)),
          ),
        { timeoutMs: 10, assert: () => true },
      ),
      runVerified(() => 3, { timeoutMs: 100, assert: () => false }),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "ok",
      "timeout",
      "assertion-failed",
    ]);
  });
});
