export { parse } from './parse.browser.js';
export { parseOpenStep } from './parse-openstep.js';
export type { PlistValue } from './parse.browser.js';
export { parseBinary } from './parse-binary.js';
export { build } from './build.browser.js';
export { buildBinary } from './build-binary.js';
export {
  parseLossless,
  planEdits,
  applyEditPlan,
  locateNode,
  locateEntry,
  elementValue,
  elementText,
  serializeValue,
  DigestMismatchError,
} from './lossless.js';
export type {
  LosslessPlist,
  LosslessNode,
  LElement,
  LDictEntry,
  SourceRange,
  LosslessDiagnostic,
  EditPlan,
  EditOperation,
  EditValue,
  PlannedReplacement,
} from './lossless.js';
