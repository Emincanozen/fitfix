import { BT, EVENT, EVENT_TYPE, MESG } from "../src/profile.js";
import { assembleFitFile, FitBuilder, type DevFieldSpec, type HeaderOptions } from "../src/writer.js";

/** An arbitrary absolute FIT time (2021-09-09). */
export const T0 = 1_000_000_000;

export interface ActivityOptions {
  readonly records?: number;
  /** Close a lap every N records. */
  readonly lapEvery?: number;
  /** Write the final lap, timer stop, session and activity. */
  readonly summary?: boolean;
  readonly header?: HeaderOptions;
  readonly developerFields?: boolean;
  readonly pauseAt?: number;
  readonly pauseSeconds?: number;
  /** Emit a timer stop_all before record N and never restart the timer. */
  readonly stopWithoutRestartAt?: number;
  /** Omit the file_id message. */
  readonly noFileId?: boolean;
}

export interface Activity {
  readonly bytes: Uint8Array;
  readonly records: number;
  readonly laps: number;
  /** Byte offset (in the file) where the final summary block starts. */
  readonly summaryOffset: number;
  readonly lastRecordTs: number;
  /** Distance of the last record in meters. */
  readonly totalDistance: number;
}

const SPEED_MPS = 3;

function recordFields(ts: number, i: number) {
  return [
    { num: 253, baseType: BT.uint32, value: ts },
    { num: 0, baseType: BT.sint32, value: 545_000_000 + i * 1000 },
    { num: 1, baseType: BT.sint32, value: 25_000_000 + i * 1000 },
    { num: 2, baseType: BT.uint16, value: (100 + (i % 20) + 500) * 5 },
    { num: 3, baseType: BT.uint8, value: 120 + (i % 30) },
    { num: 4, baseType: BT.uint8, value: 85 },
    { num: 5, baseType: BT.uint32, value: i * SPEED_MPS * 100 },
    { num: 6, baseType: BT.uint16, value: SPEED_MPS * 1000 },
    { num: 7, baseType: BT.uint16, value: 200 + (i % 50) },
  ];
}

/** Build a plausible, valid activity file the way a watch writes it. */
export function buildActivity(opts: ActivityOptions = {}): Activity {
  const n = opts.records ?? 120;
  const lapEvery = opts.lapEvery ?? 0;
  const summary = opts.summary ?? true;
  const b = new FitBuilder();
  if (!opts.noFileId) {
    b.message(MESG.fileId, [
      { num: 0, baseType: BT.enum, value: 4 },
      { num: 1, baseType: BT.uint16, value: 1 },
      { num: 2, baseType: BT.uint16, value: 3121 },
      { num: 3, baseType: BT.uint32z, value: 123456 },
      { num: 4, baseType: BT.uint32, value: T0 },
    ]);
  }
  b.message(MESG.deviceInfo, [
    { num: 253, baseType: BT.uint32, value: T0 },
    { num: 0, baseType: BT.uint8, value: 0 },
    { num: 2, baseType: BT.uint16, value: 1 },
    { num: 5, baseType: BT.uint16, value: 1234 },
  ]);
  const event = (ts: number, type: number) =>
    b.message(MESG.event, [
      { num: 253, baseType: BT.uint32, value: ts },
      { num: 0, baseType: BT.enum, value: EVENT.timer },
      { num: 1, baseType: BT.enum, value: type },
      { num: 4, baseType: BT.uint8, value: 0 },
    ], { localType: 2 });
  event(T0, EVENT_TYPE.start);

  const devFields: DevFieldSpec[] | undefined = opts.developerFields ? [{ num: 0, devIndex: 0, bytes: [0x2a, 0x00] }] : undefined;
  if (opts.developerFields) {
    b.message(MESG.developerDataId, [{ num: 3, baseType: BT.uint8, value: 0 }], { localType: 3 });
    b.message(MESG.fieldDescription, [
      { num: 0, baseType: BT.uint8, value: 0 },
      { num: 1, baseType: BT.uint8, value: 0 },
      { num: 2, baseType: BT.uint8, value: 0x84 },
      { num: 3, baseType: BT.string, size: 8, value: "fixture" },
    ], { localType: 3 });
  }

  let laps = 0;
  let lapStart = T0;
  let lapStartDist = 0;
  let ts = T0;
  const pauseAt = opts.pauseAt ?? -1;
  const lap = (end: number, dist: number, trigger: number) => {
    b.message(MESG.lap, [
      { num: 254, baseType: BT.uint16, value: laps },
      { num: 253, baseType: BT.uint32, value: end },
      { num: 0, baseType: BT.enum, value: EVENT.lap },
      { num: 1, baseType: BT.enum, value: EVENT_TYPE.stop },
      { num: 2, baseType: BT.uint32, value: lapStart },
      { num: 7, baseType: BT.uint32, value: (end - lapStart) * 1000 },
      { num: 8, baseType: BT.uint32, value: (end - lapStart) * 1000 },
      { num: 9, baseType: BT.uint32, value: Math.round((dist - lapStartDist) * 100) },
      { num: 24, baseType: BT.enum, value: trigger },
      { num: 25, baseType: BT.enum, value: 2 },
    ], { localType: 4 });
    laps++;
    lapStart = end;
    lapStartDist = dist;
  };

  for (let i = 0; i < n; i++) {
    if (i === pauseAt) {
      event(ts, EVENT_TYPE.stopAll);
      ts += opts.pauseSeconds ?? 0;
      event(ts, EVENT_TYPE.start);
    }
    if (i === opts.stopWithoutRestartAt) event(ts, EVENT_TYPE.stopAll);
    b.message(MESG.record, recordFields(ts, i), { localType: 1, ...(devFields ? { devFields } : {}) });
    if (lapEvery > 0 && (i + 1) % lapEvery === 0 && i + 1 < n) lap(ts, i * SPEED_MPS, 0);
    if (i + 1 < n) ts += 1;
  }
  const headerSize = opts.header?.headerSize ?? 14;
  const summaryOffset = headerSize + b.bytes().length;
  const totalDistance = (n - 1) * SPEED_MPS;
  if (summary) {
    lap(ts, totalDistance, 7);
    event(ts, EVENT_TYPE.stopAll);
    b.message(MESG.session, [
      { num: 254, baseType: BT.uint16, value: 0 },
      { num: 253, baseType: BT.uint32, value: ts },
      { num: 0, baseType: BT.enum, value: EVENT.session },
      { num: 1, baseType: BT.enum, value: EVENT_TYPE.stop },
      { num: 2, baseType: BT.uint32, value: T0 },
      { num: 5, baseType: BT.enum, value: 2 },
      { num: 6, baseType: BT.enum, value: 0 },
      { num: 7, baseType: BT.uint32, value: (ts - T0) * 1000 },
      { num: 8, baseType: BT.uint32, value: (ts - T0) * 1000 },
      { num: 9, baseType: BT.uint32, value: totalDistance * 100 },
      { num: 25, baseType: BT.uint16, value: 0 },
      { num: 26, baseType: BT.uint16, value: laps },
    ], { localType: 5 });
    b.message(MESG.activity, [
      { num: 253, baseType: BT.uint32, value: ts },
      { num: 0, baseType: BT.uint32, value: (ts - T0) * 1000 },
      { num: 1, baseType: BT.uint16, value: 1 },
      { num: 2, baseType: BT.enum, value: 0 },
      { num: 3, baseType: BT.enum, value: EVENT.activity },
      { num: 4, baseType: BT.enum, value: EVENT_TYPE.stop },
    ], { localType: 6 });
  }
  return {
    bytes: assembleFitFile(b.bytes(), opts.header),
    records: n,
    laps,
    summaryOffset,
    lastRecordTs: ts,
    totalDistance,
  };
}

/** Return a copy of `bytes` with `fn` applied. */
export function mutate(bytes: Uint8Array, fn: (b: Uint8Array) => void): Uint8Array {
  const c = bytes.slice();
  fn(c);
  return c;
}

export function setU32(b: Uint8Array, pos: number, v: number): void {
  b[pos] = v & 0xff;
  b[pos + 1] = (v >>> 8) & 0xff;
  b[pos + 2] = (v >>> 16) & 0xff;
  b[pos + 3] = (v >>> 24) & 0xff;
}

export function insertBytes(b: Uint8Array, pos: number, extra: readonly number[]): Uint8Array {
  const out = new Uint8Array(b.length + extra.length);
  out.set(b.subarray(0, pos), 0);
  out.set(extra, pos);
  out.set(b.subarray(pos), pos + extra.length);
  return out;
}

export function codes(issues: readonly { code: string }[]): string[] {
  return issues.map((i) => i.code);
}
