import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { buildActivity, mutate } from "./helpers.js";

function capture(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

let dir = "";
let healthy = "";
let broken = "";
let brokenBytes: Uint8Array;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fitfix-test-"));
  healthy = join(dir, "healthy.fit");
  broken = join(dir, "broken.fit");
  writeFileSync(healthy, buildActivity({ records: 30 }).bytes);
  brokenBytes = mutate(buildActivity({ records: 30, summary: false }).bytes, (x) => (x[12] = x[12]! ^ 0xaa));
  writeFileSync(broken, brokenBytes);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("fitfix inspect", () => {
  it("exits 0 for a healthy file", () => {
    const r = capture(["inspect", healthy]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No problems found/);
  });

  it("exits 1 and lists problems for a damaged file", () => {
    const r = capture(["inspect", broken]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /header_crc_invalid/);
    assert.match(r.stdout, /missing_session/);
  });

  it("emits valid JSON with --json", () => {
    const r = capture(["inspect", broken, "--json"]);
    const j = JSON.parse(r.stdout) as { healthy: boolean; issues: { code: string }[]; stats: { records: number } };
    assert.equal(j.healthy, false);
    assert.equal(j.stats.records, 30);
    assert.ok(j.issues.some((i) => i.code === "missing_activity"));
  });

  it("exits 2 for a file that is not FIT, or missing", () => {
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "hello, this is plain text and not a FIT activity file");
    assert.equal(capture(["inspect", txt]).code, 2);
    assert.equal(capture(["inspect", join(dir, "nope.fit")]).code, 2);
  });
});

describe("fitfix repair", () => {
  it("writes a verified repaired copy and leaves the input untouched", () => {
    const out = join(dir, "out1.fit");
    const r = capture(["repair", broken, "-o", out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /re-parses cleanly/);
    assert.deepEqual(new Uint8Array(readFileSync(broken)), brokenBytes);
    assert.equal(capture(["inspect", out]).code, 0);
  });

  it("does not write anything with --dry-run", () => {
    const out = join(dir, "dry.fit");
    const r = capture(["repair", broken, "-o", out, "--dry-run"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Nothing was written/);
    assert.equal(existsSync(out), false);
  });

  it("refuses to overwrite the input file", () => {
    const r = capture(["repair", broken, "-o", broken]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing/);
    assert.deepEqual(new Uint8Array(readFileSync(broken)), brokenBytes);
  });

  it("refuses to overwrite an existing output unless --force", () => {
    const out = join(dir, "exists.fit");
    writeFileSync(out, "keep me");
    assert.equal(capture(["repair", broken, "-o", out]).code, 2);
    assert.equal(readFileSync(out, "utf8"), "keep me");
    assert.equal(capture(["repair", broken, "-o", out, "--force"]).code, 0);
    assert.notEqual(readFileSync(out, "utf8"), "keep me");
  });

  it("uses <name>-fixed.fit as the default output", () => {
    const r = capture(["repair", broken]);
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(dir, "broken-fixed.fit")), true);
  });

  it("reports JSON for repair", () => {
    const r = capture(["repair", broken, "--dry-run", "--json"]);
    const j = JSON.parse(r.stdout) as { changed: boolean; verified: boolean; actions: string[]; output: null };
    assert.equal(j.changed, true);
    assert.equal(j.verified, true);
    assert.equal(j.output, null);
    assert.ok(j.actions.some((a) => a.includes("session")));
  });

  it("rejects unknown options and commands", () => {
    assert.equal(capture(["repair", broken, "--frobnicate"]).code, 2);
    assert.equal(capture(["explode", broken]).code, 2);
    assert.equal(capture(["--help"]).code, 0);
  });
});

describe("compiled binary", () => {
  it("runs as a script", () => {
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const r = spawnSync(process.execPath, [cli, "inspect", healthy, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { healthy: boolean }).healthy, true);
    const v = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

describe("review: output identity checks", () => {
  const freshInput = (name: string) => {
    const p = join(dir, name);
    writeFileSync(p, brokenBytes);
    return p;
  };

  it("refuses --force onto a hard link to the input", () => {
    const input = freshInput("hl-input.fit");
    const link = join(dir, "hardlink.fit");
    linkSync(input, link);
    const r = capture(["repair", input, "-o", link, "--force"]);
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stderr, /same file/);
    assert.deepEqual(new Uint8Array(readFileSync(input)), brokenBytes);
  });

  it("refuses --force onto a symbolic link to the input", (t) => {
    const input = freshInput("sl-input.fit");
    const link = join(dir, "symlink.fit");
    try {
      symlinkSync(input, link, "file");
    } catch (e) {
      t.skip(`symlinks unavailable here (${(e as NodeJS.ErrnoException).code ?? "unknown"})`);
      return;
    }
    const r = capture(["repair", input, "-o", link, "--force"]);
    assert.equal(r.code, 2, r.stdout);
    assert.deepEqual(new Uint8Array(readFileSync(input)), brokenBytes);
  });
});
