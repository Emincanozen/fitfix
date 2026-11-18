export { fitCrc } from "./crc.js";
export {
  parseFit,
  FitParseError,
  type ParseResult,
  type FitMessage,
  type FitValue,
  type Definition,
  type FieldDef,
  type DevFieldDef,
  type HeaderInfo,
  type FileCrcInfo,
  type Issue,
  type Severity,
} from "./reader.js";
export { analyze, type Analysis, type ActivityStats, type SynthesizedMessage } from "./analyze.js";
export { inspect, repair, type InspectReport, type RepairOptions, type RepairResult } from "./repair.js";
export { FitBuilder, assembleFitFile, type FieldSpec, type DevFieldSpec, type MessageOptions, type HeaderOptions, type WritableValue } from "./writer.js";
export { BASE_TYPES, BT, MESG, FIELD, RECORD_FIELD, EVENT, EVENT_TYPE, FIT_EPOCH_OFFSET, fitTimeToDate, messageName } from "./profile.js";
export { formatReport, formatRepair } from "./format.js";
