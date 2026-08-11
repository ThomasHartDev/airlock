import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENV_CANARY,
  ENV_CANARY_VALUE,
  RESIDUAL_RISKS,
  THREAT_SCENARIOS,
  type ContainmentExpectation,
  type ExecutorTier,
  type ThreatScenario,
  threatsByClass,
} from "../src/threats.js";
import { run, runInWorker, type RunResult } from "../src/index.js";

async function execute(
  tier: ExecutorTier,
  scenario: ThreatScenario,
): Promise<RunResult<unknown>> {
  const opts = {
    timeoutMs: scenario.timeoutMs,
    assert: () => true as boolean,
    ...(scenario.allowedModules !== undefined
      ? { allowedModules: scenario.allowedModules }
      : {}),
  };
  return tier === "sandbox"
    ? run(scenario.code, opts)
    : runInWorker(scenario.code, opts);
}

function errField(error: unknown, key: "name" | "message"): string {
  if (typeof error === "object" && error !== null && key in error) {
    return String((error as Record<string, unknown>)[key]);
  }
  return key === "message" ? String(error) : "";
}

function assertContained(
  result: RunResult<unknown>,
  shape: ContainmentExpectation,
  label: string,
  timeoutMs: number,
): void {
  if (shape.kind === "timeout") {
    expect(result, label).toEqual({ status: "timeout", timeoutMs });
    return;
  }
  if (shape.kind === "ok") {
    expect(result.status, label).toBe("ok");
    if (result.status === "ok") expect(result.value, label).toEqual(shape.value);
    return;
  }
  expect(result.status, label).toBe("error");
  if (result.status !== "error") return;
  if (shape.nameIncludes) {
    expect(errField(result.error, "name"), label).toContain(shape.nameIncludes);
  }
  if (shape.messageIncludes) {
    expect(errField(result.error, "message"), label).toContain(
      shape.messageIncludes,
    );
  }
}

describe("threat catalog coverage", () => {
  it("covers every required attack class on at least one scenario", () => {
    const classes = new Set(THREAT_SCENARIOS.map((s) => s.class));
    expect(classes).toEqual(
      new Set(["infinite-loop", "fork-bomb", "fs-exfil", "env-exfil"]),
    );
    for (const c of classes) {
      expect(threatsByClass(c).length).toBeGreaterThan(0);
    }
  });
});

describe("contained escape attempts", () => {
  beforeEach(() => {
    process.env[ENV_CANARY] = ENV_CANARY_VALUE;
  });
  afterEach(() => {
    delete process.env[ENV_CANARY];
  });

  for (const scenario of THREAT_SCENARIOS) {
    for (const tier of scenario.tiers) {
      it(`${scenario.class}: ${scenario.id} on ${tier}`, async () => {
        const result = await execute(tier, scenario);
        assertContained(
          result,
          scenario.expect,
          `${scenario.id}@${tier}`,
          scenario.timeoutMs,
        );
      });
    }
  }

  it("host stays responsive after concurrent infinite loops", async () => {
    const started = performance.now();
    const results = await Promise.all([
      run("while (true) {}", { timeoutMs: 40, assert: () => true }),
      runInWorker("while (true) {}", { timeoutMs: 40, assert: () => true }),
      run("while (true) {}", { timeoutMs: 40, assert: () => true }),
    ]);
    for (const r of results) expect(r.status).toBe("timeout");
    const healthy = await run<number>("1 + 1", {
      timeoutMs: 200,
      assert: (n) => n === 2,
    });
    expect(healthy).toMatchObject({ status: "ok", value: 2 });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("env canary is planted on the host during the suite", () => {
    expect(process.env[ENV_CANARY]).toBe(ENV_CANARY_VALUE);
  });
});

describe("documented residual risks after constructor walk", () => {
  beforeEach(() => {
    process.env[ENV_CANARY] = ENV_CANARY_VALUE;
  });
  afterEach(() => {
    delete process.env[ENV_CANARY];
  });

  it.each(RESIDUAL_RISKS)(
    "pins $id ($class on $tier)",
    async (risk) => {
      const exec = risk.tier === "sandbox" ? run : runInWorker;
      const result = await exec(risk.code, {
        timeoutMs: risk.tier === "worker" ? 1000 : 200,
        assert: () => true,
      });
      expect(result).toMatchObject({ status: "ok", value: risk.expectValue });
    },
  );

  it("residuals cover env, fs, and fork classes", () => {
    const classes = new Set(RESIDUAL_RISKS.map((r) => r.class));
    expect(classes.has("env-exfil")).toBe(true);
    expect(classes.has("fs-exfil")).toBe(true);
    expect(classes.has("fork-bomb")).toBe(true);
  });
});
