export interface ResourceLimits {
  timeoutMs: number;
  maxOldGenerationSizeMb?: number;

  maxOutputBytes?: number;
}

export interface OutputSizeCheck {
  bytes: number;
  exceeded: boolean;
}

export function validateResourceLimits(limits: ResourceLimits): void {
  if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive, finite number");
  }
  if (limits.maxOldGenerationSizeMb !== undefined) {
    if (
      !Number.isInteger(limits.maxOldGenerationSizeMb) ||
      limits.maxOldGenerationSizeMb <= 0
    ) {
      throw new RangeError("maxOldGenerationSizeMb must be a positive integer");
    }
  }
  if (limits.maxOutputBytes !== undefined) {
    if (
      !Number.isInteger(limits.maxOutputBytes) ||
      limits.maxOutputBytes < 0
    ) {
      throw new RangeError("maxOutputBytes must be a non-negative integer");
    }
  }
}

export function measureOutputBytes(
  value: unknown,
  budget: number = Number.POSITIVE_INFINITY,
): OutputSizeCheck {
  const seen = new WeakSet<object>();
  let bytes = 0;

  const add = (n: number): boolean => {
    bytes += n;
    return bytes > budget;
  };

  const walk = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    switch (typeof v) {
      case "boolean":
        return add(1);
      case "number":
      case "bigint":
        return add(8);
      case "string":
        return add(Buffer.byteLength(v, "utf8"));
      case "symbol":
      case "function":
        return false;
      case "object": {
        if (seen.has(v as object)) return false;
        seen.add(v as object);
        if (ArrayBuffer.isView(v)) return add(v.byteLength);
        if (v instanceof ArrayBuffer) return add(v.byteLength);
        if (v instanceof Date) return add(8);
        if (v instanceof Map) {
          for (const [k, entry] of v) {
            if (walk(k) || walk(entry)) return true;
          }
          return false;
        }
        if (v instanceof Set) {
          for (const entry of v) {
            if (walk(entry)) return true;
          }
          return false;
        }
        if (Array.isArray(v)) {
          for (const entry of v) {
            if (walk(entry)) return true;
          }
          return false;
        }
        for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
          if (add(Buffer.byteLength(key, "utf8"))) return true;
          if (walk(entry)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  };

  const exceeded = walk(value);
  return { bytes, exceeded };
}

export function checkOutputSize(
  value: unknown,
  maxOutputBytes: number,
): OutputSizeCheck {
  return measureOutputBytes(value, maxOutputBytes);
}
