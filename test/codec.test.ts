import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitCrc } from "../src/crc.js";
import { FitParseError, parseFit } from "../src/reader.js";
import { assembleFitFile, FitBuilder } from "../src/writer.js";
import { BT, MESG } from "../src/profile.js";
import { buildActivity, T0 } from "./helpers.js";

describe("fitCrc", () => {
  it("matches the CRC-16/ARC check value", () => {
    assert.equal(fitCrc(new TextEncoder().encode("123456789")), 0xbb3d);
  });
  it("is 0 for empty input and can be computed incrementally", () => {
    const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(fitCrc(new Uint8Array(0)), 0);
    assert.equal(fitCrc(data, 4, 10, fitCrc(data, 0, 4)), fitCrc(data));
  });
  it("a buffer followed by its little-endian CRC has CRC 0", () => {
    const data = Uint8Array.from([0x0e, 0x20, 0x54, 0x08, 0x00, 0x00]);
    const c = fitCrc(data);
    assert.equal(fitCrc(Uint8Array.from([...data, c & 0xff, c >> 8])), 0);
  });
});

/** A minimal FIT file written byte by byte, independent of FitBuilder. */
function handMadeFile(): Uint8Array {
  const records = [
    // Definition, local 0, little endian, global 0 (file_id), 2 fields
    0x40, 0x00, 0x00, 0x00, 0x00, 0x02,
    0x00, 0x01, 0x00, // type: enum
    0x04, 0x04, 0x86, // time_created: uint32
    // Data, local 0
    0x00, 0x04, 0x00, 0xca, 0x9a, 0x3b, // type=4, time_created=1_000_000_000 (0x3B9ACA00)
    // Definition, local 1, BIG endian, global 20 (record): timestamp + heart_rate
    0x41, 0x00, 0x01, 0x00, 0x14, 0x02,
    0xfd, 0x04, 0x86,
    0x03, 0x01, 0x02,
    // Data, local 1
    0x01, 0x3b, 0x9a, 0xca, 0x05, 0x8c, // ts = 1_000_000_005, hr = 140
    // Compressed timestamp header: local 1, offset 7 -> ts 1_000_000_007
    0x80 | (1 << 5) | 7, 0x3b, 0x9a, 0xca, 0x05, 0x8d,
    // Compressed timestamp header with offset rollover: offset 2 < (7 & 31) -> +32
    0x80 | (1 << 5) | 2, 0x3b, 0x9a, 0xca, 0x05, 0xff, // hr invalid (0xFF)
  ];
  const header = [12, 0x10, 0x54, 0x08, records.length, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
  const body = Uint8Array.from([...header, ...records]);
  const crc = fitCrc(body);
  return Uint8Array.from([...body, crc & 0xff, crc >> 8]);
}

describe("parseFit", () => {
  it("decodes a hand-made file: endianness, compressed timestamps, invalid values", () => {
    const p = parseFit(handMadeFile());
    assert.deepEqual(p.issues, []);
    assert.equal(p.header.size, 12);
    assert.equal(p.header.crcStatus, "absent");
    assert.equal(p.fileCrc.status, "valid");
    const data = p.messages.filter((m) => m.kind === "data");
    assert.equal(data.length, 4);
    assert.equal(data[0]!.fields.get(0), 4);
    assert.equal(data[0]!.fields.get(4), 1_000_000_000);
    assert.equal(data[1]!.globalNum, MESG.record);
    assert.equal(data[1]!.definition.littleEndian, false);
    assert.equal(data[1]!.timestamp, 1_000_000_005);
    assert.equal(data[1]!.fields.get(3), 140);
    assert.equal(data[2]!.compressedTimestamp, true);
    assert.equal(data[2]!.timestamp, 1_000_000_007);
    assert.equal(data[3]!.timestamp, (1_000_000_007 & ~31) + 2 + 32);
    assert.equal(data[3]!.fields.get(3), null);
  });

  it("parses a generated activity with no issues", () => {
    const a = buildActivity({ records: 50, lapEvery: 20 });
    const p = parseFit(a.bytes);
    assert.deepEqual(p.issues, []);
    assert.equal(p.strategy, "declared");
    assert.equal(p.header.crcStatus, "valid");
    assert.equal(p.messages.filter((m) => m.kind === "data" && m.globalNum === MESG.record).length, 50);
  });

  it("accounts for developer fields in the data size", () => {
    const a = buildActivity({ records: 10, developerFields: true });
    const p = parseFit(a.bytes);
    assert.deepEqual(p.issues, []);
    const def = p.messages.find((m) => m.kind === "definition" && m.globalNum === MESG.record)!;
    assert.equal(def.definition.devFields.length, 1);
    assert.equal(def.definition.devFields[0]!.size, 2);
  });

  it("round-trips strings, arrays and signed values through FitBuilder", () => {
    const b = new FitBuilder();
    b.message(MESG.fileId, [
      { num: 0, baseType: BT.enum, value: 4 },
      { num: 8, baseType: BT.string, size: 10, value: "Edge" },
      { num: 9, baseType: BT.uint8, value: [1, 2, 3] },
      { num: 10, baseType: BT.sint16, value: -1234 },
      { num: 4, baseType: BT.uint32, value: T0 },
    ]);
    const p = parseFit(assembleFitFile(b.bytes()));
    const m = p.messages.find((x) => x.kind === "data")!;
    assert.equal(m.fields.get(8), "Edge");
    assert.deepEqual(m.fields.get(9), [1, 2, 3]);
    assert.equal(m.fields.get(10), -1234);
  });

  it("rejects data that is not FIT", () => {
    const junk = new TextEncoder().encode("this is definitely not a FIT file at all, just text");
    assert.throws(() => parseFit(junk), (e: unknown) => e instanceof FitParseError && e.code === "not_fit");
    assert.throws(() => parseFit(Uint8Array.from([14, 0x20])), (e: unknown) => e instanceof FitParseError && e.code === "too_short");
  });
});
