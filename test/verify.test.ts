import { describe, expect, it } from "vitest";
import {
  allAssertions,
  anyAssertion,
  isVerified,
  normalizeAssertOutcome,
  run,
  runInWorker,
  runVerified,
  selfVerify,
} from "../src/index.js";

describe("selfVerify", () => {
  it("returns verified:true only when the assertion passes", async () => {
    const pass = await selfVerify(42, (n) => n === 42);
    const fail = await selfVerify(41, (n) => n === 42);

    expect(pass).toEqual({ verified: true, value: 42 });
    expect(fail).toEqual({ verified: false, value: 41 });
  });

  it("accepts structured { pass } outcomes and carries a reason on failure", async () => {
    const pass = await selfVerify("x", () => ({ pass: true as const }));
    const fail = await selfVerify("x", () => ({
      pass: false as const,
      reason: "expected a number",
    }));

    expect(pass).toEqual({ verified: true, value: "x" });
    expect(fail).toEqual({
      verified: false,
      value: "x",
      reason: "expected a number",
    });
  });

  it("supports async assertions and empty-input edge cases", async () => {
    const ok = await selfVerify([1, 2, 3], async (xs) => {
      await Promise.resolve();
      return xs.length === 3;
    });
    const empty = await selfVerify("", (s) => s.length > 0);
    expect(ok).toEqual({ verified: true, value: [1, 2, 3] });
    expect(empty).toEqual({ verified: false, value: "" });
  });

  it("keeps concurrent self-verifies independent", async () => {
    const results = await Promise.all([
      selfVerify(1, (n) => n === 1),
      selfVerify(2, () => false),
      selfVerify(3, async () => ({ pass: true as const })),
    ]);
    expect(results.map((r) => r.verified)).toEqual([true, false, true]);
  });
});

describe("normalizeAssertOutcome", () => {
  it("maps boolean and structured forms", () => {
    expect(normalizeAssertOutcome(true)).toEqual({ passed: true });
    expect(normalizeAssertOutcome(false)).toEqual({ passed: false });
    expect(normalizeAssertOutcome({ pass: true })).toEqual({ passed: true });
    expect(normalizeAssertOutcome({ pass: false, reason: "nope" })).toEqual({
      passed: false,
      reason: "nope",
    });
  });
});

describe("assertion composition", () => {
  it("allAssertions requires every check and surfaces the first reason", async () => {
    const check = allAssertions<{ n: number }>(
      (v) =>
        v.n > 0
          ? { pass: true }
          : { pass: false, reason: "must be positive" },
      (v) =>
        v.n % 2 === 0
          ? { pass: true }
          : { pass: false, reason: "must be even" },
    );
    expect(await selfVerify({ n: 4 }, check)).toEqual({
      verified: true,
      value: { n: 4 },
    });
    expect(await selfVerify({ n: -1 }, check)).toEqual({
      verified: false,
      value: { n: -1 },
      reason: "must be positive",
    });
    expect(await selfVerify({ n: 3 }, check)).toEqual({
      verified: false,
      value: { n: 3 },
      reason: "must be even",
    });
  });

  it("anyAssertion passes when one check succeeds; empty all/any edges", async () => {
    const check = anyAssertion<string>(
      (s) => s.startsWith("http"),
      (s) => s.startsWith("/"),
    );
    expect(await selfVerify("/local", check)).toEqual({
      verified: true,
      value: "/local",
    });
    expect(await selfVerify("ftp://x", check)).toEqual({
      verified: false,
      value: "ftp://x",
    });
    expect(await selfVerify(1, anyAssertion<number>())).toEqual({
      verified: false,
      value: 1,
    });
    expect(await selfVerify(1, allAssertions<number>())).toEqual({
      verified: true,
      value: 1,
    });
  });
});

describe("runVerified self-verification gate", () => {
  it("tags ok with verified:true and refuses with verified:false", async () => {
    const ok = await runVerified(() => 7, {
      timeoutMs: 100,
      assert: (n) => n === 7,
    });
    const refused = await runVerified(() => 7, {
      timeoutMs: 100,
      assert: (n) => n === 0,
    });

    expect(ok).toMatchObject({ status: "ok", verified: true, value: 7 });
    expect(isVerified(ok)).toBe(true);
    if (isVerified(ok)) expect(ok.value).toBe(7);

    expect(refused).toEqual({
      status: "assertion-failed",
      verified: false,
      value: 7,
    });
    expect(isVerified(refused)).toBe(false);
  });

  it("propagates assertion reasons and never verifies failure modes", async () => {
    const reason = await runVerified(() => ({ total: -1 }), {
      timeoutMs: 100,
      assert: (v) =>
        v.total >= 0
          ? { pass: true }
          : { pass: false, reason: "total must be non-negative" },
    });
    const timeout = await runVerified(() => new Promise<number>(() => {}), {
      timeoutMs: 15,
      assert: () => true,
    });
    const oversized = await runVerified(() => "x".repeat(100), {
      timeoutMs: 100,
      assert: () => true,
      maxOutputBytes: 8,
    });

    expect(reason).toEqual({
      status: "assertion-failed",
      verified: false,
      value: { total: -1 },
      reason: "total must be non-negative",
    });
    expect(timeout).toEqual({
      status: "timeout",
      verified: false,
      timeoutMs: 15,
    });
    expect(oversized).toMatchObject({
      status: "output-too-large",
      verified: false,
      maxOutputBytes: 8,
    });
    expect(isVerified(timeout)).toBe(false);
    expect(isVerified(oversized)).toBe(false);
  });

  it("boundary: zero is trusted only when the assertion allows it", async () => {
    const allowZero = await runVerified(() => 0, {
      timeoutMs: 100,
      assert: (n) => n === 0,
    });
    const refuseZero = await runVerified(() => 0, {
      timeoutMs: 100,
      assert: (n) => n > 0,
    });
    expect(allowZero).toMatchObject({ status: "ok", verified: true, value: 0 });
    expect(refuseZero).toEqual({
      status: "assertion-failed",
      verified: false,
      value: 0,
    });
  });
});

describe("sandbox and worker self-verification", () => {
  it("run and runInWorker return verified:true only after the post-condition", async () => {
    const ok = await run<number>("21 * 2", {
      timeoutMs: 100,
      assert: (n) => n === 42,
    });
    const bad = await run<number>("21 * 2", {
      timeoutMs: 100,
      assert: (n) => n === 0,
    });
    const workerOk = await runInWorker<number>(
      "rows.reduce((s, n) => s + n, 0)",
      {
        timeoutMs: 500,
        assert: (total) => total === 6,
        grant: { rows: [1, 2, 3] },
      },
    );
    const workerBad = await runInWorker<number>("99", {
      timeoutMs: 500,
      assert: () => ({
        pass: false as const,
        reason: "unexpected constant",
      }),
    });

    expect(ok).toMatchObject({ status: "ok", verified: true, value: 42 });
    expect(bad).toEqual({
      status: "assertion-failed",
      verified: false,
      value: 42,
    });
    expect(workerOk).toMatchObject({
      status: "ok",
      verified: true,
      value: 6,
    });
    expect(workerBad).toEqual({
      status: "assertion-failed",
      verified: false,
      value: 99,
      reason: "unexpected constant",
    });
  });
});
