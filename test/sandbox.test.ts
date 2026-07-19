import { describe, expect, it } from "vitest";
import {
  DENIED_AMBIENT_NAMES,
  ZeroCredentialViolation,
  isVerified,
  probeAmbientAuthority,
  run,
} from "../src/index.js";
import * as vm from "node:vm";

describe("run", () => {
  it("evaluates untrusted source and returns the verified value", async () => {
    const result = await run<number>("40 + 2", {
      timeoutMs: 100,
      assert: (v) => v === 42,
    });

    expect(result.status).toBe("ok");
    if (isVerified(result)) expect(result.value).toBe(42);
  });

  it("refuses the value when the post-condition fails", async () => {
    const result = await run<number>("41", {
      timeoutMs: 100,
      assert: (v) => v === 42,
    });

    expect(result).toEqual({ status: "assertion-failed", value: 41 });
    expect(isVerified(result)).toBe(false);
  });

  it("awaits a promise the code evaluates to", async () => {
    const result = await run<string>("Promise.resolve('hi')", {
      timeoutMs: 100,
      assert: (v) => v === "hi",
    });

    expect(result).toMatchObject({ status: "ok", value: "hi" });
  });

  it("captures a runtime throw as an error result", async () => {
    const result = await run("throw new Error('boom')", {
      timeoutMs: 100,
      assert: () => true,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).message).toBe("boom");
    }
  });

  it("returns an error result for a syntax error instead of throwing", async () => {
    const result = await run("this is not valid js (", {
      timeoutMs: 100,
      assert: () => true,
    });

    expect(result.status).toBe("error");
  });

  it("preempts a synchronous infinite loop as a timeout", async () => {
    const result = await run("while (true) {}", {
      timeoutMs: 25,
      assert: () => true,
    });

    expect(result).toEqual({ status: "timeout", timeoutMs: 25 });
  });

  it("times out on an async task that never settles", async () => {
    const result = await run("new Promise(() => {})", {
      timeoutMs: 25,
      assert: () => true,
    });

    expect(result).toEqual({ status: "timeout", timeoutMs: 25 });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-finite timeout: %s",
    async (bad) => {
      await expect(
        run("1", { timeoutMs: bad, assert: () => true }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );
});

describe("zero-credential invariant", () => {
  it.each(DENIED_AMBIENT_NAMES)(
    "denies ambient access to %s by default",
    async (name) => {
      const result = await run<string>(`typeof ${name}`, {
        timeoutMs: 100,
        assert: (v) => v === "undefined",
      });

      expect(result).toMatchObject({ status: "ok", value: "undefined" });
    },
  );

  it("cannot read a secret placed on the host global object", async () => {
    const key = "__airlock_test_secret__";
    (globalThis as Record<string, unknown>)[key] = "super-secret-token";
    try {
      const result = await run<string>(`typeof globalThis.${key}`, {
        timeoutMs: 100,
        assert: (v) => v === "undefined",
      });
      expect(result).toMatchObject({ status: "ok", value: "undefined" });
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  });

  it("grants only the capabilities the caller hands in", async () => {
    let called = 0;
    const result = await run<number>("greet(2)", {
      timeoutMs: 100,
      assert: (v) => v === 4,
      grant: {
        greet: (n: number) => {
          called += 1;
          return n * 2;
        },
      },
    });

    expect(result).toMatchObject({ status: "ok", value: 4 });
    expect(called).toBe(1);
  });

  it("probeAmbientAuthority reports leaked authority and fails closed", () => {
    const clean = vm.createContext({});
    expect(probeAmbientAuthority(clean, [])).toEqual([]);

    const dirty = vm.createContext({ process });
    const leaked = probeAmbientAuthority(dirty, []);
    expect(leaked).toContain("process");
    // an explicit grant of the same name is authority the caller chose, not a leak
    expect(probeAmbientAuthority(dirty, ["process"])).not.toContain("process");

    const violation = new ZeroCredentialViolation(leaked);
    expect(violation).toBeInstanceOf(Error);
    expect(violation.leaked).toEqual(leaked);
    expect(violation.message).toContain("process");
  });
});

describe("documented escape attempts", () => {
  it("blocks the sandbox-realm Function constructor from reaching the host", async () => {
    const result = await run<string>(
      `({}).constructor.constructor("return typeof process")()`,
      { timeoutMs: 100, assert: () => true },
    );

    // The per-context Object's Function compiles in the sandbox realm, so the
    // host `process` stays out of reach.
    expect(result).toMatchObject({ status: "ok", value: "undefined" });
  });

  it("pins the known in-process gap: the global proto chain reaches the host realm", async () => {
    const result = await run<string>(
      `this.constructor.constructor("return typeof process")()`,
      { timeoutMs: 100, assert: () => true },
    );

    // `this.constructor` borrows the HOST `Object`, so its Function escapes the
    // context. node:vm cannot close this in-process; the isolate and container
    // tiers do. This test documents the boundary rather than pretending it holds.
    expect(result).toMatchObject({ status: "ok", value: "object" });
  });
});
