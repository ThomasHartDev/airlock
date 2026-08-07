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
  serializeError,
  toJsonResult,
  exitCodeFor,
  stringifyJsonResult,
  compileAssertExpr,
  runSource,
  runFile,
} from "./run-file.js";
export type {
  JsonError,
  JsonRunResult,
  ExecutorTier,
  RunFileOptions,
} from "./run-file.js";
export type {
  Assertion,
  RunResult,
  RunStatus,
  Task,
  VerifiedRunOptions,
} from "./contract.js";
