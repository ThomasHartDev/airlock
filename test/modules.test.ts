import { describe, expect, it } from "vitest";
import {
  ModuleNotAllowedError,
  createGatedRequire,
  expandAllowlist,
  isModuleAllowed,
  isPathSpecifier,
  isVerified,
  run,
  runInWorker,
} from "../src/index.js";

describe("isPathSpecifier / isModuleAllowed", () => {
  it.each(["./x", "../x", "/abs", "\\win", "C:\\foo", "D:/bar"])(
    "treats %s as a path specifier",
    (id) => {
      expect(isPathSpecifier(id)).toBe(true);
      expect(isModuleAllowed(id, [id, "path"])).toBe(false);
    },
  );

  it("denies everything on an empty allowlist", () => {
    expect(isModuleAllowed("path", [])).toBe(false);
    expect(isModuleAllowed("node:path", [])).toBe(false);
  });

  it("accepts bare and node: forms interchangeably", () => {
    expect(isModuleAllowed("path", ["path"])).toBe(true);
    expect(isModuleAllowed("node:path", ["path"])).toBe(true);
    expect(isModuleAllowed("path", ["node:path"])).toBe(true);
    expect(isModuleAllowed("node:fs/promises", ["fs/promises"])).toBe(true);
  });

  it("does not grant a sibling or parent id by prefix", () => {
    expect(isModuleAllowed("fs/promises", ["fs"])).toBe(false);
    expect(isModuleAllowed("fs", ["fs/promises"])).toBe(false);
    expect(isModuleAllowed("crypto", ["path"])).toBe(false);
  });

  it("rejects empty and non-string-like ids", () => {
    expect(isModuleAllowed("", ["path"])).toBe(false);
  });

  it("drops path-like entries from the expanded allowlist", () => {
    const allowed = expandAllowlist(["path", "./evil", ""]);
    expect(allowed.has("path")).toBe(true);
    expect(allowed.has("node:path")).toBe(true);
    expect(allowed.has("./evil")).toBe(false);
  });
});

describe("createGatedRequire", () => {
  it("loads an allowed builtin and throws ModuleNotAllowedError otherwise", () => {
    const loads: string[] = [];
    const gated = createGatedRequire(["path"], (id) => {
      loads.push(id);
      return { loaded: id };
    });

    expect(gated("path")).toEqual({ loaded: "path" });
    expect(gated("node:path")).toEqual({ loaded: "node:path" });
    expect(loads).toEqual(["path", "node:path"]);

    try {
      gated("fs");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: "ModuleNotAllowedError",
        message: "module not allowed: fs",
      });
    }

    expect(() => gated("./secret")).toThrowError(/module not allowed/);
    expect(loads).toEqual(["path", "node:path"]);
  });

  it("never calls hostRequire for a denied id", () => {
    let called = 0;
    const gated = createGatedRequire([], () => {
      called += 1;
      return null;
    });
    expect(() => gated("path")).toThrow();
    expect(called).toBe(0);
  });
});

describe("run with allowedModules", () => {
  it("has no require when allowedModules is omitted", async () => {
    const result = await run<string>("typeof require", {
      timeoutMs: 100,
      assert: (v) => v === "undefined",
    });
    expect(result).toMatchObject({ status: "ok", value: "undefined" });
  });

  it("denies every load when the allowlist is empty", async () => {
    const result = await run("require('path')", {
      timeoutMs: 100,
      assert: () => true,
      allowedModules: [],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).name).toBe("ModuleNotAllowedError");
      expect((result.error as Error).message).toContain("path");
    }
  });

  it("loads an allowed builtin and verifies the result", async () => {
    const result = await run<string>(
      "require('node:path').join('a', 'b')",
      {
        timeoutMs: 100,
        assert: (v) => v === "a/b" || v === "a\\b",
        allowedModules: ["path"],
      },
    );

    expect(result.status).toBe("ok");
    if (isVerified(result)) {
      expect(result.value === "a/b" || result.value === "a\\b").toBe(true);
    }
  });

  it("refuses a module outside the allowlist", async () => {
    const result = await run("require('fs')", {
      timeoutMs: 100,
      assert: () => true,
      allowedModules: ["path"],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).name).toBe("ModuleNotAllowedError");
    }
  });

  it("always denies relative and absolute path requires", async () => {
    const relative = await run("require('./package.json')", {
      timeoutMs: 100,
      assert: () => true,
      allowedModules: ["./package.json", "path"],
    });
    expect(relative.status).toBe("error");
    if (relative.status === "error") {
      expect((relative.error as Error).name).toBe("ModuleNotAllowedError");
    }

    const absolute = await run("require('/etc/passwd')", {
      timeoutMs: 100,
      assert: () => true,
      allowedModules: ["/etc/passwd"],
    });
    expect(absolute.status).toBe("error");
  });

  it("overrides a grant-supplied require with the allowlist gate", async () => {
    let fullRequireCalled = 0;
    const result = await run("require('fs')", {
      timeoutMs: 100,
      assert: () => true,
      allowedModules: ["path"],
      grant: {
        require: () => {
          fullRequireCalled += 1;
          return {};
        },
      },
    });

    expect(result.status).toBe("error");
    expect(fullRequireCalled).toBe(0);
  });

  it("does not grant sibling subpaths by prefix", async () => {
    const result = await run("require('fs/promises')", {
      timeoutMs: 100,
      assert: () => true,
      allowedModules: ["fs"],
    });
    expect(result.status).toBe("error");
  });
});

describe("runInWorker with allowedModules", () => {
  it("has no require when allowedModules is omitted", async () => {
    const result = await runInWorker<string>("typeof require", {
      timeoutMs: 1000,
      assert: (v) => v === "undefined",
    });
    expect(result).toMatchObject({ status: "ok", value: "undefined" });
  });

  it("loads an allowed builtin inside the isolate", async () => {
    const result = await runInWorker<boolean>(
      "require('node:path').posix.join('a','b') === 'a/b'",
      {
        timeoutMs: 1000,
        assert: (v) => v === true,
        allowedModules: ["node:path"],
      },
    );
    expect(result).toMatchObject({ status: "ok", value: true });
  });

  it("refuses a denied module inside the isolate", async () => {
    const result = await runInWorker("require('fs')", {
      timeoutMs: 1000,
      assert: () => true,
      allowedModules: ["path"],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect((result.error as Error).name).toBe("ModuleNotAllowedError");
    }
  });

  it("denies path-like requires even when listed", async () => {
    const result = await runInWorker("require('../src/index.js')", {
      timeoutMs: 1000,
      assert: () => true,
      allowedModules: ["../src/index.js", "path"],
    });
    expect(result.status).toBe("error");
  });
});

describe("ModuleNotAllowedError", () => {
  it("carries the denied specifier", () => {
    const err = new ModuleNotAllowedError("crypto");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ModuleNotAllowedError");
    expect(err.specifier).toBe("crypto");
    expect(err.message).toBe("module not allowed: crypto");
  });
});
