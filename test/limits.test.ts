import { describe, expect, it } from "vitest";
import {
  checkOutputSize,
  isVerified,
  measureOutputBytes,
  run,
  runInWorker,
  runVerified,
  validateResourceLimits,
} from "../src/index.js";

describe("validateResourceLimits", () => {
  it("accepts a finite positive timeout", () => {
    expect(() => validateResourceLimits({ timeoutMs: 1 })).not.toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a bad timeoutMs: %s",
    (timeoutMs) => {
      expect(() => validateResourceLimits({ timeoutMs })).toThrow(RangeError);
    },
  );

  it.each([0, -4, 1.5, Number.NaN])(
    "rejects a bad maxOldGenerationSizeMb: %s",
    (maxOldGenerationSizeMb) => {
      expect(() =>
        validateResourceLimits({ timeoutMs: 10, maxOldGenerationSizeMb }),
      ).toThrow(RangeError);
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a bad maxOutputBytes: %s",
    (maxOutputBytes) => {
      expect(() =>
        validateResourceLimits({ timeoutMs: 10, maxOutputBytes }),
      ).toThrow(RangeError);
    },
  );

  it("allows maxOutputBytes of 0 (only empty payloads pass)", () => {
    expect(() =>
      validateResourceLimits({ timeoutMs: 10, maxOutputBytes: 0 }),
    ).not.toThrow();
  });
});

describe("measureOutputBytes", () => {
  it("counts empty and nullish values as zero", () => {
    expect(measureOutputBytes(null).bytes).toBe(0);
    expect(measureOutputBytes(undefined).bytes).toBe(0);
    expect(measureOutputBytes("").bytes).toBe(0);
  });

  it("counts UTF-8 string payload, not code units", () => {
    // "€" is one code point, three UTF-8 bytes
    expect(measureOutputBytes("€").bytes).toBe(3);
    expect(measureOutputBytes("hi").bytes).toBe(2);
  });

  it("walks arrays and plain objects", () => {
    expect(measureOutputBytes([1, 2]).bytes).toBe(16);
    expect(measureOutputBytes({ a: "bb" }).bytes).toBe(3); // key "a" + "bb"
  });

  it("stops once the budget is exceeded", () => {
    const size = measureOutputBytes("abcdefghij", 4);
    expect(size.exceeded).toBe(true);
    expect(size.bytes).toBeGreaterThan(4);
  });

  it("does not hang on cyclic structures", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const size = measureOutputBytes(cyclic);
    expect(size.exceeded).toBe(false);
    expect(size.bytes).toBe(Buffer.byteLength("self", "utf8"));
  });

  it("counts TypedArray and ArrayBuffer by byteLength", () => {
    expect(measureOutputBytes(new Uint8Array(32)).bytes).toBe(32);
    expect(measureOutputBytes(new ArrayBuffer(16)).bytes).toBe(16);
  });

  it("checkOutputSize mirrors measure with a budget", () => {
    expect(checkOutputSize("abcd", 4)).toEqual({ bytes: 4, exceeded: false });
    expect(checkOutputSize("abcde", 4).exceeded).toBe(true);
  });
});

describe("maxOutputBytes on runVerified", () => {
  it("accepts a value under the cap and still applies the assertion", async () => {
    const result = await runVerified(() => "ok", {
      timeoutMs: 100,
      maxOutputBytes: 16,
      assert: (v) => v === "ok",
    });

    expect(result).toMatchObject({ status: "ok", value: "ok" });
    expect(isVerified(result)).toBe(true);
  });

  it("refuses an oversized string without running a passing assertion as ok", async () => {
    let asserted = false;
    const result = await runVerified(() => "x".repeat(100), {
      timeoutMs: 100,
      maxOutputBytes: 10,
      assert: () => {
        asserted = true;
        return true;
      },
    });

    expect(result.status).toBe("output-too-large");
    if (result.status === "output-too-large") {
      expect(result.maxOutputBytes).toBe(10);
      expect(result.actualBytes).toBeGreaterThan(10);
    }
    expect(asserted).toBe(false);
  });

  it("treats maxOutputBytes of 0 as refusing any non-empty payload", async () => {
    const empty = await runVerified(() => null, {
      timeoutMs: 100,
      maxOutputBytes: 0,
      assert: () => true,
    });
    expect(empty.status).toBe("ok");

    const nonEmpty = await runVerified(() => "a", {
      timeoutMs: 100,
      maxOutputBytes: 0,
      assert: () => true,
    });
    expect(nonEmpty.status).toBe("output-too-large");
  });

  it("accepts a value exactly at the boundary", async () => {
    const result = await runVerified(() => "abcd", {
      timeoutMs: 100,
      maxOutputBytes: 4,
      assert: (v) => v === "abcd",
    });
    expect(result).toMatchObject({ status: "ok", value: "abcd" });
  });
});

describe("maxOutputBytes on run and runInWorker", () => {
  it("caps sandbox output before verification", async () => {
    const result = await run("'z'.repeat(50)", {
      timeoutMs: 100,
      maxOutputBytes: 8,
      assert: () => true,
    });
    expect(result.status).toBe("output-too-large");
  });

  it("lets a small sandbox value through", async () => {
    const result = await run("'hi'", {
      timeoutMs: 100,
      maxOutputBytes: 8,
      assert: (v) => v === "hi",
    });
    expect(result).toMatchObject({ status: "ok", value: "hi" });
  });

  it("caps worker isolate output after structured clone", async () => {
    const result = await runInWorker("'w'.repeat(200)", {
      timeoutMs: 1000,
      maxOutputBytes: 32,
      assert: () => true,
    });
    expect(result.status).toBe("output-too-large");
    if (result.status === "output-too-large") {
      expect(result.actualBytes).toBeGreaterThan(32);
    }
  });

  it("rejects invalid maxOutputBytes at the worker boundary", () => {
    expect(() =>
      runInWorker("1", { timeoutMs: 100, maxOutputBytes: -1, assert: () => true }),
    ).toThrow(RangeError);
  });
});

describe("wall-clock timeout terminates the worker on abort", () => {
  it("hard-kills a never-settling isolate within the deadline window", async () => {
    const started = performance.now();
    const result = await runInWorker("new Promise(() => {})", {
      timeoutMs: 80,
      assert: () => true,
    });
    const elapsed = performance.now() - started;

    expect(result).toEqual({ status: "timeout", timeoutMs: 80 });
    // terminate() should reclaim the thread promptly after the timer fires
    expect(elapsed).toBeLessThan(1500);
  });

  it("terminates the isolate when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = runInWorker("new Promise(() => {})", {
      timeoutMs: 10_000,
      assert: () => true,
      signal: controller.signal,
    });
    controller.abort(new Error("stop"));
    const result = await pending;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).message).toBe("stop");
    }
  });
});

describe("memory cap on the worker isolate", () => {
  it("reports out-of-memory when the heap ceiling is hit", async () => {
    const result = await runInWorker(
      "const acc = []; while (true) { acc.push(new Array(1_000_000).fill(0)); }",
      { timeoutMs: 10_000, assert: () => true, maxOldGenerationSizeMb: 16 },
    );

    expect(result.status).toBe("out-of-memory");
    if (result.status === "out-of-memory") {
      expect(result.maxOldGenerationSizeMb).toBe(16);
    }
  }, 15_000);

  it("rejects a non-positive heap cap before starting a worker", () => {
    expect(() =>
      runInWorker("1", {
        timeoutMs: 100,
        maxOldGenerationSizeMb: 0,
        assert: () => true,
      }),
    ).toThrow(RangeError);
  });
});
