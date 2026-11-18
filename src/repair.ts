import { analyze, type ActivityStats, type SynthesizedMessage } from "./analyze.js";
import { BASE_TYPES } from "./profile.js";
import { FitParseError, parseFit, type FileCrcInfo, type HeaderInfo, type Issue, type ParseResult } from "./reader.js";
import { assembleFitFile, FitBuilder } from "./writer.js";

export interface InspectReport {
  /** True when no error-level issue was found (in any chained member). */
  readonly healthy: boolean;
  /** Size of the whole input in bytes. */
  readonly fileSize: number;
  readonly header: HeaderInfo;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly strategy: ParseResult["strategy"];
  readonly fileCrc: FileCrcInfo;
  readonly stats: ActivityStats;
  readonly issues: readonly Issue[];
  /** Total bytes skipped as unreadable in this member. */
  readonly skippedBytes: number;
  /** Messages a repair would add. */
  readonly plannedMessages: readonly { name: string; reason: string }[];
  /**
   * Reports for the following members when the input is a chain of FIT
   * files (several complete FIT files back to back). Empty otherwise.
   */
  readonly chainedMembers: readonly InspectReport[];
}

export interface RepairOptions {
  /** Add missing file_id / lap / session / activity / timer-stop messages. Default true. */
  readonly synthesize?: boolean;
}

export interface RepairResult {
  /** False when the input was already healthy and is returned unchanged. */
  readonly changed: boolean;
  readonly output: Uint8Array;
  readonly actions: readonly string[];
  readonly before: InspectReport;
  /** Inspection of the repaired output. */
  readonly after: InspectReport;
}

/** Issues that a rewrite cannot or should not change. */
const NON_ACTIONABLE = new Set([
  "timestamps_non_monotonic",
  "relative_timestamps",
  "not_activity_file",
  "no_activity_data",
  "protocol_version_unknown",
  "file_type_unknown",
]);

function buildReport(parse: ParseResult): { report: InspectReport; synth: readonly SynthesizedMessage[] } {
  const a = analyze(parse);
  const issues = [...parse.issues, ...a.issues];
  return {
    synth: a.synthesize,
    report: {
      healthy: !issues.some((i) => i.severity === "error"),
      fileSize: parse.fileSize,
      header: parse.header,
      dataStart: parse.dataStart,
      dataEnd: parse.dataEnd,
      strategy: parse.strategy,
      fileCrc: parse.fileCrc,
      stats: a.stats,
      issues,
      skippedBytes: parse.skipped.reduce((s, k) => s + k.end - k.start, 0),
      plannedMessages: a.synthesize.map((s) => ({ name: s.name, reason: s.reason })),
      chainedMembers: [],
    },
  };
}

interface Member {
  readonly start: number;
  readonly end: number;
}

/**
 * Split a chain of FIT files into members. A member boundary is only
 * recognized right after a member's file CRC, where a new 12/14-byte FIT
 * header with the ".FIT" signature starts.
 */
function splitChain(bytes: Uint8Array): { members: Member[]; unreadableTail: { start: number; error: string } | null } {
  const members: Member[] = [];
  let pos = 0;
  for (;;) {
    let p: ParseResult;
    try {
      p = parseFit(bytes.subarray(pos));
    } catch (e) {
      if (pos === 0 || !(e instanceof FitParseError)) throw e;
      return { members, unreadableTail: { start: pos, error: e.message } };
    }
    if (p.nextMemberOffset === null) {
      members.push({ start: pos, end: bytes.length });
      return { members, unreadableTail: null };
    }
    members.push({ start: pos, end: pos + p.nextMemberOffset });
    pos += p.nextMemberOffset;
  }
}

function unreadableTailIssue(t: { start: number; error: string }): Issue {
  return {
    code: "chained_member_unreadable",
    severity: "error",
    message: `A chained FIT member at offset ${t.start} cannot be read (${t.error}); a repair drops it.`,
    offset: t.start,
  };
}

/** Diagnose a FIT file (or chain of FIT files). Throws FitParseError if the bytes are not FIT data at all. */
export function inspect(bytes: Uint8Array): InspectReport {
  const { members, unreadableTail } = splitChain(bytes);
  const reports = members.map((m) => buildReport(parseFit(bytes.subarray(m.start, m.end))).report);
  const first = reports[0]!;
  const issues = unreadableTail ? [...first.issues, unreadableTailIssue(unreadableTail)] : first.issues;
  return {
    ...first,
    fileSize: bytes.length,
    issues,
    healthy: reports.every((r) => r.healthy) && unreadableTail === null,
    chainedMembers: reports.slice(1),
  };
}

/** Repair a FIT file (or each member of a chain) in memory. The input buffer is never modified. */
export function repair(bytes: Uint8Array, options: RepairOptions = {}): RepairResult {
  const { members, unreadableTail } = splitChain(bytes);
  const before = inspect(bytes);
  const results = members.map((m) => repairMember(bytes.subarray(m.start, m.end), options));
  const changed = results.some((r) => r.changed) || unreadableTail !== null;
  if (!changed) return { changed: false, output: bytes.slice(), actions: [], before, after: before };

  const output = new Uint8Array(results.reduce((s, r) => s + r.output.length, 0));
  let o = 0;
  for (const r of results) {
    output.set(r.output, o);
    o += r.output.length;
  }
  const actions: string[] = [];
  results.forEach((r, i) => {
    const prefix = members.length > 1 ? `Member ${i + 1}: ` : "";
    for (const a of r.actions) actions.push(prefix + a);
  });
  if (members.length > 1) actions.push(`Kept all ${members.length} members of the FIT chain.`);
  if (unreadableTail) actions.push(`Dropped ${bytes.length - unreadableTail.start} byte(s) of an unreadable chained member at offset ${unreadableTail.start}.`);
  return { changed: true, output, actions, before, after: inspect(output) };
}

/** Repair a single FIT member. */
function repairMember(bytes: Uint8Array, options: RepairOptions): { changed: boolean; output: Uint8Array; actions: string[] } {
  const synthesizeEnabled = options.synthesize ?? true;
  const parse = parseFit(bytes);
  const { report: before, synth: plannedAll } = buildReport(parse);
  const planned = synthesizeEnabled ? plannedAll : [];

  // Summary issues are only fixed by planned messages, so they do not count on their own.
  const actionable = before.issues.filter((i) => !NON_ACTIONABLE.has(i.code) && !isSummaryIssue(i.code));
  if (actionable.length === 0 && planned.length === 0) {
    return { changed: false, output: bytes, actions: [] };
  }

  const actions: string[] = [];
  const builder = new FitBuilder();
  const added = (s: SynthesizedMessage) => `Added ${/^[aeiou]/.test(s.name) ? "an" : "a"} ${s.name} message (${s.reason}).`;
  for (const s of planned.filter((p) => p.position === "start")) {
    builder.message(s.globalNum, s.fields, { localType: 0 });
    actions.push(added(s));
  }
  // Copy every decoded record verbatim: definitions, data and developer fields.
  let runStart = -1;
  let runEnd = -1;
  for (const m of parse.messages) {
    if (m.offset !== runEnd) {
      if (runStart >= 0) builder.raw(bytes.subarray(runStart, runEnd));
      runStart = m.offset;
    }
    runEnd = m.offset + m.length;
  }
  if (runStart >= 0) builder.raw(bytes.subarray(runStart, runEnd));
  for (const s of planned.filter((p) => p.position === "end")) {
    builder.message(s.globalNum, s.fields, { localType: 0 });
    actions.push(added(s));
  }

  const records = builder.bytes();
  const h = parse.header;
  const usesV2 =
    before.stats.hasDeveloperFields ||
    parse.messages.some((m) => m.kind === "definition" && m.definition.fields.some((f) => (BASE_TYPES.get(f.baseType)?.size ?? 0) === 8));
  let protocolVersion = h.protocolVersion >> 4 === 1 || h.protocolVersion >> 4 === 2 ? h.protocolVersion : 0x20;
  if (usesV2 && protocolVersion >> 4 === 1) protocolVersion = 0x20;
  const profileVersion = h.profileVersion > 0 && h.profileVersion < 0xffff ? h.profileVersion : 2132;
  const headerSize = h.storedSize === 12 && h.size === 12 ? 12 : 14;
  const output = assembleFitFile(records, { headerSize, protocolVersion, profileVersion });

  for (const i of before.issues) {
    switch (i.code) {
      case "header_size_invalid":
      case "signature_invalid":
      case "header_crc_invalid":
        actions.push(`Rebuilt the file header (${i.code.replaceAll("_", " ")}).`);
        break;
      case "data_size_mismatch":
        actions.push(`Set header data size to ${records.length} bytes (was ${h.declaredDataSize}).`);
        break;
      case "truncated_message":
        actions.push(`Dropped ${parse.fileSize - parse.dataEnd} byte(s) of an incomplete final message.`);
        break;
      case "garbage_skipped":
        actions.push(i.message.replace(/^Skipped/, "Removed"));
        break;
      case "trailing_bytes":
        actions.push(`Dropped ${parse.trailingBytes} trailing byte(s) after the data section.`);
        break;
      default:
        break;
    }
  }
  actions.push("Recomputed the header CRC and file CRC.");
  return { changed: true, output, actions: dedupe(actions) };
}

function isSummaryIssue(code: string): boolean {
  return ["missing_file_id", "missing_lap", "missing_session", "missing_activity", "records_after_last_lap"].includes(code);
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
