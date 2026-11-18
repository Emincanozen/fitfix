import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MESG } from "../src/profile.js";
import { FitParseError, parseFit } from "../src/reader.js";
import { repair } from "../src/repair.js";
import { buildActivity } from "./helpers.js";

/** Small deterministic PRNG (mulberry32) so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("randomized corruption", () => {
  const base = buildActivity({ records: 150, lapEvery: 50 }).bytes;

  it("never crashes and always produces a structurally valid file", () => {
    const rand = prng(12345);
    let repaired = 0;
    for (let iter = 0; iter < 300; iter++) {
      let b = base.slice();
      const kind = iter % 4;
      if (kind === 0) {
        // Flip a few random bytes anywhere.
        for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
          const p = Math.floor(rand() * b.length);
          b[p] = Math.floor(rand() * 256);
        }
      } else if (kind === 1) {
        // Truncate at a random point.
        b = b.slice(0, 20 + Math.floor(rand() * (b.length - 20)));
      } else if (kind === 2) {
        // Zero a random block (flash page lost).
        const p = 14 + Math.floor(rand() * (b.length - 40));
        b.fill(0, p, p + 1 + Math.floor(rand() * 64));
      } else {
        // Truncate and damage the header.
        b = b.slice(0, 20 + Math.floor(rand() * (b.length - 20)));
        b[4] = Math.floor(rand() * 256);
        b[12] = Math.floor(rand() * 256);
      }
      let res;
      try {
        res = repair(b);
      } catch (e) {
        assert.ok(e instanceof FitParseError, `iteration ${iter}: unexpected ${String(e)}`);
        continue;
      }
      const p = parseFit(res.output);
      assert.equal(p.fileCrc.status, "valid", `iteration ${iter}`);
      assert.equal(p.strategy, "declared", `iteration ${iter}`);
      assert.equal(p.trailingBytes, 0, `iteration ${iter}`);
      repaired++;
    }
    assert.ok(repaired > 250, `only ${repaired} inputs were repairable`);
  });

  it("handles a long activity quickly", () => {
    const big = buildActivity({ records: 36_000, lapEvery: 1000, summary: false });
    const cut = big.bytes.slice(0, big.bytes.length - 11);
    const t = performance.now();
    const res = repair(cut);
    const ms = performance.now() - t;
    assert.equal(res.after.healthy, true);
    assert.equal(parseFit(res.output).messages.filter((m) => m.kind === "data" && m.globalNum === MESG.record).length, 35_999);
    assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
  });
});
