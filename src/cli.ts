#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { formatRepair, formatReport } from "./format.js";
import { FitParseError } from "./reader.js";
import { inspect, repair } from "./repair.js";

export const VERSION = "0.1.0";

const HELP = `fitfix ${VERSION} - repair corrupted or truncated .FIT activity files, locally.

Usage:
  fitfix inspect <file> [--json]
  fitfix repair <file> [-o <out>] [--dry-run] [--force] [--no-synthesize] [--json]

Commands:
  inspect           Diagnose a FIT file and list every problem found.
  repair            Write a repaired copy. The input file is never modified.

Options:
  -o, --output <f>  Output path (default: <name>-fixed.fit next to the input).
  --dry-run         Show what repair would do without writing anything.
  --force           Overwrite the output file if it already exists.
  --no-synthesize   Only fix low-level damage (header, sizes, CRC, cut-off
                    data); do not add missing lap/session/activity messages.
  --json            Machine-readable output.
  -h, --help        Show this help.
  -v, --version     Show the version.

Exit codes:
  0  healthy / repaired and verified
  1  problems found (inspect) or output still has errors (repair)
  2  usage error, unreadable input, or not a FIT file`;

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface Parsed {
  command: string | undefined;
  file: string | undefined;
  output: string | undefined;
  json: boolean;
  dryRun: boolean;
  force: boolean;
  synthesize: boolean;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Parsed {
  const p: Parsed = { command: undefined, file: undefined, output: undefined, json: false, dryRun: false, force: false, synthesize: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h":
      case "--help":
        p.help = true;
        break;
      case "-v":
      case "--version":
        p.version = true;
        break;
      case "--json":
        p.json = true;
        break;
      case "--dry-run":
        p.dryRun = true;
        break;
      case "--force":
        p.force = true;
        break;
      case "--no-synthesize":
        p.synthesize = false;
        break;
      case "-o":
      case "--output": {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`${a} needs a file path`);
        p.output = v;
        break;
      }
      default:
        if (a.startsWith("-") && a !== "-") throw new UsageError(`Unknown option: ${a}`);
        if (p.command === undefined) p.command = a;
        else if (p.file === undefined) p.file = a;
        else throw new UsageError(`Unexpected argument: ${a}`);
    }
  }
  return p;
}

/**
 * True when `a` and `b` name the same file: same real path (symlinks
 * resolved) or, if both exist, same device and inode (hard links).
 */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    if (sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino) return true;
  } catch {
    // One of them does not exist: fall back to comparing paths.
  }
  return samePath(a, b);
}

function samePath(a: string, b: string): boolean {
  const norm = (x: string) => {
    try {
      return realpathSync.native(x);
    } catch {
      return resolve(x);
    }
  };
  const x = norm(a);
  const y = norm(b);
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function defaultOutput(file: string): string {
  const ext = extname(file) || ".fit";
  return join(dirname(file), `${basename(file, extname(file))}-fixed${ext}`);
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

export function run(argv: readonly string[], io: CliIO): number {
  let args: Parsed;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(`fitfix: ${(e as Error).message}\nRun 'fitfix --help' for usage.`);
    return 2;
  }
  if (args.version) {
    io.stdout(VERSION);
    return 0;
  }
  if (args.help || args.command === undefined) {
    io.stdout(HELP);
    return args.help ? 0 : 2;
  }
  if (args.command !== "inspect" && args.command !== "repair") {
    io.stderr(`fitfix: unknown command '${args.command}'. Use 'inspect' or 'repair'.`);
    return 2;
  }
  if (args.file === undefined) {
    io.stderr(`fitfix: '${args.command}' needs a file.`);
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(args.file));
  } catch (e) {
    io.stderr(`fitfix: cannot read ${args.file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    return 2;
  }

  try {
    if (args.command === "inspect") {
      const report = inspect(bytes);
      io.stdout(args.json ? toJson({ file: args.file, ...report }) : formatReport(report, args.file));
      return report.healthy ? 0 : 1;
    }

    const out = args.output ?? defaultOutput(args.file);
    if (sameFile(args.file, out)) {
      io.stderr("fitfix: refusing to write over the input file: the output is the same file (same path, symlink or hard link). Choose another output path with -o.");
      return 2;
    }
    if (!args.dryRun && existsSync(out) && !args.force) {
      io.stderr(`fitfix: ${out} already exists. Use --force to overwrite it.`);
      return 2;
    }
    const res = repair(bytes, { synthesize: args.synthesize });
    if (!args.dryRun) {
      // Write a temporary file, then rename it over the destination. Renaming
      // replaces the directory entry instead of truncating an existing inode,
      // so even a link we failed to detect never has its content overwritten.
      const tmp = join(dirname(out), `.${basename(out)}.fitfix-${process.pid}.tmp`);
      try {
        writeFileSync(tmp, res.output, { flag: "wx" });
        if (!args.force && existsSync(out)) {
          rmSync(tmp, { force: true });
          io.stderr(`fitfix: ${out} already exists. Use --force to overwrite it.`);
          return 2;
        }
        renameSync(tmp, out);
      } catch (e) {
        rmSync(tmp, { force: true });
        io.stderr(`fitfix: cannot write ${out}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
        return 2;
      }
    }
    if (args.json) {
      io.stdout(
        toJson({
          file: args.file,
          output: args.dryRun ? null : out,
          dryRun: args.dryRun,
          changed: res.changed,
          actions: res.actions,
          outputSize: res.output.length,
          verified: res.after.healthy,
          before: res.before,
          after: res.after,
        }),
      );
    } else {
      io.stdout(formatRepair(res, args.file, args.dryRun ? null : out, args.dryRun));
    }
    return res.after.healthy ? 0 : 1;
  } catch (e) {
    if (e instanceof FitParseError) {
      io.stderr(`fitfix: ${args.file}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s + "\n"),
    stderr: (s) => process.stderr.write(s + "\n"),
  });
}
