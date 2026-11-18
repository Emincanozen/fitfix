/**
 * Regression tests for the findings of an independent review. Each test was
 * written first and observed failing on the previous code.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BT, MESG } from "../src/profile.js";
import { parseFit } from "../src/reader.js";
import { inspect, repair } from "../src/repair.js";
import { assembleFitFile, FitBuilder } from "../src/writer.js";
import { buildActivity, codes, insertBytes, T0 } from "./helpers.js";

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Split a (repaired) chain into members using each member's own header. */
function members(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const p = parseFit(bytes.subarray(pos));
    const end = p.dataEnd + 2;
    out.push(bytes.subarray(pos, pos + end));
    pos += end;
  }
  return out;
}

const dataCount = (bytes: Uint8Array, g: number) => parseFit(bytes).messages.filter((m) => m.kind === "data" && m.globalNum === g).length;

describe("review: chained FIT files", () => {
  it("keeps every member of a healthy chain, byte for byte", () => {
    const a = buildActivity({ records: 30 }).bytes;
    const b = buildActivity({ records: 45 }).bytes;
    const chain = concat(a, b);
    const r = inspect(chain);
    assert.equal(r.healthy, true, JSON.stringify(r.issues));
    const res = repair(chain);
    assert.equal(res.changed, false);
    assert.deepEqual(res.output, chain);
  });

  it("repairs each member of a chain and keeps all of them", () => {
    const a = buildActivity({ records: 30 }).bytes;
    const b = buildActivity({ records: 45, summary: false }).bytes;
    const c = buildActivity({ records: 20 }).bytes;
    const chain = concat(a, b, c);
    const res = repair(chain);
    assert.equal(res.after.healthy, true, JSON.stringify(res.after.issues));
    const parts = members(res.output);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[0], a);
    assert.equal(dataCount(parts[1]!, MESG.record), 45);
    assert.equal(dataCount(parts[1]!, MESG.session), 1);
    assert.deepEqual(parts[2], c);
    for (const p of parts) assert.equal(parseFit(p).fileCrc.status, "valid");
  });
});

describe("review: missing file_id type inference", () => {
  it("does not label a course-like file as an activity", () => {
    const bld = new FitBuilder();
    bld.message(31, [{ num: 5, baseType: BT.string, size: 8, value: "Loop" }]); // course
    for (let i = 0; i < 10; i++) {
      bld.message(MESG.record, [
        { num: 253, baseType: BT.uint32, value: T0 + i },
        { num: 0, baseType: BT.sint32, value: 545_000_000 + i * 1000 },
        { num: 1, baseType: BT.sint32, value: 25_000_000 + i * 1000 },
      ], { localType: 1 });
    }
    const bytes = assembleFitFile(bld.bytes());
    const r = inspect(bytes);
    assert.ok(codes(r.issues).includes("missing_file_id"));
    assert.ok(!r.plannedMessages.some((p) => p.name === "file_id"), JSON.stringify(r.plannedMessages));
    assert.ok(!r.plannedMessages.some((p) => p.name === "session"), JSON.stringify(r.plannedMessages));
  });

  it("does not invent a file_id when there is no evidence of the file type", () => {
    const bld = new FitBuilder();
    bld.message(MESG.deviceInfo, [{ num: 253, baseType: BT.uint32, value: T0 }, { num: 0, baseType: BT.uint8, value: 0 }]);
    const r = inspect(assembleFitFile(bld.bytes()));
    assert.ok(codes(r.issues).includes("missing_file_id"));
    assert.deepEqual(r.plannedMessages, []);
  });

  it("still infers an activity when records and summary messages show one", () => {
    const a = buildActivity({ records: 30, noFileId: true });
    const r = inspect(a.bytes);
    assert.deepEqual(r.plannedMessages.map((p) => p.name), ["file_id"]);
  });
});

describe("review: final timer stop without restart", () => {
  it("excludes the stopped interval from timer time", () => {
    const a = buildActivity({ records: 100, summary: false, stopWithoutRestartAt: 50 });
    const res = repair(a.bytes);
    assert.equal(res.after.healthy, true);
    const msgs = parseFit(res.output).messages.filter((m) => m.kind === "data");
    const session = msgs.find((m) => m.globalNum === MESG.session)!;
    const lap = msgs.find((m) => m.globalNum === MESG.lap)!;
    const activity = msgs.find((m) => m.globalNum === MESG.activity)!;
    assert.equal(session.fields.get(7), 99_000);
    assert.equal(session.fields.get(8), 50_000);
    assert.equal(lap.fields.get(8), 50_000);
    assert.equal(activity.fields.get(0), 50_000);
  });
});

describe("review: resynchronization must not keep false records", () => {
  it("skips garbage that happens to parse under a short definition", () => {
    const bld = new FitBuilder();
    bld.message(MESG.fileId, [{ num: 0, baseType: BT.enum, value: 4 }, { num: 4, baseType: BT.uint32, value: T0 }], { localType: 2 });
    // A permissive 1-byte message type on local 0 (manufacturer-specific range).
    bld.message(0xff00, [{ num: 0, baseType: BT.uint8, value: 7 }], { localType: 0 });
    for (let i = 0; i < 40; i++) {
      bld.message(MESG.record, [
        { num: 253, baseType: BT.uint32, value: T0 + i },
        { num: 3, baseType: BT.uint8, value: 130 },
        { num: 5, baseType: BT.uint32, value: i * 300 },
      ], { localType: 1 });
    }
    const clean = assembleFitFile(bld.bytes());
    const recordLen = 1 + 4 + 1 + 4;
    const pos = clean.length - 2 - recordLen * 20;
    // 0x7f is an invalid header; then pairs that each look like a local-0 message.
    const garbage = [0x7f, 0x00, 0x11, 0x00, 0x22, 0x00, 0x33, 0x00, 0x44, 0x00, 0x55, 0x00, 0x66];
    const bytes = insertBytes(clean, pos, garbage);
    const r = inspect(bytes);
    assert.ok(codes(r.issues).includes("garbage_skipped"));
    assert.equal(r.stats.records, 40);
    const res = repair(bytes);
    assert.equal(dataCount(res.output, 0xff00), 1, "bogus manufacturer messages were kept");
    assert.equal(dataCount(res.output, MESG.record), 40);
    assert.ok(res.actions.some((x) => x.includes(`${garbage.length} unreadable byte`)), JSON.stringify(res.actions));
  });
});

describe("review: synthesized session end position", () => {
  it("emits end_position_lat/long (fields 38/39)", () => {
    const a = buildActivity({ records: 30, summary: false });
    const res = repair(a.bytes);
    const session = parseFit(res.output).messages.find((m) => m.kind === "data" && m.globalNum === MESG.session)!;
    assert.equal(session.fields.get(38), 545_000_000 + 29 * 1000);
    assert.equal(session.fields.get(39), 25_000_000 + 29 * 1000);
  });
});

describe("review: packaging and docs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
    files: string[];
  };
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

  it("builds dist/ before packing", () => {
    assert.match(pkg.scripts["prepack"] ?? "", /build/);
    assert.ok(pkg.files.includes("dist"));
  });

  it("README does not promise acceptance by Garmin Connect or Strava", () => {
    const intro = readme.split("\n## ")[0]!;
    assert.doesNotMatch(intro, /so that Garmin Connect, Strava and other tools accept them/);
    assert.doesNotMatch(readme, /\*\*Keeps your data\.\*\* Every readable record/);
    assert.match(intro, /not (been )?verified/i);
  });
});
