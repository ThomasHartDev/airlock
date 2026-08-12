import { createRequire } from "node:module";

export class ModuleNotAllowedError extends Error {
  readonly specifier: string;

  constructor(specifier: string) {
    super(`module not allowed: ${specifier}`);
    this.name = "ModuleNotAllowedError";
    this.specifier = specifier;
  }
}

export function expandAllowlist(modules: readonly string[]): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const id of modules) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (isPathSpecifier(id)) continue;
    allowed.add(id);
    if (id.startsWith("node:")) allowed.add(id.slice(5));
    else allowed.add(`node:${id}`);
  }
  return allowed;
}

export function isPathSpecifier(id: string): boolean {
  return (
    id.startsWith(".") ||
    id.startsWith("/") ||
    id.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(id)
  );
}

export function isModuleAllowed(
  specifier: string,
  allowedModules: readonly string[],
): boolean {
  if (typeof specifier !== "string" || specifier.length === 0) return false;
  if (isPathSpecifier(specifier)) return false;
  const allowed = expandAllowlist(allowedModules);
  if (allowed.has(specifier)) return true;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return allowed.has(bare) || allowed.has(`node:${bare}`);
}

export function createGatedRequire(
  allowedModules: readonly string[],
  hostRequire: (id: string) => unknown,
): (id: string) => unknown {
  const allowed = new Set<string>();
  for (const id of allowedModules) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (
      id.startsWith(".") ||
      id.startsWith("/") ||
      id.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(id)
    ) {
      continue;
    }
    allowed.add(id);
    if (id.startsWith("node:")) allowed.add(id.slice(5));
    else allowed.add(`node:${id}`);
  }

  return function gatedRequire(id: string): unknown {
    const deny = (specifier: string): never => {
      const err = new Error(`module not allowed: ${specifier}`);
      // defineProperty: freezeRealm freezes Error.prototype so assignment throws
      Object.defineProperty(err, "name", {
        value: "ModuleNotAllowedError",
        configurable: true,
      });
      throw err;
    };

    if (typeof id !== "string" || id.length === 0) {
      deny(String(id));
    }
    if (
      id.startsWith(".") ||
      id.startsWith("/") ||
      id.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(id)
    ) {
      deny(id);
    }
    const bare = id.startsWith("node:") ? id.slice(5) : id;
    if (!allowed.has(id) && !allowed.has(bare) && !allowed.has(`node:${bare}`)) {
      deny(id);
    }
    return hostRequire(id);
  };
}

export function buildSandboxRequire(
  allowedModules: readonly string[],
): (id: string) => unknown {
  const hostRequire = createRequire(import.meta.url);
  return createGatedRequire(allowedModules, (id) => hostRequire(id));
}
