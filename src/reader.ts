import { fitCrc } from "./crc.js";
import { BASE_TYPES, type BaseTypeInfo, FIELD } from "./profile.js";

export type FitValue = number | bigint | string | number[] | bigint[] | null;

export interface FieldDef {
  readonly num: number;
  readonly size: number;
  readonly baseType: number;
}

export interface DevFieldDef {
  readonly num: number;
  readonly size: number;
  readonly devIndex: number;
}

export interface Definition {
  readonly localType: number;
  readonly globalNum: number;
  readonly littleEndian: boolean;
  readonly fields: readonly FieldDef[];
  readonly devFields: readonly DevFieldDef[];
  /** Size in bytes of the content of a data message using this definition. */
  readonly dataSize: number;
}

export interface FitMessage {
  readonly kind: "definition" | "data";
  /** Byte offset of the record header inside the file. */
  readonly offset: number;
  /** Total record length in bytes, header byte included. */
  readonly length: number;
  readonly localType: number;
  readonly globalNum: number;
  readonly definition: Definition;
  readonly compressedTimestamp: boolean;
  /** Resolved timestamp (data messages only, when known). */
  readonly timestamp: number | null;
  /** Decoded field values (data messages only), keyed by field number. */
  readonly fields: ReadonlyMap<number, FitValue>;
}

export type Severity = "error" | "warning" | "info";

export interface Issue {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly offset?: number;
}

export interface HeaderInfo {
  /** Header size byte as stored in the file. */
  readonly storedSize: number;
  /** Header size actually used for parsing (may be guessed). */
  readonly size: number;
  readonly protocolVersion: number;
  readonly profileVersion: number;
  readonly declaredDataSize: number;
  readonly signatureValid: boolean;
  readonly crcStatus: "valid" | "invalid" | "zero" | "absent";
  readonly storedCrc: number | null;
}

export interface FileCrcInfo {
  readonly status: "valid" | "invalid" | "missing";
  readonly stored: number | null;
  readonly computed: number;
}

export interface ParseResult {
  readonly fileSize: number;
  readonly header: HeaderInfo;
  readonly dataStart: number;
  /** Offset just past the last complete message that was kept. */
  readonly dataEnd: number;
  readonly messages: readonly FitMessage[];
  readonly fileCrc: FileCrcInfo;
  /** Byte ranges that were skipped as unreadable. */
  readonly skipped: readonly { start: number; end: number; reason: string }[];
  /** Bytes after the data section that are not the file CRC. */
  readonly trailingBytes: number;
  /**
   * Offset of the next member when the file is a chain of FIT files
   * (another FIT header follows this member's CRC), else null.
   */
  readonly nextMemberOffset: number | null;
  /** Which strategy found the data boundary. */
  readonly strategy: "declared" | "file-minus-crc" | "file-no-crc" | "salvage";
  readonly issues: readonly Issue[];
}

export class FitParseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FitParseError";
  }
}

const SIGNATURE = [0x2e, 0x46, 0x49, 0x54]; // ".FIT"

function baseTypeOf(id: number): BaseTypeInfo | undefined {
  return BASE_TYPES.get(id) ?? [...BASE_TYPES.values()].find((t) => (t.id & 0x1f) === (id & 0x1f));
}

function readUint(bytes: Uint8Array, pos: number, size: number, little: boolean): bigint {
  let v = 0n;
  for (let i = 0; i < size; i++) {
    const b = bytes[little ? pos + size - 1 - i : pos + i]!;
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

function u16le(bytes: Uint8Array, pos: number): number {
  return bytes[pos]! | (bytes[pos + 1]! << 8);
}

function u32le(bytes: Uint8Array, pos: number): number {
  return (bytes[pos]! | (bytes[pos + 1]! << 8) | (bytes[pos + 2]! << 16) | (bytes[pos + 3]! << 24)) >>> 0;
}

function decodeScalar(raw: bigint, t: BaseTypeInfo): number | bigint | null {
  if (raw === t.invalid && t.kind !== "string") return null;
  switch (t.kind) {
    case "uint":
    case "byte":
      return t.size === 8 ? raw : Number(raw);
    case "sint": {
      const bits = BigInt(t.size * 8);
      const signed = raw >= 1n << (bits - 1n) ? raw - (1n << bits) : raw;
      return t.size === 8 ? signed : Number(signed);
    }
    case "float": {
      const dv = new DataView(new ArrayBuffer(8));
      if (t.size === 4) {
        dv.setUint32(0, Number(raw));
        return dv.getFloat32(0);
      }
      dv.setBigUint64(0, raw);
      return dv.getFloat64(0);
    }
    case "string":
      return null;
  }
}

function decodeField(bytes: Uint8Array, pos: number, f: FieldDef, little: boolean): FitValue {
  const t = baseTypeOf(f.baseType);
  if (!t || f.size % t.size !== 0) {
    return Array.from(bytes.subarray(pos, pos + f.size));
  }
  if (t.kind === "string") {
    const slice = bytes.subarray(pos, pos + f.size);
    const nul = slice.indexOf(0);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(nul >= 0 ? slice.subarray(0, nul) : slice);
    return text.length > 0 ? text : null;
  }
  const count = f.size / t.size;
  if (count === 1) return decodeScalar(readUint(bytes, pos, t.size, little), t);
  const values: (number | bigint | null)[] = [];
  for (let i = 0; i < count; i++) values.push(decodeScalar(readUint(bytes, pos + i * t.size, t.size, little), t));
  if (values.every((v) => v === null)) return null;
  if (t.size === 8) return values.map((v) => (v === null ? t.invalid : (v as bigint)));
  return values.map((v) => (v === null ? Number(t.invalid) : (v as number)));
}

type ReadOutcome =
  | { ok: true; msg: FitMessage; next: number; definition?: Definition }
  | { ok: false; reason: "eof" | "undefined_local" | "bad_header" | "bad_definition"; needed?: number };

interface StreamState {
  defs: (Definition | undefined)[];
  lastTimestamp: number | null;
}

function cloneState(s: StreamState): StreamState {
  return { defs: [...s.defs], lastTimestamp: s.lastTimestamp };
}

/** Plausibility check for a definition, used to tell real data from garbage. */
function definitionLooksReal(d: Definition, reserved: number): boolean {
  if (reserved !== 0) return false;
  if (d.fields.length === 0 && d.devFields.length === 0) return false;
  const seen = new Set<number>();
  for (const f of d.fields) {
    const t = BASE_TYPES.get(f.baseType);
    if (!t || f.size === 0 || f.size % t.size !== 0) return false;
    if (seen.has(f.num)) return false;
    seen.add(f.num);
  }
  return d.devFields.every((f) => f.size > 0);
}

function readRecord(bytes: Uint8Array, pos: number, limit: number, state: StreamState, strictDefs: boolean): ReadOutcome {
  if (pos >= limit) return { ok: false, reason: "eof", needed: 1 };
  const h = bytes[pos]!;
  if ((h & 0x80) !== 0) {
    // Compressed timestamp header.
    const localType = (h >> 5) & 0x03;
    const def = state.defs[localType];
    if (!def) return { ok: false, reason: "undefined_local" };
    const end = pos + 1 + def.dataSize;
    if (end > limit) return { ok: false, reason: "eof", needed: end - limit };
    let ts: number | null = null;
    if (state.lastTimestamp !== null) {
      const offset = h & 0x1f;
      const last = state.lastTimestamp;
      ts = ((last & ~0x1f) >>> 0) + offset + (offset >= (last & 0x1f) ? 0 : 0x20);
    }
    const fields = decodeData(bytes, pos + 1, def);
    if (ts !== null) state.lastTimestamp = ts;
    return {
      ok: true,
      next: end,
      msg: { kind: "data", offset: pos, length: end - pos, localType, globalNum: def.globalNum, definition: def, compressedTimestamp: true, timestamp: ts, fields },
    };
  }
  const isDefinition = (h & 0x40) !== 0;
  const localType = h & 0x0f;
  if ((h & 0x10) !== 0) return { ok: false, reason: "bad_header" };
  if (isDefinition) {
    const hasDev = (h & 0x20) !== 0;
    if (pos + 6 > limit) return { ok: false, reason: "eof", needed: pos + 6 - limit };
    const reserved = bytes[pos + 1]!;
    const arch = bytes[pos + 2]!;
    if (arch > 1) return { ok: false, reason: "bad_definition" };
    const little = arch === 0;
    const globalNum = little ? u16le(bytes, pos + 3) : (bytes[pos + 3]! << 8) | bytes[pos + 4]!;
    const numFields = bytes[pos + 5]!;
    let p = pos + 6;
    if (p + numFields * 3 > limit) return { ok: false, reason: "eof", needed: p + numFields * 3 - limit };
    const fields: FieldDef[] = [];
    for (let i = 0; i < numFields; i++, p += 3) {
      fields.push({ num: bytes[p]!, size: bytes[p + 1]!, baseType: bytes[p + 2]! });
    }
    const devFields: DevFieldDef[] = [];
    if (hasDev) {
      if (p + 1 > limit) return { ok: false, reason: "eof", needed: 1 };
      const numDev = bytes[p]!;
      p += 1;
      if (p + numDev * 3 > limit) return { ok: false, reason: "eof", needed: p + numDev * 3 - limit };
      for (let i = 0; i < numDev; i++, p += 3) {
        devFields.push({ num: bytes[p]!, size: bytes[p + 1]!, devIndex: bytes[p + 2]! });
      }
    }
    const dataSize = fields.reduce((s, f) => s + f.size, 0) + devFields.reduce((s, f) => s + f.size, 0);
    const def: Definition = { localType, globalNum, littleEndian: little, fields, devFields, dataSize };
    if (fields.some((f) => f.size === 0)) return { ok: false, reason: "bad_definition" };
    if (strictDefs && !definitionLooksReal(def, reserved)) return { ok: false, reason: "bad_definition" };
    state.defs[localType] = def;
    return {
      ok: true,
      next: p,
      definition: def,
      msg: { kind: "definition", offset: pos, length: p - pos, localType, globalNum, definition: def, compressedTimestamp: false, timestamp: null, fields: new Map() },
    };
  }
  if ((h & 0x20) !== 0) return { ok: false, reason: "bad_header" };
  const def = state.defs[localType];
  if (!def) return { ok: false, reason: "undefined_local" };
  const end = pos + 1 + def.dataSize;
  if (end > limit) return { ok: false, reason: "eof", needed: end - limit };
  const fields = decodeData(bytes, pos + 1, def);
  const tsVal = fields.get(FIELD.timestamp);
  let ts: number | null = null;
  if (typeof tsVal === "number") {
    ts = tsVal;
    state.lastTimestamp = tsVal;
  }
  return {
    ok: true,
    next: end,
    msg: { kind: "data", offset: pos, length: end - pos, localType, globalNum: def.globalNum, definition: def, compressedTimestamp: false, timestamp: ts, fields },
  };
}

function decodeData(bytes: Uint8Array, pos: number, def: Definition): Map<number, FitValue> {
  const out = new Map<number, FitValue>();
  let p = pos;
  for (const f of def.fields) {
    out.set(f.num, decodeField(bytes, p, f, def.littleEndian));
    p += f.size;
  }
  return out;
}

interface StreamResult {
  messages: FitMessage[];
  end: number;
  clean: boolean;
  failure: ReadOutcome | null;
  skipped: { start: number; end: number; reason: string }[];
  truncatedAt: number | null;
}

/** Parse records strictly between `start` and `limit`; stop on the first problem. */
function parseStrict(bytes: Uint8Array, start: number, limit: number): StreamResult {
  const state: StreamState = { defs: [], lastTimestamp: null };
  const messages: FitMessage[] = [];
  let pos = start;
  while (pos < limit) {
    const r = readRecord(bytes, pos, limit, state, false);
    if (!r.ok) return { messages, end: pos, clean: false, failure: r, skipped: [], truncatedAt: null };
    messages.push(r.msg);
    pos = r.next;
  }
  return { messages, end: pos, clean: true, failure: null, skipped: [], truncatedAt: null };
}

const RESYNC_LOOKAHEAD = 8;
/** Largest backwards step (seconds) tolerated between timestamps in a resync run. */
const RESYNC_MAX_BACKSTEP = 60;
/** Largest forward gap (seconds) tolerated between timestamps in a resync run. */
const RESYNC_MAX_GAP = 86400;

/**
 * Would parsing from `pos` yield a run of plausible records?
 *
 * Parsing alone is weak evidence: a short definition makes many byte pairs
 * "parse". A candidate boundary is accepted only if
 *  - its first record has an uncompressed header and is either a definition
 *    that passes the strict plausibility checks or a data message carrying a
 *    full timestamp that is consistent with the last good timestamp;
 *  - the next RESYNC_LOOKAHEAD records all parse (or the run reaches the end
 *    of the data exactly), with definitions checked strictly;
 *  - every timestamp in the run moves forward by at most RESYNC_MAX_GAP and
 *    backwards by at most RESYNC_MAX_BACKSTEP.
 */
function plausibleAt(bytes: Uint8Array, pos: number, limit: number, state: StreamState): boolean {
  const s = cloneState(state);
  let p = pos;
  let count = 0;
  let prevTs = s.lastTimestamp;
  while (count < RESYNC_LOOKAHEAD) {
    if (p === limit) return count > 0;
    const r = readRecord(bytes, p, limit, s, true);
    if (!r.ok) return false;
    const m = r.msg;
    const ts = m.kind === "data" ? m.timestamp : null;
    if (count === 0) {
      if (m.compressedTimestamp) return false;
      if (m.kind === "data" && (ts === null || !m.fields.has(FIELD.timestamp))) return false;
    }
    if (ts !== null && prevTs !== null) {
      const dt = ts - prevTs;
      if (dt < -RESYNC_MAX_BACKSTEP || dt > RESYNC_MAX_GAP) return false;
    }
    if (ts !== null) prevTs = ts;
    p = r.next;
    count++;
  }
  return true;
}

/** Parse records leniently: drop an incomplete tail and skip over unreadable bytes. */
function parseSalvage(bytes: Uint8Array, start: number, limit: number): StreamResult {
  const state: StreamState = { defs: [], lastTimestamp: null };
  const messages: FitMessage[] = [];
  const skipped: StreamResult["skipped"] = [];
  let truncatedAt: number | null = null;
  let pos = start;
  while (pos < limit) {
    const r = readRecord(bytes, pos, limit, state, false);
    if (r.ok) {
      messages.push(r.msg);
      pos = r.next;
      continue;
    }
    // Try to find the next plausible record boundary.
    let found = -1;
    for (let q = pos + 1; q < limit; q++) {
      if (plausibleAt(bytes, q, limit, state)) {
        found = q;
        break;
      }
    }
    if (found < 0) {
      truncatedAt = pos;
      break;
    }
    skipped.push({ start: pos, end: found, reason: r.reason });
    pos = found;
  }
  return { messages, end: truncatedAt ?? pos, clean: false, failure: null, skipped, truncatedAt };
}

function looksLikeDefinitionAt(bytes: Uint8Array, pos: number): boolean {
  if (pos + 6 > bytes.length) return false;
  const h = bytes[pos]!;
  if ((h & 0xd0) !== 0x40) return false;
  const r = readRecord(bytes, pos, bytes.length, { defs: [], lastTimestamp: null }, true);
  return r.ok;
}

function readHeader(bytes: Uint8Array, issues: Issue[]): HeaderInfo {
  const storedSize = bytes[0]!;
  const signatureValid = SIGNATURE.every((b, i) => bytes[8 + i] === b);
  let size = storedSize;
  if (storedSize !== 12 && storedSize !== 14) {
    const guess = looksLikeDefinitionAt(bytes, 14) ? 14 : looksLikeDefinitionAt(bytes, 12) ? 12 : -1;
    if (guess < 0) {
      if (!signatureValid) {
        throw new FitParseError("Not a FIT file: no '.FIT' signature and no recognizable FIT data.", "not_fit");
      }
      throw new FitParseError(`Unsupported FIT header size ${storedSize} and no recognizable data after it.`, "header_unreadable");
    }
    size = guess;
    issues.push({
      code: "header_size_invalid",
      severity: "error",
      message: `Header size byte is ${storedSize}; expected 12 or 14. Data appears to start at byte ${guess}.`,
      offset: 0,
    });
  }
  if (!signatureValid) {
    if (!looksLikeDefinitionAt(bytes, size)) {
      throw new FitParseError("Not a FIT file: no '.FIT' signature and no recognizable FIT data.", "not_fit");
    }
    issues.push({ code: "signature_invalid", severity: "error", message: "The '.FIT' signature in the header is missing or damaged.", offset: 8 });
  }
  const protocolVersion = bytes[1]!;
  if (protocolVersion >> 4 !== 1 && protocolVersion >> 4 !== 2) {
    issues.push({ code: "protocol_version_unknown", severity: "warning", message: `Unknown protocol version byte 0x${protocolVersion.toString(16)}.`, offset: 1 });
  }
  let crcStatus: HeaderInfo["crcStatus"] = "absent";
  let storedCrc: number | null = null;
  if (size === 14) {
    storedCrc = u16le(bytes, 12);
    if (storedCrc === 0) crcStatus = "zero";
    else if (storedCrc === fitCrc(bytes, 0, 12)) crcStatus = "valid";
    else {
      crcStatus = "invalid";
      issues.push({
        code: "header_crc_invalid",
        severity: "error",
        message: `Header CRC is 0x${hex4(storedCrc)} but the header bytes give 0x${hex4(fitCrc(bytes, 0, 12))}.`,
        offset: 12,
      });
    }
  }
  return {
    storedSize,
    size,
    protocolVersion,
    profileVersion: u16le(bytes, 2),
    declaredDataSize: u32le(bytes, 4),
    signatureValid,
    crcStatus,
    storedCrc,
  };
}

export function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Parse a FIT file as tolerantly as possible. Throws FitParseError only when
 * the input does not look like FIT data at all.
 */
export function parseFit(input: Uint8Array): ParseResult {
  const bytes = input;
  const len = bytes.length;
  if (len < 12) throw new FitParseError(`File is too small to be a FIT file (${len} bytes).`, "too_short");
  const issues: Issue[] = [];
  const header = readHeader(bytes, issues);
  const start = header.size;
  if (start > len) throw new FitParseError("File ends inside the FIT header.", "too_short");

  const crcMatches = (end: number): boolean => end + 2 <= len && u16le(bytes, end) === fitCrc(bytes, 0, end);
  const declaredEnd = start + header.declaredDataSize;

  type Candidate = { stream: StreamResult; strategy: ParseResult["strategy"] };
  const candidates: { rank: number; c: Candidate }[] = [];
  // A zero data size is only trusted when the file is exactly header + CRC.
  if ((header.declaredDataSize > 0 && declaredEnd <= len) || (header.declaredDataSize === 0 && len === start + 2)) {
    const s = parseStrict(bytes, start, declaredEnd);
    if (s.clean) candidates.push({ rank: crcMatches(declaredEnd) ? 0 : 3, c: { stream: s, strategy: "declared" } });
  }
  if (len - 2 > start && len - 2 !== declaredEnd) {
    const s = parseStrict(bytes, start, len - 2);
    if (s.clean) candidates.push({ rank: crcMatches(len - 2) ? 1 : 2, c: { stream: s, strategy: "file-minus-crc" } });
  }
  if (len !== declaredEnd) {
    const s = parseStrict(bytes, start, len);
    if (s.clean) candidates.push({ rank: 4, c: { stream: s, strategy: "file-no-crc" } });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  let chosen: Candidate;
  if (candidates.length > 0) {
    chosen = candidates[0]!.c;
  } else {
    let stream: StreamResult;
    if (header.declaredDataSize > 0 && declaredEnd + 2 === len) {
      stream = parseSalvage(bytes, start, declaredEnd);
    } else {
      // The last two bytes are probably an old CRC: prefer reading up to them
      // when that ends exactly on a record boundary, so they are not decoded
      // as a tiny bogus record.
      const beforeCrc = len - 2 > start ? parseSalvage(bytes, start, len - 2) : null;
      stream = beforeCrc && beforeCrc.truncatedAt === null && beforeCrc.end === len - 2 ? beforeCrc : parseSalvage(bytes, start, len);
    }
    chosen = { stream, strategy: "salvage" };
  }

  const stream = chosen.stream;
  const dataEnd = stream.end;
  const actualDataSize = dataEnd - start;

  for (const sk of stream.skipped) {
    issues.push({
      code: "garbage_skipped",
      severity: "error",
      message: `Skipped ${sk.end - sk.start} unreadable byte(s) at offset ${sk.start}-${sk.end - 1} (${sk.reason.replace("_", " ")}); reading resumed at a heuristically chosen record boundary, check the result.`,
      offset: sk.start,
    });
  }

  let trailingBytes = 0;
  let fileCrc: FileCrcInfo;
  const computed = fitCrc(bytes, 0, dataEnd);
  if (stream.truncatedAt !== null) {
    const lost = len - stream.truncatedAt;
    if (chosen.strategy === "salvage" && lost === 2 && dataEnd === len - 2) {
      // The two leftover bytes are just the old CRC.
      fileCrc = { status: u16le(bytes, dataEnd) === computed ? "valid" : "invalid", stored: u16le(bytes, dataEnd), computed };
    } else {
      issues.push({
        code: "truncated_message",
        severity: "error",
        message: `The file ends in the middle of a message: ${lost} byte(s) at offset ${stream.truncatedAt} cannot be decoded and will be dropped.`,
        offset: stream.truncatedAt,
      });
      fileCrc = { status: "missing", stored: null, computed };
    }
  } else if (dataEnd + 2 <= len) {
    const stored = u16le(bytes, dataEnd);
    fileCrc = { status: stored === computed ? "valid" : "invalid", stored, computed };
    trailingBytes = len - dataEnd - 2;
  } else {
    fileCrc = { status: "missing", stored: null, computed };
    trailingBytes = len - dataEnd;
  }

  if (fileCrc.status === "invalid") {
    issues.push({
      code: "file_crc_invalid",
      severity: "error",
      message: `File CRC is 0x${hex4(fileCrc.stored ?? 0)} but the content gives 0x${hex4(computed)}.`,
      offset: dataEnd,
    });
  } else if (fileCrc.status === "missing" && stream.truncatedAt === null) {
    issues.push({ code: "file_crc_missing", severity: "error", message: "The 2-byte file CRC at the end of the file is missing.", offset: dataEnd });
  }

  if (header.declaredDataSize !== actualDataSize) {
    issues.push({
      code: "data_size_mismatch",
      severity: "error",
      message: `Header declares ${header.declaredDataSize} data bytes but ${actualDataSize} readable bytes were found.`,
      offset: 4,
    });
  }
  let nextMemberOffset: number | null = null;
  if (trailingBytes > 0) {
    const next = dataEnd + 2;
    const chained =
      next + 12 <= len && (bytes[next] === 12 || bytes[next] === 14) && SIGNATURE.every((b, i) => bytes[next + 8 + i] === b);
    if (chained) {
      // A chained FIT file: the rest is another member, not junk.
      nextMemberOffset = next;
      trailingBytes = 0;
    } else {
      issues.push({
        code: "trailing_bytes",
        severity: "warning",
        message: `${trailingBytes} unexpected byte(s) after the data section will be dropped.`,
        offset: dataEnd + 2,
      });
    }
  }

  return {
    fileSize: len,
    header,
    dataStart: start,
    dataEnd,
    messages: stream.messages,
    fileCrc,
    skipped: stream.skipped,
    trailingBytes,
    nextMemberOffset,
    strategy: chosen.strategy,
    issues,
  };
}
