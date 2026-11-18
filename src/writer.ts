import { fitCrc } from "./crc.js";
import { BASE_TYPES } from "./profile.js";

export type WritableValue = number | bigint | string | readonly number[] | null;

export interface FieldSpec {
  readonly num: number;
  readonly baseType: number;
  /** Byte size; defaults to the base type size (or string length + 1). */
  readonly size?: number;
  readonly value: WritableValue;
}

export interface DevFieldSpec {
  readonly num: number;
  readonly devIndex: number;
  readonly bytes: readonly number[];
}

export interface MessageOptions {
  readonly localType?: number;
  readonly bigEndian?: boolean;
  readonly devFields?: readonly DevFieldSpec[];
}

function baseInfo(baseType: number) {
  const t = BASE_TYPES.get(baseType);
  if (!t) throw new Error(`Unknown FIT base type 0x${baseType.toString(16)}`);
  return t;
}

function fieldSize(f: FieldSpec): number {
  if (f.size !== undefined) return f.size;
  const t = baseInfo(f.baseType);
  if (t.kind === "string") return typeof f.value === "string" ? new TextEncoder().encode(f.value).length + 1 : 1;
  if (Array.isArray(f.value)) return t.size * f.value.length;
  return t.size;
}

function writeScalar(out: Uint8Array, pos: number, size: number, value: bigint, bigEndian: boolean): void {
  const mask = (1n << BigInt(size * 8)) - 1n;
  let v = value & mask;
  for (let i = 0; i < size; i++) {
    out[bigEndian ? pos + size - 1 - i : pos + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function encodeValue(f: FieldSpec, size: number, bigEndian: boolean): Uint8Array {
  const t = baseInfo(f.baseType);
  const out = new Uint8Array(size);
  if (t.kind === "string") {
    if (typeof f.value === "string") out.set(new TextEncoder().encode(f.value).subarray(0, size - 1));
    return out;
  }
  const values: (number | bigint | null)[] =
    f.value === null ? [] : Array.isArray(f.value) ? [...(f.value as number[])] : [f.value as number | bigint];
  const count = size / t.size;
  for (let i = 0; i < count; i++) {
    const v = values[i] ?? null;
    let raw: bigint;
    if (v === null || (typeof v === "number" && !Number.isFinite(v))) raw = t.invalid;
    else if (t.kind === "float") {
      const dv = new DataView(new ArrayBuffer(8));
      if (t.size === 4) {
        dv.setFloat32(0, Number(v));
        raw = BigInt(dv.getUint32(0));
      } else {
        dv.setFloat64(0, Number(v));
        raw = dv.getBigUint64(0);
      }
    } else raw = typeof v === "bigint" ? v : BigInt(Math.round(v));
    writeScalar(out, i * t.size, t.size, raw, bigEndian);
  }
  return out;
}

/** Incrementally builds the record section of a FIT file. */
export class FitBuilder {
  private readonly chunks: Uint8Array[] = [];
  private readonly activeDefs = new Map<number, string>();
  private length = 0;

  /** Append raw bytes (already-encoded records). */
  raw(bytes: Uint8Array | readonly number[]): this {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.chunks.push(b);
    this.length += b.length;
    // Raw bytes may redefine anything: forget what we think is defined.
    this.activeDefs.clear();
    return this;
  }

  /** Append a data message, emitting a definition first when needed. */
  message(globalNum: number, fields: readonly FieldSpec[], opts: MessageOptions = {}): this {
    const local = opts.localType ?? 0;
    const bigEndian = opts.bigEndian ?? false;
    const devFields = opts.devFields ?? [];
    const sizes = fields.map(fieldSize);
    const key = JSON.stringify([globalNum, bigEndian, fields.map((f, i) => [f.num, sizes[i], f.baseType]), devFields.map((d) => [d.num, d.bytes.length, d.devIndex])]);
    if (this.activeDefs.get(local) !== key) {
      const def: number[] = [0x40 | (devFields.length > 0 ? 0x20 : 0) | (local & 0x0f), 0, bigEndian ? 1 : 0];
      if (bigEndian) def.push((globalNum >> 8) & 0xff, globalNum & 0xff);
      else def.push(globalNum & 0xff, (globalNum >> 8) & 0xff);
      def.push(fields.length);
      fields.forEach((f, i) => def.push(f.num, sizes[i]!, f.baseType));
      if (devFields.length > 0) {
        def.push(devFields.length);
        for (const d of devFields) def.push(d.num, d.bytes.length, d.devIndex);
      }
      this.push(Uint8Array.from(def));
      this.activeDefs.set(local, key);
    }
    const parts: Uint8Array[] = [Uint8Array.of(local & 0x0f)];
    fields.forEach((f, i) => parts.push(encodeValue(f, sizes[i]!, bigEndian)));
    for (const d of devFields) parts.push(Uint8Array.from(d.bytes));
    for (const p of parts) this.push(p);
    return this;
  }

  private push(b: Uint8Array): void {
    this.chunks.push(b);
    this.length += b.length;
  }

  /** The record bytes written so far. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

export interface HeaderOptions {
  readonly headerSize?: 12 | 14;
  readonly protocolVersion?: number;
  readonly profileVersion?: number;
}

/** Wrap a record section into a complete FIT file: header, data, file CRC. */
export function assembleFitFile(records: Uint8Array, opts: HeaderOptions = {}): Uint8Array {
  const headerSize = opts.headerSize ?? 14;
  const out = new Uint8Array(headerSize + records.length + 2);
  out[0] = headerSize;
  out[1] = opts.protocolVersion ?? 0x20;
  const profile = opts.profileVersion ?? 2132;
  out[2] = profile & 0xff;
  out[3] = (profile >> 8) & 0xff;
  const n = records.length;
  out[4] = n & 0xff;
  out[5] = (n >>> 8) & 0xff;
  out[6] = (n >>> 16) & 0xff;
  out[7] = (n >>> 24) & 0xff;
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  if (headerSize === 14) {
    const hc = fitCrc(out, 0, 12);
    out[12] = hc & 0xff;
    out[13] = (hc >> 8) & 0xff;
  }
  out.set(records, headerSize);
  const crc = fitCrc(out, 0, headerSize + n);
  out[headerSize + n] = crc & 0xff;
  out[headerSize + n + 1] = (crc >> 8) & 0xff;
  return out;
}
