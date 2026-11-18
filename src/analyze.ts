import {
  BT,
  EVENT,
  EVENT_TYPE,
  FIELD,
  FILE_TYPE_ACTIVITY,
  FIT_MIN_ABSOLUTE_TIME,
  MANUFACTURER_DEVELOPMENT,
  MESG,
  RECORD_FIELD,
  messageName,
} from "./profile.js";
import type { FitMessage, FitValue, Issue, ParseResult } from "./reader.js";
import type { FieldSpec } from "./writer.js";

export interface ActivityStats {
  /** Data message counts by message name. */
  readonly messageCounts: Readonly<Record<string, number>>;
  readonly definitionCount: number;
  readonly dataMessageCount: number;
  readonly fileType: number | null;
  readonly records: number;
  readonly laps: number;
  readonly sessions: number;
  readonly activities: number;
  readonly hasDeveloperFields: boolean;
  /** First and last timestamp seen on any data message (FIT seconds). */
  readonly firstTimestamp: number | null;
  readonly lastTimestamp: number | null;
  readonly elapsedSeconds: number | null;
  readonly distanceMeters: number | null;
  readonly sport: number | null;
  readonly backwardsTimestamps: number;
}

export interface SynthesizedMessage {
  readonly globalNum: number;
  readonly name: string;
  readonly fields: readonly FieldSpec[];
  /** Where it goes relative to the original messages. */
  readonly position: "start" | "end";
  readonly reason: string;
}

export interface Analysis {
  readonly stats: ActivityStats;
  readonly issues: readonly Issue[];
  readonly synthesize: readonly SynthesizedMessage[];
}

const minOf = (v: readonly number[]): number => v.reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
const maxOf = (v: readonly number[]): number => v.reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY);
const num = (v: FitValue | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface RecordPoint {
  ts: number;
  distance: number | null; // meters
  lat: number | null; // semicircles
  lon: number | null;
  altitude: number | null; // meters
  speed: number | null; // m/s
  hr: number | null;
  cadence: number | null;
  power: number | null;
}

function toPoint(m: FitMessage): RecordPoint | null {
  if (m.timestamp === null) return null;
  const f = m.fields;
  const dist = num(f.get(RECORD_FIELD.distance));
  const alt = num(f.get(RECORD_FIELD.enhancedAltitude)) ?? num(f.get(RECORD_FIELD.altitude));
  const spd = num(f.get(RECORD_FIELD.enhancedSpeed)) ?? num(f.get(RECORD_FIELD.speed));
  return {
    ts: m.timestamp,
    distance: dist === null ? null : dist / 100,
    lat: num(f.get(RECORD_FIELD.positionLat)),
    lon: num(f.get(RECORD_FIELD.positionLong)),
    altitude: alt === null ? null : alt / 5 - 500,
    speed: spd === null ? null : spd / 1000,
    hr: num(f.get(RECORD_FIELD.heartRate)),
    cadence: num(f.get(RECORD_FIELD.cadence)),
    power: num(f.get(RECORD_FIELD.power)),
  };
}

const SEMI_TO_RAD = Math.PI / 2 ** 31;

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * SEMI_TO_RAD;
  const p2 = lat2 * SEMI_TO_RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * SEMI_TO_RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface Aggregate {
  start: number;
  end: number;
  elapsed: number;
  timer: number;
  distance: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCad: number | null;
  maxCad: number | null;
  avgPower: number | null;
  maxPower: number | null;
  ascent: number | null;
  descent: number | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
}

function avgMax(values: (number | null)[]): [number | null, number | null] {
  const v = values.filter((x): x is number => x !== null);
  if (v.length === 0) return [null, null];
  return [v.reduce((a, b) => a + b, 0) / v.length, maxOf(v)];
}

/**
 * Aggregate the points of one interval. `baseline` is the last point before
 * the interval (used for cumulative distance), `pauses` are timer pauses.
 */
function aggregate(points: RecordPoint[], start: number, baseline: RecordPoint | null, pauses: [number, number][]): Aggregate {
  const end = points.length > 0 ? points[points.length - 1]!.ts : start;
  const elapsed = Math.max(0, end - start);
  let paused = 0;
  for (const [a, b] of pauses) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo) paused += hi - lo;
  }
  const timer = Math.max(0, elapsed - paused);

  let distance: number | null = null;
  const withDist = points.filter((p) => p.distance !== null);
  if (withDist.length > 0) {
    const base = baseline?.distance ?? 0;
    distance = Math.max(0, withDist[withDist.length - 1]!.distance! - base);
  } else {
    const withPos = points.filter((p) => p.lat !== null && p.lon !== null);
    if (withPos.length > 1) {
      distance = 0;
      for (let i = 1; i < withPos.length; i++) {
        distance += haversine(withPos[i - 1]!.lat!, withPos[i - 1]!.lon!, withPos[i]!.lat!, withPos[i]!.lon!);
      }
    }
  }

  // Distance covered while the timer was running. Average speed is
  // distance / timer time; counting distance logged while the timer was
  // stopped would make the average exceed what was actually achieved.
  const inPause = (t: number) => pauses.some(([a, b]) => t > a && t < b);
  let runningDistance: number | null = null;
  if (distance !== null) {
    runningDistance = 0;
    const series: { ts: number; d: number }[] = [];
    if (withDist.length > 0) {
      if (baseline?.distance != null) series.push({ ts: baseline.ts, d: baseline.distance });
      else series.push({ ts: start, d: 0 });
      for (const p of withDist) series.push({ ts: p.ts, d: p.distance! });
    } else {
      const withPos = points.filter((p) => p.lat !== null && p.lon !== null);
      let cum = 0;
      withPos.forEach((p, i) => {
        if (i > 0) cum += haversine(withPos[i - 1]!.lat!, withPos[i - 1]!.lon!, p.lat!, p.lon!);
        series.push({ ts: p.ts, d: cum });
      });
    }
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1]!;
      const cur = series[i]!;
      const delta = cur.d - prev.d;
      if (delta > 0 && !inPause((prev.ts + cur.ts) / 2)) runningDistance += delta;
    }
  }

  let ascent: number | null = null;
  let descent: number | null = null;
  const alts = points.map((p) => p.altitude).filter((a): a is number => a !== null);
  if (alts.length > 1) {
    ascent = 0;
    descent = 0;
    let ref = alts[0]!;
    for (const a of alts) {
      if (a - ref >= 1) {
        ascent += a - ref;
        ref = a;
      } else if (ref - a >= 1) {
        descent += ref - a;
        ref = a;
      }
    }
  }

  const [, maxSpeed] = avgMax(points.map((p) => p.speed));
  const [avgHr, maxHr] = avgMax(points.map((p) => p.hr));
  const [avgCad, maxCad] = avgMax(points.map((p) => p.cadence));
  const [avgPower, maxPower] = avgMax(points.map((p) => p.power));
  const firstPos = points.find((p) => p.lat !== null && p.lon !== null) ?? null;
  const lastPos = [...points].reverse().find((p) => p.lat !== null && p.lon !== null) ?? null;
  return {
    start,
    end,
    elapsed,
    timer,
    distance,
    avgSpeed:
      runningDistance !== null && timer > 0
        ? maxSpeed !== null
          ? Math.min(runningDistance / timer, maxSpeed)
          : runningDistance / timer
        : null,
    maxSpeed,
    avgHr,
    maxHr,
    avgCad,
    maxCad,
    avgPower,
    maxPower,
    ascent,
    descent,
    startLat: firstPos?.lat ?? null,
    startLon: firstPos?.lon ?? null,
    endLat: lastPos?.lat ?? null,
    endLon: lastPos?.lon ?? null,
  };
}

const r = (v: number | null, scale = 1, max = Number.POSITIVE_INFINITY): number | null => {
  if (v === null) return null;
  const x = Math.round(v * scale);
  return x >= 0 && x < max ? x : null;
};

const U8 = 0xff;
const U16 = 0xffff;
const U32 = 0xffffffff;

function lapFields(a: Aggregate, index: number, sport: number | null, trigger: number): FieldSpec[] {
  return [
    { num: FIELD.messageIndex, baseType: BT.uint16, value: index },
    { num: FIELD.timestamp, baseType: BT.uint32, value: a.end },
    { num: 0, baseType: BT.enum, value: EVENT.lap },
    { num: 1, baseType: BT.enum, value: EVENT_TYPE.stop },
    { num: 2, baseType: BT.uint32, value: a.start },
    { num: 3, baseType: BT.sint32, value: a.startLat },
    { num: 4, baseType: BT.sint32, value: a.startLon },
    { num: 5, baseType: BT.sint32, value: a.endLat },
    { num: 6, baseType: BT.sint32, value: a.endLon },
    { num: 7, baseType: BT.uint32, value: r(a.elapsed, 1000, U32) },
    { num: 8, baseType: BT.uint32, value: r(a.timer, 1000, U32) },
    { num: 9, baseType: BT.uint32, value: r(a.distance, 100, U32) },
    { num: 13, baseType: BT.uint16, value: r(a.avgSpeed, 1000, U16) },
    { num: 14, baseType: BT.uint16, value: r(a.maxSpeed, 1000, U16) },
    { num: 15, baseType: BT.uint8, value: r(a.avgHr, 1, U8) },
    { num: 16, baseType: BT.uint8, value: r(a.maxHr, 1, U8) },
    { num: 17, baseType: BT.uint8, value: r(a.avgCad, 1, U8) },
    { num: 18, baseType: BT.uint8, value: r(a.maxCad, 1, U8) },
    { num: 19, baseType: BT.uint16, value: r(a.avgPower, 1, U16) },
    { num: 20, baseType: BT.uint16, value: r(a.maxPower, 1, U16) },
    { num: 21, baseType: BT.uint16, value: r(a.ascent, 1, U16) },
    { num: 22, baseType: BT.uint16, value: r(a.descent, 1, U16) },
    { num: 24, baseType: BT.enum, value: trigger },
    { num: 25, baseType: BT.enum, value: sport ?? 0 },
  ];
}

function sessionFields(a: Aggregate, sport: number | null, subSport: number | null, numLaps: number): FieldSpec[] {
  return [
    { num: FIELD.messageIndex, baseType: BT.uint16, value: 0 },
    { num: FIELD.timestamp, baseType: BT.uint32, value: a.end },
    { num: 0, baseType: BT.enum, value: EVENT.session },
    { num: 1, baseType: BT.enum, value: EVENT_TYPE.stop },
    { num: 2, baseType: BT.uint32, value: a.start },
    { num: 3, baseType: BT.sint32, value: a.startLat },
    { num: 4, baseType: BT.sint32, value: a.startLon },
    { num: 38, baseType: BT.sint32, value: a.endLat },
    { num: 39, baseType: BT.sint32, value: a.endLon },
    { num: 5, baseType: BT.enum, value: sport ?? 0 },
    { num: 6, baseType: BT.enum, value: subSport ?? 0 },
    { num: 7, baseType: BT.uint32, value: r(a.elapsed, 1000, U32) },
    { num: 8, baseType: BT.uint32, value: r(a.timer, 1000, U32) },
    { num: 9, baseType: BT.uint32, value: r(a.distance, 100, U32) },
    { num: 14, baseType: BT.uint16, value: r(a.avgSpeed, 1000, U16) },
    { num: 15, baseType: BT.uint16, value: r(a.maxSpeed, 1000, U16) },
    { num: 16, baseType: BT.uint8, value: r(a.avgHr, 1, U8) },
    { num: 17, baseType: BT.uint8, value: r(a.maxHr, 1, U8) },
    { num: 18, baseType: BT.uint8, value: r(a.avgCad, 1, U8) },
    { num: 19, baseType: BT.uint8, value: r(a.maxCad, 1, U8) },
    { num: 20, baseType: BT.uint16, value: r(a.avgPower, 1, U16) },
    { num: 21, baseType: BT.uint16, value: r(a.maxPower, 1, U16) },
    { num: 22, baseType: BT.uint16, value: r(a.ascent, 1, U16) },
    { num: 23, baseType: BT.uint16, value: r(a.descent, 1, U16) },
    { num: 25, baseType: BT.uint16, value: 0 },
    { num: 26, baseType: BT.uint16, value: numLaps },
    { num: 28, baseType: BT.enum, value: 0 },
  ];
}

/** Messages that only appear in non-activity files (courses, workouts, schedules, health data). */
const NON_ACTIVITY_MESGS = new Set<number>([26, 27, 28, 30, 31, 32, 33, 51, 55, 103, 148]);

const TIMER_STOP_TYPES = new Set<number>([EVENT_TYPE.stop, EVENT_TYPE.stopAll, 8, 9]);

/** Inspect decoded messages and plan the summary messages that are missing. */
export function analyze(parse: ParseResult): Analysis {
  const issues: Issue[] = [];
  const data = parse.messages.filter((m) => m.kind === "data");
  const counts: Record<string, number> = {};
  for (const m of data) {
    const n = messageName(m.globalNum);
    counts[n] = (counts[n] ?? 0) + 1;
  }
  const byGlobal = (g: number) => data.filter((m) => m.globalNum === g);
  const fileIds = byGlobal(MESG.fileId);
  const records = byGlobal(MESG.record);
  const laps = byGlobal(MESG.lap);
  const sessions = byGlobal(MESG.session);
  const activities = byGlobal(MESG.activity);
  const events = byGlobal(MESG.event);
  const fileType = fileIds.length > 0 ? num(fileIds[0]!.fields.get(0)) : null;

  const timestamps = data.map((m) => m.timestamp).filter((t): t is number => t !== null);
  const firstTs = timestamps.length > 0 ? minOf(timestamps) : null;
  const lastTs = timestamps.length > 0 ? maxOf(timestamps) : null;

  const points = records.map(toPoint).filter((p): p is RecordPoint => p !== null);
  let backwards = 0;
  for (let i = 1; i < points.length; i++) if (points[i]!.ts < points[i - 1]!.ts) backwards++;

  const sportMsg = byGlobal(MESG.sport)[0];
  const sport =
    num(sessions[0]?.fields.get(5)) ?? num(laps[0]?.fields.get(25)) ?? num(sportMsg?.fields.get(0)) ?? null;
  const subSport = num(sessions[0]?.fields.get(6)) ?? num(sportMsg?.fields.get(1)) ?? null;

  const sessionDistance = num(sessions[0]?.fields.get(9));
  const recordDistances = points.map((p) => p.distance).filter((d): d is number => d !== null);
  const distanceMeters =
    sessionDistance !== null ? sessionDistance / 100 : recordDistances.length > 0 ? maxOf(recordDistances) : null;

  const stats: ActivityStats = {
    messageCounts: counts,
    definitionCount: parse.messages.length - data.length,
    dataMessageCount: data.length,
    fileType,
    records: records.length,
    laps: laps.length,
    sessions: sessions.length,
    activities: activities.length,
    hasDeveloperFields: parse.messages.some((m) => m.kind === "definition" && m.definition.devFields.length > 0),
    firstTimestamp: firstTs,
    lastTimestamp: lastTs,
    elapsedSeconds: firstTs !== null && lastTs !== null ? lastTs - firstTs : null,
    distanceMeters,
    sport,
    backwardsTimestamps: backwards,
  };

  if (backwards > 0) {
    issues.push({
      code: "timestamps_non_monotonic",
      severity: "warning",
      message: `${backwards} record(s) have a timestamp earlier than the previous record. fitfix reports this but does not reorder or drop them.`,
    });
  }
  if (firstTs !== null && firstTs < FIT_MIN_ABSOLUTE_TIME) {
    issues.push({
      code: "relative_timestamps",
      severity: "info",
      message: "Timestamps are relative (device uptime) rather than absolute dates.",
    });
  }

  const synthesize: SynthesizedMessage[] = [];

  // Without a file_id, only call the file an activity when its content says so.
  const nonActivity = data.filter((m) => NON_ACTIVITY_MESGS.has(m.globalNum));
  const activityEvidence = sessions.length > 0 || activities.length > 0 || laps.length > 0 || records.length > 0;
  const inferredActivity = fileIds.length === 0 && activityEvidence && nonActivity.length === 0;

  if (fileIds.length === 0 && !inferredActivity) {
    const why =
      nonActivity.length > 0
        ? `it contains ${[...new Set(nonActivity.map((m) => messageName(m.globalNum)))].join(", ")} messages, which do not belong in an activity`
        : "it has no record, lap, session or activity messages";
    issues.push({
      code: "missing_file_id",
      severity: "error",
      message: `No file_id message, and the file type cannot be inferred safely (${why}). fitfix does not add one; lap/session/activity messages are not checked.`,
    });
    return { stats, issues, synthesize };
  }

  if (inferredActivity) {
    issues.push({
      code: "missing_file_id",
      severity: "error",
      message: "No file_id message: uploaders reject files without one. The content (records/laps/session, no course or workout messages) indicates an activity.",
    });
    synthesize.push({
      globalNum: MESG.fileId,
      name: "file_id",
      position: "start",
      reason: "file_id message is missing; type activity inferred from the content",
      fields: [
        { num: 0, baseType: BT.enum, value: FILE_TYPE_ACTIVITY },
        { num: 1, baseType: BT.uint16, value: MANUFACTURER_DEVELOPMENT },
        { num: 2, baseType: BT.uint16, value: 0 },
        { num: 4, baseType: BT.uint32, value: firstTs },
      ],
    });
  }

  const isActivity = fileType === null || fileType === FILE_TYPE_ACTIVITY;
  if (!isActivity) {
    issues.push({
      code: "not_activity_file",
      severity: "info",
      message: `file_id.type is ${fileType}, not an activity (4): lap/session/activity messages are not checked.`,
    });
    return { stats, issues, synthesize };
  }
  if (points.length === 0 && laps.length === 0) {
    issues.push({ code: "no_activity_data", severity: "warning", message: "No record or lap messages: there is no activity data to summarize." });
    return { stats, issues, synthesize };
  }

  // Timer pauses from timer stop/start events.
  const timerEvents = events
    .filter((e) => num(e.fields.get(0)) === EVENT.timer && e.timestamp !== null)
    .map((e) => ({ ts: e.timestamp!, type: num(e.fields.get(1)) }));
  const pauses: [number, number][] = [];
  let stoppedAt: number | null = null;
  for (const e of timerEvents) {
    if (e.type !== null && TIMER_STOP_TYPES.has(e.type)) stoppedAt ??= e.ts;
    else if (e.type === EVENT_TYPE.start && stoppedAt !== null) {
      pauses.push([stoppedAt, e.ts]);
      stoppedAt = null;
    }
  }
  // A final stop that was never followed by a start pauses the timer until the end.
  if (stoppedAt !== null) pauses.push([stoppedAt, Number.POSITIVE_INFINITY]);

  const firstTimerStart = timerEvents.find((e) => e.type === EVENT_TYPE.start)?.ts ?? null;
  const startCandidates = [firstTimerStart, points[0]?.ts ?? null, num(laps[0]?.fields.get(2))].filter((x): x is number => x !== null);
  const activityStart = startCandidates.length > 0 ? Math.min(...startCandidates) : (firstTs ?? 0);
  const synthesizedLaps: SynthesizedMessage[] = [];

  if (sessions.length === 0) {
    if (laps.length === 0) {
      issues.push({ code: "missing_lap", severity: "error", message: "No lap message: the device probably stopped before writing its summary." });
      const a = aggregate(points, activityStart, null, pauses);
      synthesizedLaps.push({ globalNum: MESG.lap, name: "lap", position: "end", reason: "no lap message", fields: lapFields(a, 0, sport, 7) });
    } else {
      const lastLapEnd = maxOf(laps.map((l) => l.timestamp ?? 0));
      const after = points.filter((p) => p.ts > lastLapEnd);
      if (after.length > 0) {
        issues.push({
          code: "records_after_last_lap",
          severity: "error",
          message: `${after.length} record(s) come after the last lap: the final lap was never closed.`,
        });
        const baseline = [...points].reverse().find((p) => p.ts <= lastLapEnd && p.distance !== null) ?? null;
        const a = aggregate(after, lastLapEnd, baseline, pauses);
        synthesizedLaps.push({ globalNum: MESG.lap, name: "lap", position: "end", reason: "final lap was not closed", fields: lapFields(a, laps.length, sport, 7) });
      }
    }
    synthesize.push(...synthesizedLaps);

    const lastEvent = events[events.length - 1];
    const lastIsStop =
      lastEvent !== undefined && num(lastEvent.fields.get(0)) === EVENT.timer && TIMER_STOP_TYPES.has(num(lastEvent.fields.get(1)) ?? -1);
    const total = aggregate(points, activityStart, null, pauses);
    if (!lastIsStop) {
      synthesize.push({
        globalNum: MESG.event,
        name: "event",
        position: "end",
        reason: "timer was never stopped",
        fields: [
          { num: FIELD.timestamp, baseType: BT.uint32, value: total.end },
          { num: 0, baseType: BT.enum, value: EVENT.timer },
          { num: 1, baseType: BT.enum, value: EVENT_TYPE.stopAll },
          { num: 4, baseType: BT.uint8, value: 0 },
        ],
      });
    }
    issues.push({ code: "missing_session", severity: "error", message: "No session message: Garmin Connect and Strava need one to import an activity." });
    synthesize.push({
      globalNum: MESG.session,
      name: "session",
      position: "end",
      reason: "no session message",
      fields: sessionFields(total, sport, subSport, laps.length + synthesizedLaps.length),
    });
  }

  if (activities.length === 0) {
    issues.push({ code: "missing_activity", severity: "error", message: "No activity message at the end of the file." });
    const sessionTimer =
      sessions.length > 0
        ? sessions.reduce((s, m) => s + (num(m.fields.get(8)) ?? 0), 0)
        : r(aggregate(points, activityStart, null, pauses).timer, 1000, U32);
    const endTs =
      sessions.length > 0 ? Math.max(...sessions.map((s) => s.timestamp ?? 0), lastTs ?? 0) : (points[points.length - 1]?.ts ?? lastTs);
    synthesize.push({
      globalNum: MESG.activity,
      name: "activity",
      position: "end",
      reason: "no activity message",
      fields: [
        { num: FIELD.timestamp, baseType: BT.uint32, value: endTs },
        { num: 0, baseType: BT.uint32, value: sessionTimer },
        { num: 1, baseType: BT.uint16, value: Math.max(1, sessions.length) },
        { num: 2, baseType: BT.enum, value: 0 },
        { num: 3, baseType: BT.enum, value: EVENT.activity },
        { num: 4, baseType: BT.enum, value: EVENT_TYPE.stop },
      ],
    });
  }

  return { stats, issues, synthesize };
}
