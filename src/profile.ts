/**
 * The small subset of the FIT profile that fitfix needs. Field numbers and
 * base types follow the public FIT protocol description; fitfix does not ship
 * or depend on the Garmin SDK.
 */

export interface BaseTypeInfo {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly kind: "uint" | "sint" | "float" | "string" | "byte";
  /** Invalid ("no value") marker as an unsigned bit pattern. */
  readonly invalid: bigint;
}

const bt = (
  id: number,
  name: string,
  size: number,
  kind: BaseTypeInfo["kind"],
  invalid: bigint,
): BaseTypeInfo => ({ id, name, size, kind, invalid });

export const BASE_TYPES: ReadonlyMap<number, BaseTypeInfo> = new Map(
  [
    bt(0x00, "enum", 1, "uint", 0xffn),
    bt(0x01, "sint8", 1, "sint", 0x7fn),
    bt(0x02, "uint8", 1, "uint", 0xffn),
    bt(0x83, "sint16", 2, "sint", 0x7fffn),
    bt(0x84, "uint16", 2, "uint", 0xffffn),
    bt(0x85, "sint32", 4, "sint", 0x7fffffffn),
    bt(0x86, "uint32", 4, "uint", 0xffffffffn),
    bt(0x07, "string", 1, "string", 0x00n),
    bt(0x88, "float32", 4, "float", 0xffffffffn),
    bt(0x89, "float64", 8, "float", 0xffffffffffffffffn),
    bt(0x0a, "uint8z", 1, "uint", 0x00n),
    bt(0x8b, "uint16z", 2, "uint", 0x0000n),
    bt(0x8c, "uint32z", 4, "uint", 0x00000000n),
    bt(0x0d, "byte", 1, "byte", 0xffn),
    bt(0x8e, "sint64", 8, "sint", 0x7fffffffffffffffn),
    bt(0x8f, "uint64", 8, "uint", 0xffffffffffffffffn),
    bt(0x90, "uint64z", 8, "uint", 0x0000000000000000n),
  ].map((t) => [t.id, t]),
);

export const BT = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  string: 0x07,
  uint8z: 0x0a,
  uint16z: 0x8b,
  uint32z: 0x8c,
} as const;

/** Global message numbers used by fitfix. */
export const MESG = {
  fileId: 0,
  deviceSettings: 2,
  userProfile: 3,
  sport: 12,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  deviceInfo: 23,
  activity: 34,
  fileCreator: 49,
  hrv: 78,
  developerDataId: 207,
  fieldDescription: 206,
} as const;

const MESG_NAMES: ReadonlyMap<number, string> = new Map([
  [0, "file_id"],
  [1, "capabilities"],
  [2, "device_settings"],
  [3, "user_profile"],
  [7, "zones_target"],
  [12, "sport"],
  [13, "hr_zone"],
  [18, "session"],
  [19, "lap"],
  [20, "record"],
  [21, "event"],
  [22, "source"],
  [23, "device_info"],
  [26, "workout"],
  [27, "workout_step"],
  [34, "activity"],
  [49, "file_creator"],
  [55, "monitoring"],
  [72, "training_file"],
  [78, "hrv"],
  [101, "length"],
  [104, "device_aux_battery_info"],
  [113, "segment_lap"],
  [140, "unknown_140"],
  [141, "gps_metadata"],
  [206, "field_description"],
  [207, "developer_data_id"],
  [216, "time_in_zone"],
  [285, "jump"],
  [313, "split"],
  [314, "split_summary"],
]);

export function messageName(globalNum: number): string {
  return MESG_NAMES.get(globalNum) ?? `mesg_${globalNum}`;
}

/** Common field numbers. */
export const FIELD = {
  timestamp: 253,
  messageIndex: 254,
} as const;

export const RECORD_FIELD = {
  positionLat: 0,
  positionLong: 1,
  altitude: 2,
  heartRate: 3,
  cadence: 4,
  distance: 5,
  speed: 6,
  power: 7,
  enhancedSpeed: 73,
  enhancedAltitude: 78,
} as const;

export const EVENT = { timer: 0, session: 8, lap: 9, activity: 26 } as const;
export const EVENT_TYPE = { start: 0, stop: 1, stopAll: 4 } as const;
export const FILE_TYPE_ACTIVITY = 4;
export const MANUFACTURER_DEVELOPMENT = 255;

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
export const FIT_EPOCH_OFFSET = 631065600;

export function fitTimeToDate(t: number): Date {
  return new Date((t + FIT_EPOCH_OFFSET) * 1000);
}

/** FIT timestamps below 0x10000000 are relative (device uptime), not absolute dates. */
export const FIT_MIN_ABSOLUTE_TIME = 0x10000000;
