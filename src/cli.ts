import { pathToFileURL } from "node:url";
import {
  exitCodeFor,
  runFile,
  stringifyJsonResult,
  type ExecutorTier,
  type JsonRunResult,
} from "./run-file.js";

export interface CliArgs {
  file: string;
  timeoutMs: number;
  assertExpr?: string;
  grantJson?: string;
  allowedModules: string[];
  maxOutputBytes?: number;
  maxOldGenerationSizeMb?: number;
  tier: ExecutorTier;
}

export type ParseResult =
  | { ok: true; args: CliArgs }
  | { ok: false; message: string; showHelp?: boolean };

const USAGE = `Usage: airlock run <file> [options]
  --timeout <ms>  --assert <expr>  --tier sandbox|worker
  --grant <json>  --allow-module <id>  --max-output-bytes <n>
  --max-old-gen-mb <n>  -h, --help
Exit: 0 ok, 1 refusal (incl. assert compile/runtime), 2 usage/io.
--assert is host-privileged (new Function in the host realm).
`;

function fail(message: string, showHelp?: boolean): ParseResult {
  return showHelp ? { ok: false, message, showHelp } : { ok: false, message };
}

export function parseArgv(argv: string[]): ParseResult {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return fail(USAGE, true);
  }
  if (argv[0] !== "run") return fail(`unknown command: ${argv[0]}\n\n${USAGE}`);

  const args: CliArgs = {
    file: "",
    timeoutMs: 5_000,
    allowedModules: [],
    tier: "sandbox",
  };
  let file: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return fail(USAGE, true);
    if (!arg.startsWith("-")) {
      if (file !== undefined) return fail(`unexpected argument: ${arg}\n\n${USAGE}`);
      file = arg;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return fail(`${arg} requires a value`);
    }
    i++;
    if (arg === "--timeout" || arg === "--max-output-bytes" || arg === "--max-old-gen-mb") {
      if (!/^\d+$/.test(value)) return fail(`${arg} must be a non-negative integer`);
      const n = Number(value);
      if (!Number.isSafeInteger(n)) return fail(`${arg} is out of range`);
      if (arg === "--timeout") args.timeoutMs = n;
      else if (arg === "--max-output-bytes") args.maxOutputBytes = n;
      else args.maxOldGenerationSizeMb = n;
      continue;
    }
    if (arg === "--assert") { args.assertExpr = value; continue; }
    if (arg === "--grant") { args.grantJson = value; continue; }
    if (arg === "--allow-module") { args.allowedModules.push(value); continue; }
    if (arg === "--tier") {
      if (value !== "sandbox" && value !== "worker") {
        return fail(`--tier must be "sandbox" or "worker"`);
      }
      args.tier = value;
      continue;
    }
    return fail(`unknown option: ${arg}\n\n${USAGE}`);
  }

  if (file === undefined) return fail(`missing <file>\n\n${USAGE}`);
  args.file = file;
  return { ok: true, args };
}

function parseGrant(
  raw: string,
): { ok: true; grant: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "--grant must be a JSON object" };
    }
    return { ok: true, grant: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      message: `--grant: ${error instanceof Error ? error.message : "invalid JSON"}`,
    };
  }
}

export interface CliIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export async function main(argv: string[], io: CliIo = process): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    io.stderr.write(parsed.message.endsWith("\n") ? parsed.message : `${parsed.message}\n`);
    return parsed.showHelp ? 0 : 2;
  }

  const { args } = parsed;
  let grant: Record<string, unknown> | undefined;
  if (args.grantJson !== undefined) {
    const g = parseGrant(args.grantJson);
    if (!g.ok) {
      io.stderr.write(`${g.message}\n`);
      return 2;
    }
    grant = g.grant;
  }

  const result = await runFile(args.file, {
    timeoutMs: args.timeoutMs,
    tier: args.tier,
    ...(args.assertExpr !== undefined ? { assertExpr: args.assertExpr } : {}),
    ...(grant ? { grant } : {}),
    ...(args.allowedModules.length > 0 ? { allowedModules: args.allowedModules } : {}),
    ...(args.maxOutputBytes !== undefined ? { maxOutputBytes: args.maxOutputBytes } : {}),
    ...(args.maxOldGenerationSizeMb !== undefined
      ? { maxOldGenerationSizeMb: args.maxOldGenerationSizeMb }
      : {}),
  });

  io.stdout.write(`${stringifyJsonResult(result)}\n`);
  return exitCodeFor(result);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    });
}
