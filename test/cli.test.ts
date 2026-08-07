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
  return {
    io: {
      stdout: { write(c: string) { out += c; } },
      stderr: { write(_c: string) {} },
    },
    get out() { return out; },
  };
}

async function tempFile(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "airlock-cli-"));
  const path = join(dir, "s.js");
  await writeFile(path, body, "utf8");
  return path;
}

describe("runFile JSON API + cli", () => {
  it("covers serialization, execution edges, and CLI exit codes", async () => {
    expect(serializeError({ name: "Error", message: "boom" })).toEqual({
      name: "Error",
      message: "boom",
    });
    expect(toJsonResult({ status: "ok", value: 7, durationMs: 1 })).toEqual({
      status: "ok",
      value: 7,
      durationMs: 1,
    });
    expect(exitCodeFor({ status: "ok", value: 1, durationMs: 0 })).toBe(0);
    expect(exitCodeFor({ status: "timeout", timeoutMs: 1 })).toBe(1);
    expect(exitCodeFor({ status: "io-error", message: "x" })).toBe(2);
    expect(
      JSON.parse(
        stringifyJsonResult({ status: "ok", value: { n: 1n }, durationMs: 0 }),
      ).value,
    ).toEqual({ n: "1" });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(
      (JSON.parse(
        stringifyJsonResult({ status: "ok", value: cycle, durationMs: 0 }),
      ) as JsonRunResult).status,
    ).toBe("error");

    expect(compileAssertExpr("value > 0")(2)).toBe(true);
    expect(() => compileAssertExpr(" ")).toThrow(/empty/);
    expect(
      await runSource("1 + 2", { timeoutMs: 100, assert: (v) => v === 3 }),
    ).toMatchObject({ status: "ok", value: 3 });
    expect(
      await runSource("41", { timeoutMs: 100, assertExpr: "value === 42" }),
    ).toEqual({ status: "assertion-failed", value: 41 });
    expect(await runSource("while (true) {}", { timeoutMs: 25 })).toEqual({
      status: "timeout",
      timeoutMs: 25,
    });
    expect(
      await runSource('throw new Error("boom")', { timeoutMs: 100 }),
    ).toMatchObject({ status: "error", error: { message: "boom" } });
    expect(
      await runSource("rows.reduce((s, n) => s + n, 0)", {
        timeoutMs: 500,
        tier: "worker",
        grant: { rows: [1, 2, 3] },
        assertExpr: "value === 6",
      }),
    ).toMatchObject({ status: "ok", value: 6 });

    const path = await tempFile("2 * 21");
    expect(await runFile(path, { timeoutMs: 100, assertExpr: "value === 42" }))
      .toMatchObject({ status: "ok", value: 42 });
    expect(await runFile("/no/such/airlock-file.js")).toMatchObject({ status: "io-error" });
    expect(await runFile("  ")).toMatchObject({ status: "io-error" });

    expect(parseArgv(["run", "a.js"])).toMatchObject({
      ok: true,
      args: { file: "a.js", tier: "sandbox" },
    });
    expect(parseArgv(["run"]).ok).toBe(false);
    expect(parseArgv(["run", "a.js", "--tier", "docker"]).ok).toBe(false);

    const ok = capture();
    const okPath = await tempFile("21 * 2");
    expect(await main(["run", okPath, "--timeout", "200", "--assert", "value === 42"], ok.io)).toBe(0);
    expect(JSON.parse(ok.out.trim())).toMatchObject({ status: "ok", value: 42 });
    expect(await main(["run", okPath, "--assert", "value === 0"], capture().io)).toBe(1);
    expect(await main(["run", "/no/such/airlock-cli.js"], capture().io)).toBe(2);
    expect(await main(["run"], capture().io)).toBe(2);
    expect(
      await main(
        ["run", await tempFile("n + 1"), "--grant", '{"n":41}', "--assert", "value === 42"],
        capture().io,
      ),
    ).toBe(0);
    expect(await main(["run", okPath, "--grant", "nope"], capture().io)).toBe(2);
  });
});
