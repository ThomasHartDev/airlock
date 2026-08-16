// Adversarial payloads + expected containment per tier; residuals are pins, not claims.

export type ThreatClass =
  | "infinite-loop"
  | "fork-bomb"
  | "fs-exfil"
  | "env-exfil";

export type ExecutorTier = "sandbox" | "worker";

export type ContainmentExpectation =
  | { kind: "timeout" }
  | { kind: "error"; nameIncludes?: string; messageIncludes?: string }
  | { kind: "ok"; value: unknown };

export interface ThreatScenario {
  id: string;
  class: ThreatClass;
  code: string;
  tiers: readonly ExecutorTier[];
  timeoutMs: number;
  expect: ContainmentExpectation;
  allowedModules?: readonly string[];
}

export interface ResidualRisk {
  id: string;
  class: ThreatClass;
  code: string;
  tier: ExecutorTier;
  /** Observed residual after constructor walk; not claimed contained. */
  residual: string;
  expectValue: unknown;
}

export const ENV_CANARY = "AIRLOCK_THREAT_CANARY";
export const ENV_CANARY_VALUE = "exfil-target-do-not-leak";

const BOTH = ["sandbox", "worker"] as const;
const DENY = {
  kind: "error" as const,
  nameIncludes: "ModuleNotAllowedError",
};

export const THREAT_SCENARIOS: readonly ThreatScenario[] = [
  {
    id: "loop-sync",
    class: "infinite-loop",
    code: "while (true) {}",
    tiers: BOTH,
    timeoutMs: 50,
    expect: { kind: "timeout" },
  },
  {
    id: "loop-async",
    class: "infinite-loop",
    code: "new Promise(() => {})",
    tiers: BOTH,
    timeoutMs: 50,
    expect: { kind: "timeout" },
  },
  {
    id: "fork-require-child-process",
    class: "fork-bomb",
    code: "require('child_process')",
    tiers: BOTH,
    timeoutMs: 200,
    allowedModules: [],
    expect: { ...DENY, messageIncludes: "child_process" },
  },
  {
    id: "fork-require-absent",
    class: "fork-bomb",
    code: "typeof require",
    tiers: BOTH,
    timeoutMs: 200,
    expect: { kind: "ok", value: "undefined" },
  },
  {
    id: "fork-cluster",
    class: "fork-bomb",
    code: "require('node:cluster')",
    tiers: BOTH,
    timeoutMs: 200,
    allowedModules: [],
    expect: { ...DENY, messageIncludes: "cluster" },
  },
  {
    id: "fs-require-read",
    class: "fs-exfil",
    code: "require('fs').readFileSync('/etc/passwd', 'utf8')",
    tiers: BOTH,
    timeoutMs: 200,
    allowedModules: [],
    expect: { ...DENY, messageIncludes: "fs" },
  },
  {
    id: "fs-path-specifier",
    class: "fs-exfil",
    code: "require('./secrets.json')",
    tiers: BOTH,
    timeoutMs: 200,
    allowedModules: ["fs"],
    expect: { ...DENY, messageIncludes: "./secrets.json" },
  },
  {
    id: "fs-absolute-path",
    class: "fs-exfil",
    code: "require('/etc/passwd')",
    tiers: BOTH,
    timeoutMs: 200,
    allowedModules: ["fs"],
    expect: { ...DENY, messageIncludes: "/etc/passwd" },
  },
  {
    id: "env-process-absent",
    class: "env-exfil",
    code: "typeof process",
    tiers: BOTH,
    timeoutMs: 200,
    expect: { kind: "ok", value: "undefined" },
  },
  {
    id: "env-direct-read",
    class: "env-exfil",
    code: `process.env.${ENV_CANARY}`,
    tiers: BOTH,
    timeoutMs: 200,
    expect: { kind: "error", nameIncludes: "ReferenceError" },
  },
];

const walk = (body: string) =>
  `this.constructor.constructor(${JSON.stringify(body)})()`;

export const RESIDUAL_RISKS: readonly ResidualRisk[] = [
  {
    id: "residual-sandbox-env",
    class: "env-exfil",
    code: walk(`return process.env.${ENV_CANARY}`),
    tier: "sandbox",
    residual: "host process.env readable after walk",
    expectValue: ENV_CANARY_VALUE,
  },
  {
    id: "residual-worker-env-empty",
    class: "env-exfil",
    code: walk(`return process.env.${ENV_CANARY}`),
    tier: "worker",
    residual: "process reachable; env empty so canary is undefined",
    expectValue: undefined,
  },
  {
    id: "residual-worker-fs",
    class: "fs-exfil",
    code: walk("return typeof require('fs').readFileSync"),
    tier: "worker",
    residual: "worker realm require loads host builtins",
    expectValue: "function",
  },
  {
    id: "residual-worker-spawn",
    class: "fork-bomb",
    code: walk("return typeof require('child_process').spawn"),
    tier: "worker",
    residual: "spawn reachable only after constructor walk",
    expectValue: "function",
  },
];

export function threatsByClass(
  threatClass: ThreatClass,
): readonly ThreatScenario[] {
  return THREAT_SCENARIOS.filter((s) => s.class === threatClass);
}
