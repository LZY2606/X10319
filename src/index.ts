export { parse } from './parse.js';
export { parseOpenStep } from './parse-openstep.js';
export type { PlistValue } from './parse.js';
export { parseBinary } from './parse-binary.js';
export { build } from './build.js';
export { buildBinary } from './build-binary.js';
export {
  LosslessPlistError,
  parseLossless,
  digestSource,
  decodeEntities,
  sliceSource,
  innerText,
  elementChildren,
  dictEntries,
  findNode,
  createEditPlan,
  applyEditPlan,
  planReplaceNode,
} from './lossless.js';
export type {
  LosslessErrorCode,
  SourceSpan,
  LosslessTrivia,
  LosslessTriviaKind,
  LosslessChild,
  LosslessNode,
  LosslessPlistDocument,
  DictEntry,
  EditPlan,
  EditPlanEdit,
} from './lossless.js';
