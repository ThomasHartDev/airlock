import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgv } from "../src/cli.js";
import {
  compileAssertExpr,
  exitCodeFor,
  runFile,
  runSource,
  serializeError,
  stringifyJsonResult,
  toJsonResult,
  type JsonRunResult,
} from "../src/run-file.js";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write(c: string) {
          out += c;
        },
      },
      stderr: {
        write(c: string) {
          err += c;
        },
      },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

async function tempFile(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "airlock-cli-"));
  const path = join(dir, "s.js");
  await writeFile(path, body, "utf8");
  return path;
}

describe("serializeError / toJsonResult / exitCodeFor", () => {
  it("serializes duck-typed errors", () => {
    expect(serializeError({ name: "Error", message: "boom" })).toEqual({
      name: "Error",
      message: "boom",
    });
  });

  it("maps ok and refusal statuses", () => {
    expect(toJsonResult({ status: "ok", value: 7, durationMs: 1 })).toEqual({
      status: "ok",
      value: 7,
      durationMs: 1,
    });
    expect(exitCodeFor({ status: "ok", value: 1, durationMs: 0 })).toBe(0);
    expect(exitCodeFor({ status: "timeout", timeoutMs: 1 })).toBe(1);
    expect(exitCodeFor({ status: "error", error: { name: "Error", message: "x" } })).toBe(1);
    expect(exitCodeFor({ status: "io-error", message: "x" })).toBe(2);
  });

  it("stringifies bigints and recovers from cycles", () => {
    expect(
      JSON.parse(
        stringifyJsonResult({ status: "ok", value: { n: 1n }, durationMs: 0 }),
      ).value,
    ).toEqual({ n: "1" });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(
      (
        JSON.parse(
          stringifyJsonResult({ status: "ok", value: cycle, durationMs: 0 }),
        ) as JsonRunResult
      ).status,
    ).toBe("error");
  });

  it("maps out-of-memory and output-too-large DTOs", () => {
    expect(
      toJsonResult({ status: "out-of-memory", maxOldGenerationSizeMb: 8 }),
    ).toEqual({ status: "out-of-memory", maxOldGenerationSizeMb: 8 });
    expect(
      toJsonResult({
        status: "output-too-large",
        maxOutputBytes: 10,
        actualBytes: 99,
      }),
    ).toEqual({
      status: "output-too-large",
      maxOutputBytes: 10,
      actualBytes: 99,
    });
    expect(
      exitCodeFor({ status: "out-of-memory", maxOldGenerationSizeMb: 8 }),
    ).toBe(1);
    expect(
      exitCodeFor({
        status: "output-too-large",
        maxOutputBytes: 10,
        actualBytes: 99,
      }),
    ).toBe(1);
  });
});

describe("compileAssertExpr", () => {
  it("evaluates sync expressions", async () => {
    expect(await compileAssertExpr("value > 0")(2)).toBe(true);
    expect(await compileAssertExpr("value > 0")(0)).toBe(false);
  });

  it("rejects empty expressions at compile time", () => {
    expect(() => compileAssertExpr(" ")).toThrow(/empty/);
    expect(() => compileAssertExpr("")).toThrow(/empty/);
  });

  it("awaits Promise-returning expressions before Boolean coerce", async () => {
    expect(await compileAssertExpr("Promise.resolve(false)")(1)).toBe(false);
    expect(await compileAssertExpr("Promise.resolve(true)")(1)).toBe(true);
  });
});

describe("runSource / runFile assertExpr edges", () => {
  it("returns ok when assert passes", async () => {
    expect(
      await runSource("1 + 2", { timeoutMs: 100, assert: (v) => v === 3 }),
    ).toMatchObject({ status: "ok", value: 3 });
  });

  it("returns assertion-failed for false sync assertExpr", async () => {
    expect(
      await runSource("41", { timeoutMs: 100, assertExpr: "value === 42" }),
    ).toEqual({ status: "assertion-failed", value: 41 });
  });

  it("returns assertion-failed for Promise.resolve(false) assertExpr", async () => {
    const result = await runSource("99", {
      timeoutMs: 100,
      assertExpr: "Promise.resolve(false)",
    });
    expect(result).toEqual({ status: "assertion-failed", value: 99 });
  });

  it("does not reject on empty assertExpr; returns status error", async () => {
    const result = await runSource("1", { timeoutMs: 100, assertExpr: "   " });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/empty/i);
    }
  });

  it("does not reject on syntax-invalid assertExpr; returns status error", async () => {
    const result = await runSource("1", {
      timeoutMs: 100,
      assertExpr: "value ===",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.name).toMatch(/SyntaxError|Error/);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("runFile does not reject on bad assertExpr", async () => {
    const path = await tempFile("1 + 1");
    const result = await runFile(path, {
      timeoutMs: 100,
      assertExpr: "value ===",
    });
    expect(result.status).toBe("error");
  });

  it("runFile Promise.resolve(false) assertExpr is assertion-failed", async () => {
    const path = await tempFile("7");
    expect(
      await runFile(path, {
        timeoutMs: 100,
        assertExpr: "Promise.resolve(false)",
      }),
    ).toEqual({ status: "assertion-failed", value: 7 });
  });

  it("timeouts and thrown errors become structured statuses", async () => {
    expect(await runSource("while (true) {}", { timeoutMs: 25 })).toEqual({
      status: "timeout",
      timeoutMs: 25,
    });
    expect(
      await runSource('throw new Error("boom")', { timeoutMs: 100 }),
    ).toMatchObject({ status: "error", error: { message: "boom" } });
  });

  it("worker tier + grant + assertExpr", async () => {
    expect(
      await runSource("rows.reduce((s, n) => s + n, 0)", {
        timeoutMs: 500,
        tier: "worker",
        grant: { rows: [1, 2, 3] },
        assertExpr: "value === 6",
      }),
    ).toMatchObject({ status: "ok", value: 6 });
  });

  it("runFile happy path and missing file", async () => {
    const path = await tempFile("2 * 21");
    expect(
      await runFile(path, { timeoutMs: 100, assertExpr: "value === 42" }),
    ).toMatchObject({ status: "ok", value: 42 });
    expect(await runFile("/no/such/airlock-file.js")).toMatchObject({
      status: "io-error",
    });
    expect(await runFile("  ")).toMatchObject({ status: "io-error" });
  });
});

describe("parseArgv", () => {
  it("parses run with defaults", () => {
    expect(parseArgv(["run", "a.js"])).toMatchObject({
      ok: true,
      args: { file: "a.js", tier: "sandbox" },
    });
  });

  it("rejects missing file and bad tier", () => {
    expect(parseArgv(["run"]).ok).toBe(false);
    expect(parseArgv(["run", "a.js", "--tier", "docker"]).ok).toBe(false);
  });
});

describe("CLI main", () => {
  it("prints JSON and exits 0 on success", async () => {
    const cap = capture();
    const path = await tempFile("21 * 2");
    expect(
      await main(
        ["run", path, "--timeout", "200", "--assert", "value === 42"],
        cap.io,
      ),
    ).toBe(0);
    expect(JSON.parse(cap.out.trim())).toMatchObject({
      status: "ok",
      value: 42,
    });
  });

  it("exits 1 on assertion-failed with JSON envelope", async () => {
    const path = await tempFile("21 * 2");
    const cap = capture();
    expect(await main(["run", path, "--assert", "value === 0"], cap.io)).toBe(
      1,
    );
    expect(JSON.parse(cap.out.trim())).toMatchObject({
      status: "assertion-failed",
      value: 42,
    });
  });

  it("exits 1 with JSON when --assert is syntax-invalid", async () => {
    const path = await tempFile("1");
    const cap = capture();
    const code = await main(["run", path, "--assert", "value ==="], cap.io);
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.out.trim()) as JsonRunResult;
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") {
      expect(parsed.error.message.length).toBeGreaterThan(0);
    }
  });

  it("exits 1 with JSON when --assert is empty whitespace", async () => {
    const path = await tempFile("1");
    const cap = capture();
    const code = await main(["run", path, "--assert", "   "], cap.io);
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.out.trim()) as JsonRunResult;
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") {
      expect(parsed.error.message).toMatch(/empty/i);
    }
  });

  it("exits 1 with JSON when --assert is Promise.resolve(false)", async () => {
    const path = await tempFile("5");
    const cap = capture();
    const code = await main(
      ["run", path, "--assert", "Promise.resolve(false)"],
      cap.io,
    );
    expect(code).toBe(1);
    expect(JSON.parse(cap.out.trim())).toEqual({
      status: "assertion-failed",
      value: 5,
    });
  });

  it("exits 2 on missing file and bad usage without requiring stdout JSON", async () => {
    expect(await main(["run", "/no/such/airlock-cli.js"], capture().io)).toBe(
      2,
    );
    expect(await main(["run"], capture().io)).toBe(2);
    expect(await main(["run", await tempFile("1"), "--grant", "nope"], capture().io)).toBe(
      2,
    );
  });

  it("accepts --grant and --assert together", async () => {
    expect(
      await main(
        [
          "run",
          await tempFile("n + 1"),
          "--grant",
          '{"n":41}',
          "--assert",
          "value === 42",
        ],
        capture().io,
      ),
    ).toBe(0);
  });
});
