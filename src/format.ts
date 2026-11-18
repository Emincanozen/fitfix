import { fitTimeToDate, FIT_MIN_ABSOLUTE_TIME } from "./profile.js";
import { hex4 } from "./reader.js";
import type { InspectReport, RepairResult } from "./repair.js";

const SPORTS: Record<number, string> = {
  0: "generic",
  1: "running",
  2: "cycling",
  3: "transition",
  4: "fitness_equipment",
  5: "swimming",
  10: "training",
  11: "walking",
  12: "cross_country_skiing",
  13: "alpine_skiing",
  15: "rowing",
  17: "hiking",
  19: "paddling",
};

const n = (x: number) => x.toLocaleString("en-US");

function duration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

function time(t: number): string {
  if (t < FIT_MIN_ABSOLUTE_TIME) return `+${t}s (relative)`;
  return fitTimeToDate(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function crcText(r: InspectReport): string {
  switch (r.header.crcStatus) {
    case "valid":
      return "header CRC valid";
    case "zero":
      return "header CRC not set (allowed)";
    case "absent":
      return "no header CRC (12-byte header)";
    case "invalid":
      return `header CRC INVALID (0x${hex4(r.header.storedCrc ?? 0)})`;
  }
}

/** Human-readable diagnostic for `fitfix inspect`. */
export function formatReport(r: InspectReport, name: string): string {
  const lines: string[] = [];
  const h = r.header;
  lines.push(`${name} (${n(r.fileSize)} bytes)`, "");
  lines.push(
    `Header     ${h.size} bytes${h.storedSize !== h.size ? ` (size byte says ${h.storedSize})` : ""}, protocol ${h.protocolVersion >> 4}.${h.protocolVersion & 0xf}, profile ${(h.profileVersion / 100).toFixed(2)}, signature ${h.signatureValid ? "OK" : "DAMAGED"}, ${crcText(r)}`,
  );
  lines.push(`Data       declared ${n(h.declaredDataSize)} bytes, readable ${n(r.dataEnd - r.dataStart)} bytes`);
  const crc =
    r.fileCrc.status === "valid"
      ? `valid (0x${hex4(r.fileCrc.computed)})`
      : r.fileCrc.status === "missing"
        ? "MISSING"
        : `INVALID (stored 0x${hex4(r.fileCrc.stored ?? 0)}, computed 0x${hex4(r.fileCrc.computed)})`;
  lines.push(`File CRC   ${crc}`);
  const s = r.stats;
  lines.push(`Messages   ${n(s.dataMessageCount)} data, ${n(s.definitionCount)} definitions${s.hasDeveloperFields ? ", developer fields present" : ""}`);
  const counts = Object.entries(s.messageCounts).sort((a, b) => b[1] - a[1]);
  if (counts.length > 0) lines.push(`           ${counts.map(([k, v]) => `${k} ${n(v)}`).join(", ")}`);
  if (s.firstTimestamp !== null && s.lastTimestamp !== null) {
    const parts = [`${time(s.firstTimestamp)} -> ${time(s.lastTimestamp)}`, duration(s.lastTimestamp - s.firstTimestamp)];
    if (s.distanceMeters !== null) parts.push(`${(s.distanceMeters / 1000).toFixed(2)} km`);
    if (s.sport !== null) parts.push(SPORTS[s.sport] ?? `sport ${s.sport}`);
    lines.push(`Activity   ${parts.join(", ")}`);
  }
  lines.push(`Summary    ${s.laps} lap(s), ${s.sessions} session(s), ${s.activities} activity message(s)`);
  lines.push("");
  if (r.issues.length === 0) {
    lines.push("No problems found.");
  } else {
    lines.push(`Findings (${r.issues.length})`);
    for (const i of r.issues) {
      lines.push(`  ${i.severity.toUpperCase().padEnd(7)} ${i.code}: ${i.message}`);
    }
  }
  if (r.plannedMessages.length > 0) {
    lines.push("", "A repair would add:");
    for (const p of r.plannedMessages) lines.push(`  + ${p.name} (${p.reason})`);
  }
  if (r.skippedBytes > 0) {
    lines.push("", `Warning: ${n(r.skippedBytes)} unreadable byte(s) would be removed; resynchronization is heuristic, check the repaired activity.`);
  }
  if (r.chainedMembers.length > 0) {
    lines.push("", `This is a chain of ${r.chainedMembers.length + 1} FIT files; the report above is member 1.`);
    r.chainedMembers.forEach((m, i) => {
      lines.push("", `--- member ${i + 2} ---`, formatReport({ ...m, chainedMembers: [] }, `${name} [member ${i + 2}]`).split("\nVerdict:")[0]!.trimEnd());
    });
  }
  lines.push("", r.healthy ? "Verdict: no structural damage found." : `Verdict: damaged. Try: fitfix repair "${name}" -o fixed.fit`);
  return lines.join("\n");
}

/** Human-readable summary for `fitfix repair`. */
export function formatRepair(res: RepairResult, input: string, output: string | null, dryRun: boolean): string {
  const lines: string[] = [];
  if (!res.changed) {
    lines.push(`${input}: no repair needed${res.before.healthy ? "" : " (remaining findings cannot be fixed by rewriting)"}.`);
    if (!dryRun && output) lines.push(`Wrote an identical copy to ${output}.`);
    return lines.join("\n");
  }
  lines.push(`${dryRun ? "Dry run: would repair" : "Repaired"} ${input}`);
  for (const a of res.actions) lines.push(`  - ${a}`);
  lines.push(`Size: ${n(res.before.fileSize)} -> ${n(res.output.length)} bytes`);
  const remaining = res.after.issues.filter((i) => i.severity !== "info");
  if (res.after.healthy) lines.push("Verification: the output re-parses cleanly (valid header, data size and CRCs).");
  else lines.push("Verification: the output still has errors:");
  for (const i of remaining) lines.push(`  ${i.severity.toUpperCase().padEnd(7)} ${i.code}: ${i.message}`);
  if (dryRun) lines.push("Nothing was written (--dry-run).");
  else if (output) lines.push(`Wrote ${output}. The original file was not modified.`);
  return lines.join("\n");
}
