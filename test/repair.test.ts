import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitCrc } from "../src/crc.js";
import { MESG } from "../src/profile.js";
import { parseFit } from "../src/reader.js";
import { inspect, repair } from "../src/repair.js";
import { buildActivity, codes, insertBytes, mutate, setU32, T0 } from "./helpers.js";

function dataMessages(bytes: Uint8Array, globalNum: number) {
  return parseFit(bytes).messages.filter((m) => m.kind === "data" && m.globalNum === globalNum);
}

function assertRepaired(bytes: Uint8Array, expectRecords: number) {
  const original = bytes.slice();
  const res = repair(bytes);
  assert.deepEqual(bytes, original, "input buffer must not be modified");
  assert.equal(res.changed, true);
  assert.equal(res.after.healthy, true, `after: ${JSON.stringify(res.after.issues)}`);
  const p = parseFit(res.output);
  assert.equal(p.strategy, "declared");
  assert.equal(p.fileCrc.status, "valid");
  assert.equal(p.header.crcStatus === "valid" || p.header.crcStatus === "absent", true);
  assert.equal(dataMessages(res.output, MESG.record).length, expectRecords);
  // Repairing again must be a no-op.
  const again = repair(res.output);
  assert.equal(again.changed, false);
  assert.deepEqual(again.output, res.output);
  return res;
}

describe("healthy files", () => {
  it("reports no issues and repair returns identical bytes", () => {
    const a = buildActivity({ records: 60, lapEvery: 25 });
    const r = inspect(a.bytes);
    assert.equal(r.healthy, true);
    assert.deepEqual(r.issues, []);
    assert.equal(r.stats.records, 60);
    assert.equal(r.stats.laps, 3);
    assert.equal(r.stats.sessions, 1);
    const res = repair(a.bytes);
    assert.equal(res.changed, false);
    assert.deepEqual(res.output, a.bytes);
  });

  it("accepts a 12-byte header", () => {
    const a = buildActivity({ records: 10, header: { headerSize: 12 } });
    assert.equal(inspect(a.bytes).healthy, true);
  });

  it("accepts a zero header CRC", () => {
    const a = buildActivity({ records: 10 });
    const b = mutate(a.bytes, (x) => {
      x[12] = 0;
      x[13] = 0;
      // The file CRC covers the header too, so it must be recomputed.
      const crc = fitCrc(x, 0, x.length - 2);
      x[x.length - 2] = crc & 0xff;
      x[x.length - 1] = crc >> 8;
    });
    const r = inspect(b);
    assert.equal(r.header.crcStatus, "zero");
    assert.equal(r.healthy, true);
  });
});

describe("header damage", () => {
  it("fixes a wrong header CRC", () => {
    const a = buildActivity({ records: 30 });
    const b = mutate(a.bytes, (x) => (x[12] = x[12]! ^ 0x55));
    assert.ok(codes(inspect(b).issues).includes("header_crc_invalid"));
    assertRepaired(b, 30);
  });

  it("fixes a damaged .FIT signature", () => {
    const a = buildActivity({ records: 30 });
    const b = mutate(a.bytes, (x) => x.set([0, 0, 0, 0], 8));
    const r = inspect(b);
    assert.ok(codes(r.issues).includes("signature_invalid"));
    const res = assertRepaired(b, 30);
    assert.deepEqual([...res.output.subarray(8, 12)], [0x2e, 0x46, 0x49, 0x54]);
  });

  it("recovers from a garbage header size byte", () => {
    const a = buildActivity({ records: 30 });
    const b = mutate(a.bytes, (x) => (x[0] = 0xc3));
    const r = inspect(b);
    assert.ok(codes(r.issues).includes("header_size_invalid"));
    assert.equal(r.dataStart, 14);
    assertRepaired(b, 30);
  });

  it("recovers a 12-byte-header file whose size byte is damaged", () => {
    const a = buildActivity({ records: 30, header: { headerSize: 12 } });
    const b = mutate(a.bytes, (x) => (x[0] = 0));
    assert.equal(inspect(b).dataStart, 12);
    assertRepaired(b, 30);
  });
});

describe("data size and CRC damage", () => {
  const sizeCases: [string, (real: number) => number][] = [
    ["zero", () => 0],
    ["far too large", () => 0x00ffffff],
    ["slightly too small", (real) => real - 7],
    ["slightly too large", (real) => real + 9],
  ];
  for (const [label, wrong] of sizeCases) {
    it(`fixes a data size that is ${label}`, () => {
      const a = buildActivity({ records: 40 });
      const real = a.bytes.length - 16;
      const b = mutate(a.bytes, (x) => setU32(x, 4, wrong(real)));
      const r = inspect(b);
      assert.ok(codes(r.issues).includes("data_size_mismatch"), JSON.stringify(r.issues));
      assert.equal(r.dataEnd - r.dataStart, real);
      // Summary data is intact: nothing should be synthesized.
      assert.deepEqual(r.plannedMessages, []);
      const res = assertRepaired(b, 40);
      assert.deepEqual(res.output, a.bytes);
    });
  }

  it("fixes a wrong file CRC and keeps the content byte-identical", () => {
    const a = buildActivity({ records: 40 });
    const b = mutate(a.bytes, (x) => (x[x.length - 1] = x[x.length - 1]! ^ 0xff));
    assert.ok(codes(inspect(b).issues).includes("file_crc_invalid"));
    const res = assertRepaired(b, 40);
    assert.deepEqual(res.output, a.bytes);
  });

  it("adds a missing file CRC", () => {
    const a = buildActivity({ records: 40 });
    const b = a.bytes.slice(0, a.bytes.length - 2);
    assert.ok(codes(inspect(b).issues).includes("file_crc_missing"));
    const res = assertRepaired(b, 40);
    assert.deepEqual(res.output, a.bytes);
  });

  it("drops trailing junk after the CRC", () => {
    const a = buildActivity({ records: 20 });
    const b = Uint8Array.from([...a.bytes, 0xff, 0xff, 0xff, 0x00, 0x12]);
    assert.ok(codes(inspect(b).issues).includes("trailing_bytes"));
    const res = assertRepaired(b, 20);
    assert.deepEqual(res.output, a.bytes);
  });
});

describe("truncated files (device crash)", () => {
  it("rebuilds lap, timer stop, session and activity when the summary was never written", () => {
    const a = buildActivity({ records: 300, summary: false });
    // A crashed watch leaves the header with data size 0 or a stale value; keep it as written.
    const r = inspect(a.bytes);
    for (const c of ["missing_lap", "missing_session", "missing_activity"]) assert.ok(codes(r.issues).includes(c), c);
    assert.deepEqual(
      r.plannedMessages.map((p) => p.name),
      ["lap", "event", "session", "activity"],
    );
    const res = assertRepaired(a.bytes, 300);
    const [lap] = dataMessages(res.output, MESG.lap);
    const [session] = dataMessages(res.output, MESG.session);
    const [activity] = dataMessages(res.output, MESG.activity);
    assert.ok(lap && session && activity);
    assert.equal(session.fields.get(2), T0);
    assert.equal(session.timestamp, a.lastRecordTs);
    assert.equal(session.fields.get(7), 299_000);
    assert.equal(session.fields.get(8), 299_000);
    assert.equal(session.fields.get(9), a.totalDistance * 100);
    assert.equal(session.fields.get(5), 0);
    assert.equal(session.fields.get(26), 1);
    assert.equal(session.fields.get(14), 3000);
    assert.equal(session.fields.get(17), 149);
    assert.equal(lap.fields.get(9), a.totalDistance * 100);
    assert.equal(activity.fields.get(1), 1);
  });

  it("drops a half-written final record and keeps every complete one", () => {
    const a = buildActivity({ records: 200, summary: false });
    // Cut 5 bytes into the last record (no CRC, typical of a crash).
    const lastRecordStart = a.bytes.length - 2 - 25;
    const b = a.bytes.slice(0, lastRecordStart + 5);
    const r = inspect(b);
    assert.ok(codes(r.issues).includes("truncated_message"), JSON.stringify(r.issues));
    assert.equal(r.stats.records, 199);
    assertRepaired(b, 199);
  });

  it("truncation at many offsets always yields a valid file", () => {
    const a = buildActivity({ records: 80, lapEvery: 30 });
    for (let cut = 200; cut < a.bytes.length - 2; cut += 37) {
      const b = a.bytes.slice(0, cut);
      const res = repair(b);
      assert.equal(res.after.healthy, true, `cut at ${cut}: ${JSON.stringify(res.after.issues)}`);
      const p = parseFit(res.output);
      assert.equal(p.fileCrc.status, "valid");
      assert.equal(dataMessages(res.output, MESG.session).length, 1, `cut at ${cut}`);
    }
  });

  it("closes the final lap but keeps the laps already written", () => {
    const a = buildActivity({ records: 100, lapEvery: 40, summary: false });
    assert.equal(a.laps, 2);
    const r = inspect(a.bytes);
    assert.ok(codes(r.issues).includes("records_after_last_lap"));
    const res = assertRepaired(a.bytes, 100);
    const laps = dataMessages(res.output, MESG.lap);
    assert.equal(laps.length, 3);
    assert.deepEqual(laps.map((l) => l.fields.get(254)), [0, 1, 2]);
    const last = laps[2]!;
    // Lap 3 covers records 80..99: 20 records, 3 m each, starting after the lap-2 record.
    assert.equal(last.fields.get(2), T0 + 79);
    assert.equal(last.fields.get(9), (99 - 79) * 3 * 100);
    const [session] = dataMessages(res.output, MESG.session);
    assert.equal(session!.fields.get(26), 3);
  });

  it("subtracts timer pauses from timer time", () => {
    const a = buildActivity({ records: 100, summary: false, pauseAt: 50, pauseSeconds: 600 });
    const res = assertRepaired(a.bytes, 100);
    const [session] = dataMessages(res.output, MESG.session);
    assert.equal(session!.fields.get(7), (99 + 600) * 1000);
    assert.equal(session!.fields.get(8), 99 * 1000);
  });

  it("only adds the activity message when the session exists", () => {
    const a = buildActivity({ records: 50 });
    const activityLen = 1 + 6 + 6 * 3 + (4 + 4 + 2 + 1 + 1 + 1);
    const b = a.bytes.slice(0, a.bytes.length - 2 - activityLen);
    const r = inspect(b);
    assert.deepEqual(r.plannedMessages.map((p) => p.name), ["activity"]);
    assertRepaired(b, 50);
  });

  it("--no-synthesize style repair fixes low-level damage only", () => {
    const a = buildActivity({ records: 50, summary: false });
    const b = mutate(a.bytes, (x) => (x[12] = x[12]! ^ 1));
    const res = repair(b, { synthesize: false });
    assert.equal(res.changed, true);
    assert.equal(dataMessages(res.output, MESG.session).length, 0);
    assert.ok(!codes(res.after.issues).includes("header_crc_invalid"));
    assert.ok(codes(res.after.issues).includes("missing_session"));
  });
});

describe("mid-file corruption", () => {
  it("skips injected garbage and keeps the records after it", () => {
    const a = buildActivity({ records: 120 });
    const pos = a.summaryOffset - 25 * 60; // between two records, well inside the record stream
    const b = insertBytes(a.bytes, pos, [0x77, 0x13, 0xee, 0x91, 0x05, 0xaa, 0x3c]);
    const r = inspect(b);
    assert.ok(codes(r.issues).includes("garbage_skipped"), JSON.stringify(r.issues));
    assert.equal(r.stats.records, 120);
    assert.equal(r.stats.sessions, 1);
    assertRepaired(b, 120);
  });

  it("drops a record whose bytes were overwritten, keeping the rest", () => {
    const a = buildActivity({ records: 120 });
    const pos = a.summaryOffset - 25 * 30;
    const b = mutate(a.bytes, (x) => x.fill(0xf7, pos, pos + 25));
    const r = inspect(b);
    assert.ok(codes(r.issues).includes("garbage_skipped"), JSON.stringify(r.issues));
    assert.ok(r.stats.records >= 118, `kept ${r.stats.records}`);
    assert.equal(r.stats.sessions, 1);
    assertRepaired(b, r.stats.records);
  });

  it("preserves developer fields byte for byte", () => {
    const a = buildActivity({ records: 40, developerFields: true, summary: false });
    const res = assertRepaired(a.bytes, 40);
    const before = parseFit(a.bytes);
    const after = parseFit(res.output);
    const devDefs = (p: typeof before) => p.messages.filter((m) => m.kind === "definition" && m.definition.devFields.length > 0).length;
    assert.equal(devDefs(after), devDefs(before));
    // All original record bytes appear unchanged in the output.
    const orig = a.bytes.subarray(before.dataStart, before.dataEnd);
    assert.deepEqual(res.output.subarray(after.dataStart, after.dataStart + orig.length), orig);
  });

  it("adds a file_id when it is missing", () => {
    const a = buildActivity({ records: 30 });
    const p = parseFit(a.bytes);
    const fileIdLen = p.messages[0]!.length + p.messages[1]!.length;
    const stripped = Uint8Array.from([...a.bytes.subarray(0, 14), ...a.bytes.subarray(14 + fileIdLen, a.bytes.length - 2)]);
    const r = inspect(stripped);
    assert.ok(codes(r.issues).includes("missing_file_id"));
    const res = assertRepaired(stripped, 30);
    const [fileId] = dataMessages(res.output, MESG.fileId);
    assert.equal(fileId!.fields.get(0), 4);
  });
});
