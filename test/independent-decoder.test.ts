/**
 * Cross-checks fitfix output with an independent FIT decoder,
 * `fit-file-parser` (MIT, https://github.com/jimmykane/fit-parser), so that
 * the suite does not rely only on fitfix's own codec.
 *
 * The decoder runs with `{ force: false, strict: true }`: header CRC, file CRC,
 * complete records, valid definitions and no trailing bytes are all required.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import FitParser from "fit-file-parser";
import { FIT_EPOCH_OFFSET, MESG } from "../src/profile.js";
import { parseFit } from "../src/reader.js";
import { repair } from "../src/repair.js";
import { buildActivity, insertBytes, mutate, setU32, T0 } from "./helpers.js";

/* The decoder's result objects are loosely typed. */
type Decoded = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const strict = new FitParser({ force: false, strict: true, mode: "list" });

async function decodeAll(bytes: Uint8Array): Promise<Decoded[]> {
  return (await strict.parseFilesAsync(Buffer.from(bytes))) as Decoded[];
}

async function decodeOne(bytes: Uint8Array): Promise<Decoded> {
  const files = await decodeAll(bytes);
  assert.equal(files.length, 1);
  return files[0]!;
}

const fitDate = (t: number) => new Date((t + FIT_EPOCH_OFFSET) * 1000);
const recordCount = (bytes: Uint8Array) =>
  parseFit(bytes).messages.filter((m) => m.kind === "data" && m.globalNum === MESG.record).length;
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

const CORRUPTIONS: [string, () => Uint8Array][] = [
  ["header CRC", () => mutate(buildActivity({ records: 60 }).bytes, (x) => (x[12] = x[12]! ^ 0x5a))],
  ["signature", () => mutate(buildActivity({ records: 60 }).bytes, (x) => x.set([0, 0, 0, 0], 8))],
  ["header size byte", () => mutate(buildActivity({ records: 60 }).bytes, (x) => (x[0] = 0xc3))],
  ["data size zero", () => mutate(buildActivity({ records: 60 }).bytes, (x) => setU32(x, 4, 0))],
  ["data size too large", () => mutate(buildActivity({ records: 60 }).bytes, (x) => setU32(x, 4, 0xffffff))],
  ["file CRC", () => mutate(buildActivity({ records: 60 }).bytes, (x) => (x[x.length - 1] = x[x.length - 1]! ^ 0xff))],
  ["file CRC missing", () => {
    const b = buildActivity({ records: 60 }).bytes;
    return b.slice(0, b.length - 2);
  }],
  ["trailing junk", () => concat(buildActivity({ records: 30 }).bytes, Uint8Array.of(0xff, 0xff, 0x00, 0x12))],
  ["crash before summary", () => buildActivity({ records: 300, summary: false }).bytes],
  ["cut mid-record", () => {
    const b = buildActivity({ records: 200, summary: false }).bytes;
    return b.slice(0, b.length - 13);
  }],
  ["unclosed last lap", () => buildActivity({ records: 100, lapEvery: 40, summary: false }).bytes],
  ["timer pause", () => buildActivity({ records: 100, summary: false, pauseAt: 50, pauseSeconds: 600 }).bytes],
  ["final stop without restart", () => buildActivity({ records: 100, summary: false, stopWithoutRestartAt: 70 }).bytes],
  ["injected garbage", () => {
    const a = buildActivity({ records: 120 });
    return insertBytes(a.bytes, a.summaryOffset - 25 * 60, [0x77, 0x13, 0xee, 0x91, 0x05, 0xaa, 0x3c]);
  }],
  ["overwritten record", () => {
    const a = buildActivity({ records: 120 });
    const pos = a.summaryOffset - 25 * 30;
    return mutate(a.bytes, (x) => x.fill(0xf7, pos, pos + 25));
  }],
  ["developer fields", () => buildActivity({ records: 40, developerFields: true, summary: false }).bytes],
  ["missing file_id", () => buildActivity({ records: 40, noFileId: true }).bytes],
  ["missing activity only", () => {
    const b = buildActivity({ records: 50 }).bytes;
    return b.slice(0, b.length - 2 - 38);
  }],
];

describe("independent decoder: it really validates", () => {
  it("rejects a file with a bad file CRC and one cut mid-record", async () => {
    const good = buildActivity({ records: 30 }).bytes;
    await assert.rejects(decodeAll(mutate(good, (x) => (x[x.length - 1] = x[x.length - 1]! ^ 0xff))));
    await assert.rejects(decodeAll(good.slice(0, good.length - 13)));
    await assert.rejects(decodeAll(mutate(good, (x) => (x[12] = x[12]! ^ 0x5a))));
  });
});

describe("independent decoder: every repaired fixture decodes strictly", () => {
  for (const [label, make] of CORRUPTIONS) {
    it(label, async () => {
      const res = repair(make());
      assert.equal(res.after.healthy, true, JSON.stringify(res.after.issues));
      const d = await decodeOne(res.output);
      assert.equal(d["records"].length, recordCount(res.output));
      assert.equal(d["file_ids"].length, 1);
      assert.equal(d["sessions"].length, 1);
      assert.ok(d["activity"], "activity message decoded");
      for (const s of [...d["sessions"], ...d["laps"]]) {
        if (s.avg_speed !== undefined && s.max_speed !== undefined) {
          assert.ok(s.avg_speed <= s.max_speed + 1e-9, `avg_speed ${s.avg_speed} > max_speed ${s.max_speed}`);
        }
        assert.ok(s.total_timer_time <= s.total_elapsed_time + 1e-9);
      }
    });
  }

  it("a repaired chain decodes as separate files", async () => {
    const a = buildActivity({ records: 30 }).bytes;
    const b = buildActivity({ records: 45, summary: false }).bytes;
    const res = repair(concat(a, b));
    const files = await decodeAll(res.output);
    assert.equal(files.length, 2);
    assert.equal(files[0]!["records"].length, 30);
    assert.equal(files[1]!["records"].length, 45);
    assert.equal(files[1]!["sessions"].length, 1);
  });
});

describe("independent decoder: synthesized messages carry the expected values", () => {
  it("file_id, laps, session, activity and timer stop", async () => {
    const a = buildActivity({ records: 100, lapEvery: 40, summary: false, noFileId: true, stopWithoutRestartAt: 90 });
    const res = repair(a.bytes);
    const d = await decodeOne(res.output);

    const [fileId] = d["file_ids"];
    assert.equal(fileId.type, "activity");
    assert.equal(fileId.manufacturer, "development");
    assert.deepEqual(fileId.time_created, fitDate(T0));

    assert.equal(d["laps"].length, 3);
    const last = d["laps"][2];
    assert.deepEqual(last.start_time, fitDate(T0 + 79));
    assert.deepEqual(last.timestamp, fitDate(T0 + 99));
    assert.equal(last.total_elapsed_time, 20);
    assert.equal(last.total_timer_time, 11); // stopped at T0+90, never restarted
    assert.equal(last.total_distance, 20 * 3);
    assert.equal(last.sport, "cycling");

    const [session] = d["sessions"];
    assert.deepEqual(session.start_time, fitDate(T0));
    assert.deepEqual(session.timestamp, fitDate(T0 + 99));
    assert.equal(session.total_elapsed_time, 99);
    assert.equal(session.total_timer_time, 90);
    assert.equal(session.total_distance, a.totalDistance);
    assert.equal(session.sport, "cycling");
    assert.equal(session.num_laps, 3);
    assert.equal(session.max_heart_rate, 149);
    assert.equal(session.trigger, "activity_end");
    assert.ok(Math.abs(session.end_position_lat - ((545_000_000 + 99_000) * 180) / 2 ** 31) < 1e-6);

    assert.deepEqual(d["activity"].timestamp, fitDate(T0 + 99));
    assert.equal(d["activity"].total_timer_time, 90);
    assert.equal(d["activity"].num_sessions, 1);
    assert.equal(d["activity"].event, "activity");
  });

  it("adds a timer stop_all event when the timer was never stopped", async () => {
    const a = buildActivity({ records: 50, summary: false });
    const d = await decodeOne(repair(a.bytes).output);
    const lastEvent = d["events"][d["events"].length - 1];
    assert.equal(lastEvent.event, "timer");
    assert.equal(lastEvent.event_type, "stop_all");
    assert.deepEqual(lastEvent.timestamp, fitDate(T0 + 49));
  });
});

describe("independent decoder: healthy files", () => {
  it("pass through unchanged and decode identically", async () => {
    const a = buildActivity({ records: 80, lapEvery: 30, developerFields: true });
    const res = repair(a.bytes);
    assert.equal(res.changed, false);
    assert.deepEqual(res.output, a.bytes);
    const before = await decodeOne(a.bytes);
    const after = await decodeOne(res.output);
    assert.deepEqual(after["records"], before["records"]);
    assert.deepEqual(after["sessions"], before["sessions"]);
    assert.deepEqual(after["laps"], before["laps"]);
  });
});
