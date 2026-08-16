export { runVerified } from "./run.js";
export { isVerified } from "./contract.js";
export {
  selfVerify,
  normalizeAssertOutcome,
  allAssertions,
  anyAssertion,
} from "./verify.js";
export type {
  AssertOutcome,
  AssertionFn,
  VerifyResult,
} from "./verify.js";
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
  runInDocker, dockerSecurityArgs, isDockerAvailable, uniqueContainerName,
  wireByteLimit, DEFAULT_DOCKER_IMAGE, DEFAULT_MAX_WIRE_BYTES, DOCKER_CONTAINER_NAME_PREFIX,
  DOCKER_WIRE_PREFIX,
} from "./docker.js";
export type { DockerRunOptions, DockerSecurityOptions } from "./docker.js";
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
  createEphemeralWorkspace,
  withEphemeralWorkspace,
  assertSafeFixtureKey,
  FixturePathError,
} from "./ephemeral-fs.js";
export type {
  EphemeralFsOptions,
  EphemeralWorkspace,
} from "./ephemeral-fs.js";
export type {
  Assertion,
  RunResult,
  RunStatus,
  Task,
  VerifiedRunOptions,
} from "./contract.js";
