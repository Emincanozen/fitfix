// Generates a synthetic, truncated activity file for trying fitfix out.
// It is NOT a real device recording: it is built by the test helpers
// (1,800 one-second records, 2 closed laps, no final lap / session / activity,
// file cut in the middle of a message).
//
// Usage (after `npm test`, which compiles the helpers):
//   node scripts/make-demo-fit.mjs [output.fit]
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const helpers = resolve(import.meta.dirname, "..", ".test-build", "test", "helpers.js");
if (!existsSync(helpers)) {
  console.error("Run `npm test` first: it compiles the fixture helpers this script uses.");
  process.exit(2);
}
const { buildActivity } = await import(pathToFileURL(helpers).href);

const out = resolve(process.argv[2] ?? "demo-broken.fit");
const full = buildActivity({ records: 1800, lapEvery: 600, summary: false }).bytes;
const cut = full.subarray(0, full.length - 2 - 7); // drop the CRC and 7 bytes of the last message
writeFileSync(out, cut);
console.log(`wrote ${out} (${cut.length} bytes)`);
