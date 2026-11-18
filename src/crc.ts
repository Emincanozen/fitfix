/**
 * FIT CRC-16 (the algorithm published in the FIT protocol description).
 * It is mathematically identical to CRC-16/ARC: reflected polynomial 0x8005,
 * initial value 0, no final XOR. The nibble table below is the canonical one.
 */
const CRC_TABLE: readonly number[] = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

function step(crc: number, byte: number): number {
  let tmp = CRC_TABLE[crc & 0xf]!;
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
  tmp = CRC_TABLE[crc & 0xf]!;
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
  return crc;
}

/** Compute the FIT CRC of `bytes[start, end)`, optionally continuing from `crc`. */
export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length, crc = 0): number {
  for (let i = start; i < end; i++) crc = step(crc, bytes[i]!);
  return crc;
}
