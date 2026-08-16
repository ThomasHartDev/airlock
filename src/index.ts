export { runVerified } from "./run.js";
export { isVerified } from "./contract.js";
export {
  run,
  probeAmbientAuthority,
  ZeroCredentialViolation,
  DENIED_AMBIENT_NAMES,
} from "./sandbox.js";
export type { SandboxRunOptions } from "./sandbox.js";
export { runInWorker, freezeRealm, FROZEN_INTRINSICS } from "./worker.js";
export type { WorkerRunOptions } from "./worker.js";
export {
  ModuleNotAllowedError,
  expandAllowlist,
  isPathSpecifier,
  isModuleAllowed,
  createGatedRequire,
  buildSandboxRequire,
} from "./modules.js";
export {
  validateResourceLimits,
  measureOutputBytes,
  checkOutputSize,
} from "./limits.js";
export type { ResourceLimits, OutputSizeCheck } from "./limits.js";
export {
  THREAT_SCENARIOS,
  RESIDUAL_RISKS,
  ENV_CANARY,
  ENV_CANARY_VALUE,
  threatsByClass,
} from "./threats.js";
export type {
  ThreatClass,
  ThreatScenario,
  ResidualRisk,
  ExecutorTier,
  ContainmentExpectation,
} from "./threats.js";
export type {
  Assertion,
  RunResult,
  RunStatus,
  Task,
  VerifiedRunOptions,
} from "./contract.js";
