/**
 * Optional lossless view of an XML plist document.
 *
 *   const doc = parseLossless(xml);
 *
 *   doc.value          -> the same value `parse(xml)` returns
 *   doc.nodes          -> nodes with exact source ranges, trivia and
 *                         original scalar spelling
 *   planEdit(doc, …)   -> a serializable, write-free edit plan
 *   applyEditPlan(...) -> a pure function that splices replacements
 *                         into a copy of the source text
 *
 * Everything here is deterministic and per-call: there is no module
 * level cache, counter or registry, so concurrent interleavings and
 * retries after a failure are isolated by construction.
 */

import {
  convertPlistNode,
  dictEntryNodes,
  unwrapPlistRoot,
  type PlistValue,
  type XmlElementLike,
} from './xml-elements.js';
import { serializePlistFragment } from './xml-serialize.js';
import {
  scanXmlPlist,
  type CstDocument,
  type CstElement,
  type CstMisc,
  type EntityRef,
  type SourceRange,
} from './lossless-scanner.js';

export type { SourceRange, EntityRef } from './lossless-scanner.js';
export { PlistScanError } from './lossless-scanner.js';

export type TriviaKind = 'comment' | 'processing-instruction' | 'text';

/** Preserved trivia belonging to a node or the document prelude. */
export interface LosslessTrivia {
  readonly kind: TriviaKind;
  readonly raw: string;
  /** Resolved value (text is EOL normalized; others echo raw inner). */
  readonly value: string | null;
  readonly range: SourceRange;
}

export interface ScalarSegment {
  readonly kind: 'text' | 'cdata';
  readonly raw: string;
  readonly value: string;
  readonly range: SourceRange;
  readonly entities: readonly EntityRef[];
}

export interface DictMember {
  /** Occurrence index among same-named keys (0 based). */
  readonly keyOccurrence: number;
  readonly key: LosslessNode;
  readonly value: LosslessNode | null;
}

export interface LosslessNode {
  readonly tag: string;
  readonly range: SourceRange;
  /** Exact source slice of the whole element. */
  readonly raw: string;
  readonly openTag: SourceRange;
  readonly closeTag: SourceRange | null;
  readonly selfClosing: boolean;
  /** Element children in source order. */
  readonly children: readonly LosslessNode[];
  /** Significant dict members in source order (includes duplicate keys). */
  readonly members: readonly DictMember[] | null;
  /** Significant array items in source order. */
  readonly items: readonly LosslessNode[] | null;
  /** Trivia that precedes this element inside its parent/document. */
  readonly leadingTrivia: readonly LosslessTrivia[];
  /** Trivia found inside this element but outside child elements. */
  readonly innerTrivia: readonly LosslessTrivia[];
  /** Original scalar spelling (text + CDATA) for leaf tags. */
  readonly segments: readonly ScalarSegment[] | null;
  /** Entity references present anywhere in this element's scalar text. */
  readonly entities: readonly EntityRef[];
}

export interface LosslessMiscNode {
  readonly kind: TriviaKind;
  readonly raw: string;
  readonly value: string | null;
  readonly target?: string;
  readonly range: SourceRange;
}

export interface SourceSummary {
  readonly byteLength: number;
  /** cyrb53 hex digest of the UTF-16 code units. */
  readonly digest: string;
}

export interface LosslessPlist {
  /** The exact source text that was parsed. */
  readonly source: string;
  /** Semantic value, deep-equal to `parse(source)`. */
  readonly value: PlistValue;
  /** Root <plist> element metadata. */
  readonly root: LosslessNode;
  /** Document content before the root element. */
  readonly prelude: readonly LosslessMiscNode[];
  /** Document content after the root element. */
  readonly trailing: readonly LosslessMiscNode[];
  /** Cheap integrity summary used to detect stale edit plans. */
  readonly summary: SourceSummary;
}

/**
 * cyrb53 (public domain) computed over UTF-16 code units so the digest
 * matches `String` indexing (including emoji surrogate pairs).
 */
export function sourceDigest(source: string): string {
  let h1 = 0xdeadbeef ^ source.length;
  let h2 = 0x41c6ce57 ^ source.length;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).padStart(13, '0');
}

function summarize(source: string): SourceSummary {
  return { byteLength: source.length, digest: sourceDigest(source) };
}

function triviaFromMisc(nodes: readonly CstMisc[]): LosslessMiscNode[] {
  return nodes.map((node) => {
    if (node.nodeType === 8) {
      return {
        kind: 'comment' as const,
        raw: node.raw,
        value: node.nodeValue,
        range: node.range,
      };
    }
    if (node.nodeType === 7) {
      return {
        kind: 'processing-instruction' as const,
        raw: node.raw,
        value: node.nodeValue,
        target: node.nodeName,
        range: node.range,
      };
    }
    return {
      kind: 'text' as const,
      raw: node.raw,
      value: node.nodeValue,
      range: node.range,
    };
  });
}

function isTriviaType(nodeType: number): boolean {
  return nodeType === 3 || nodeType === 4 || nodeType === 7 || nodeType === 8;
}

function nodeTrivia(node: CstElement): LosslessTrivia[] {
  const out: LosslessTrivia[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 8) {
      out.push({
        kind: 'comment',
        raw: child.raw,
        value: child.nodeValue,
        range: child.range,
      });
    } else if (child.nodeType === 7) {
      out.push({
        kind: 'processing-instruction',
        raw: child.raw,
        value: child.nodeValue,
        range: child.range,
      });
    } else if (child.nodeType === 3 && /\S/.test(child.nodeValue as string)) {
      // Significant raw text inside a plist element is unusual and is
      // surfaced explicitly rather than being treated as whitespace.
      out.push({
        kind: 'text',
        raw: child.raw,
        value: child.nodeValue,
        range: child.range,
      });
    }
  }
  return out;
}

function scalarSegments(node: CstElement): ScalarSegment[] | null {
  if (
    node.nodeName !== 'string' &&
    node.nodeName !== 'data' &&
    node.nodeName !== 'integer' &&
    node.nodeName !== 'real' &&
    node.nodeName !== 'date' &&
    node.nodeName !== 'key'
  ) {
    return null;
  }
  const segments: ScalarSegment[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      segments.push({
        kind: child.nodeType === 4 ? 'cdata' : 'text',
        raw: child.raw,
        value: child.nodeValue as string,
        range: child.range,
        entities: child.entities,
      });
    }
  }
  return segments;
}

function collectEntities(node: CstElement): EntityRef[] {
  const out: EntityRef[] = [];
  const walk = (element: CstElement): void => {
    for (const child of element.childNodes) {
      if ('entities' in child && child.entities.length > 0) {
        out.push(...child.entities);
      }
      if (child.nodeType === 1) {
        walk(child as CstElement);
      }
    }
  };
  walk(node);
  return out;
}

interface ElementMap {
  el: CstElement;
  node: LosslessNode;
}

function buildLosslessNode(element: CstElement): LosslessNode {
  const children: LosslessNode[] = [];
  const elementMaps: ElementMap[] = [];
  let members: DictMember[] | null = null;
  let items: LosslessNode[] | null = null;

  let pendingLeading: LosslessTrivia[] = [];
  for (const child of element.childNodes) {
    if (child.nodeType === 8) {
      pendingLeading.push({
        kind: 'comment',
        raw: child.raw,
        value: child.nodeValue,
        range: child.range,
      });
      continue;
    }
    if (child.nodeType === 7) {
      pendingLeading.push({
        kind: 'processing-instruction',
        raw: child.raw,
        value: child.nodeValue,
        range: child.range,
      });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const childElement = child as CstElement;
    const childNode = buildLosslessNode(childElement);
    (childNode as { leadingTrivia: LosslessTrivia[] }).leadingTrivia =
      pendingLeading;
    pendingLeading = [];
    children.push(childNode);
    elementMaps.push({ el: childElement, node: childNode });
  }

  if (element.nodeName === 'dict') {
    members = [];
    const occurrence = new Map<string, number>();
    const entries = dictEntryNodes(element as unknown as XmlElementLike);
    for (const entry of entries) {
      const keyElement = entry.key as unknown as CstElement;
      const name = convertPlistNode(entry.key) as string;
      const index = occurrence.get(name) ?? 0;
      occurrence.set(name, index + 1);
      const keyNode = elementMaps.find((m) => m.el === keyElement)?.node;
      invariantNode(keyNode, 'dict key node missing from tree');
      let valueNode: LosslessNode | null = null;
      if (entry.value !== null) {
        const valueElement = entry.value as unknown as CstElement;
        valueNode = elementMaps.find((m) => m.el === valueElement)?.node ?? null;
        invariantNode(valueNode, 'dict value node missing from tree');
      }
      members.push({
        keyOccurrence: index,
        key: keyNode,
        value: valueNode,
      });
    }
  } else if (element.nodeName === 'array') {
    items = children;
  }

  const node: LosslessNode = {
    tag: element.nodeName,
    range: element.range,
    raw: element.raw,
    openTag: element.openTag,
    closeTag: element.closeTag,
    selfClosing: element.selfClosing,
    children,
    members,
    items,
    leadingTrivia: [],
    innerTrivia: nodeTrivia(element),
    segments: scalarSegments(element),
    entities: collectEntities(element),
  };
  return node;
}

function invariantNode(
  value: LosslessNode | null | undefined,
  message: string,
): asserts value is LosslessNode {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

/**
 * Parse an XML plist document and retain source metadata.
 */
export function parseLossless(source: string): LosslessPlist {
  if (typeof source !== 'string') {
    throw new TypeError(
      'parseLossless() only accepts XML plist strings; use parse() for binary input',
    );
  }
  const cst: CstDocument = scanXmlPlist(source);

  // Semantic conversion runs through the same shared function the
  // default DOM parser uses, including its tag validation and errors.
  const value = unwrapPlistRoot(cst.root as unknown as XmlElementLike);

  const root = buildLosslessNode(cst.root);
  const prelude = triviaFromMisc(cst.prelude);
  const trailing = triviaFromMisc(cst.trailing);

  const doc: LosslessPlist = {
    source,
    value,
    root,
    prelude,
    trailing,
    summary: summarize(source),
  };
  return Object.freeze(doc);
}

/* ------------------------------------------------------------------ */
/* Edit planning                                                       */
/* ------------------------------------------------------------------ */

/**
 * Error raised by the lossless layer (path resolution, stale plans,
 * invalid replacement spans). Scanner errors use `PlistScanError`;
 * structural plist errors reuse the plain Error messages produced by
 * the shared parser core, so the existing error layering is kept.
 */
export class LosslessPlistError extends Error {
  readonly code:
    | 'path-not-found'
    | 'ambiguous-key'
    | 'invalid-path'
    | 'summary-mismatch'
    | 'overlapping-edit'
    | 'stale-plan';
  readonly offset: number | null;
  readonly evidence: string | null;
  constructor(
    code: LosslessPlistError['code'],
    message: string,
    options: { offset?: number; evidence?: string } = {},
  ) {
    super(message);
    this.name = 'LosslessPlistError';
    this.code = code;
    this.offset = options.offset ?? null;
    this.evidence = options.evidence ?? null;
  }
}

export type PathStep =
  | string
  | number
  | { key: string; occurrence?: number }
  | { index: number };

export interface EditSpec {
  /**
   * Path from the document's single top level value into a dict or
   * array. For duplicate dict keys, pass `{ key, occurrence }`.
   */
  readonly path: readonly PathStep[];
  readonly value: PlistValue;
}

export interface PlannedReplacement {
  readonly range: SourceRange;
  readonly replacement: string;
  /** Original exact source slice being replaced. */
  readonly original: string;
  /** Path rendered for humans / failure reports. */
  readonly path: string;
}

export interface EditPlan {
  readonly summary: SourceSummary;
  readonly replacements: readonly PlannedReplacement[];
  /** Number of planned changes; zero is a valid no-op plan. */
  readonly editCount: number;
  /** Original source excerpt up front; plans never embed full source. */
  readonly sourceExcerpt: string;
}

function renderPath(path: readonly PathStep[]): string {
  return path
    .map((step) =>
      typeof step === 'string'
        ? '.' + step
        : typeof step === 'number'
          ? '[' + step + ']'
          : 'key' in step
            ? `.${step.key}#${step.occurrence ?? 0}`
            : `[${step.index}]`,
    )
    .join('');
}

function keyFromStep(step: PathStep): { name: string; occurrence: number } | null {
  if (typeof step === 'string') return { name: step, occurrence: 0 };
  if (typeof step === 'number') return null;
  if ('key' in step) return { name: step.key, occurrence: step.occurrence ?? 0 };
  return null;
}

function indexFromStep(step: PathStep): number | null {
  if (typeof step === 'number') return step;
  if (typeof step === 'object' && 'index' in step) return step.index;
  return null;
}

interface ResolvedTarget {
  node: LosslessNode;
  /** Parent context, used to surface duplicate-key diagnostics. */
  path: string;
}

function resolveTarget(
  doc: LosslessPlist,
  path: readonly PathStep[],
): ResolvedTarget {
  const rendered = renderPath(path);
  const rootValues = doc.root.children;
  if (rootValues.length === 0) {
    throw new LosslessPlistError(
      'path-not-found',
      `Edit target not found at ${rendered}: document has no top level value`,
    );
  }
  if (rootValues.length > 1) {
    throw new LosslessPlistError(
      'invalid-path',
      `Edit target not found at ${rendered}: plist has multiple top level values`,
    );
  }
  let current = rootValues[0];

  for (let depth = 0; depth < path.length; depth++) {
    const step = path[depth];
    const stepPath = renderPath(path.slice(0, depth + 1));
    const keyStep = keyFromStep(step);
    if (keyStep !== null) {
      if (current.tag !== 'dict' || current.members === null) {
        throw new LosslessPlistError(
          'invalid-path',
          `Edit target not found at ${stepPath}: node is a <${current.tag}> not a <dict>`,
          { offset: current.range.offset },
        );
      }
      const matches = current.members.filter(
        (member) => scalarKeyText(member.key) === keyStep.name,
      );
      if (matches.length === 0) {
        throw new LosslessPlistError(
          'path-not-found',
          `Edit target not found at ${stepPath}: key "${keyStep.name}" is absent`,
          { offset: current.range.offset },
        );
      }
      if (matches.length > 1 && typeof path[depth] === 'string') {
        throw new LosslessPlistError(
          'ambiguous-key',
          `Edit target at ${stepPath} is ambiguous: key "${keyStep.name}" occurs ${matches.length} times; specify { key, occurrence }`,
          { offset: current.range.offset },
        );
      }
      const member = matches[keyStep.occurrence];
      if (member === undefined) {
        throwNotFound(stepPath, keyStep.name, matches.length);
      }
      if (member.value === null) {
        throw new LosslessPlistError(
          'path-not-found',
          `Edit target not found at ${stepPath}: key "${keyStep.name}" has no value element`,
          { offset: member.key.range.offset },
        );
      }
      current = member.value;
      continue;
    }

    const index = indexFromStep(step);
    if (index !== null) {
      if (current.tag !== 'array' || current.items === null) {
        throw new LosslessPlistError(
          'invalid-path',
          `Edit target not found at ${stepPath}: node is a <${current.tag}> not an <array>`,
          { offset: current.range.offset },
        );
      }
      if (!Number.isInteger(index) || index < 0 || index >= current.items.length) {
        throw new LosslessPlistError(
          'path-not-found',
          `Edit target not found at ${stepPath}: array index ${index} out of range (length ${current.items.length})`,
          { offset: current.range.offset },
        );
      }
      current = current.items[index];
      continue;
    }

    throw new LosslessPlistError(
      'invalid-path',
      `Edit target not found at ${stepPath}: unsupported path step`,
    );
  }

  return { node: current, path: rendered };
}

function throwNotFound(
  path: string,
  name: string,
  count: number,
): never {
  throw new LosslessPlistError(
    'path-not-found',
    `Edit target not found at ${path}: occurrence of key "${name}" out of range (count ${count})`,
  );
}

function scalarKeyText(node: LosslessNode): string {
  if (node.segments === null) return '';
  return node.segments.map((segment) => segment.value).join('');
}

function sourceExcerpt(source: string, range: SourceRange): string {
  const radius = 40;
  const start = Math.max(0, range.offset - radius);
  const end = Math.min(source.length, range.endOffset + radius);
  return (
    (start > 0 ? '…' : '') +
    source
      .slice(start, end)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n') +
    (end < source.length ? '…' : '')
  );
}

/**
 * Produce a write-free, serializable edit plan. The plan carries a
 * digest of the original source and exact byte ranges; applying it is
 * a separate pure operation (`applyEditPlan`).
 */
export function planEdit(
  doc: LosslessPlist,
  edits: readonly EditSpec[],
): EditPlan {
  // Validate and compute every replacement before returning, so a
  // single bad edit aborts planning atomically with no partial state.
  const planned: PlannedReplacement[] = [];
  const seenRanges: Array<[number, number]> = [];

  for (const edit of edits) {
    if (!Array.isArray(edit.path)) {
      throw new LosslessPlistError(
        'invalid-path',
        'Edit spec requires an array path',
      );
    }
    const { node, path } = resolveTarget(doc, edit.path);
    const replacement = serializePlistFragment(edit.value);
    const original = doc.source.slice(node.range.offset, node.range.endOffset);

    for (const [offset, endOffset] of seenRanges) {
      if (
        node.range.offset < endOffset &&
        node.range.endOffset > offset
      ) {
        throw new LosslessPlistError(
          'overlapping-edit',
          `Overlapping edits at ${path}: range ${node.range.offset}-${node.range.endOffset} intersects ${offset}-${endOffset}`,
          { offset: node.range.offset },
        );
      }
    }
    seenRanges.push([node.range.offset, node.range.endOffset]);
    planned.push({
      range: { ...node.range },
      replacement,
      original,
      path,
    });
  }

  // Deterministic order independent of the caller's edit ordering.
  planned.sort((a, b) =>
    a.range.offset === b.range.offset
      ? a.range.endOffset - b.range.endOffset
      : a.range.offset - b.range.offset,
  );

  return Object.freeze({
    summary: doc.summary,
    replacements: Object.freeze(planned.map((item) => Object.freeze(item))),
    editCount: planned.length,
    sourceExcerpt:
      planned.length > 0
        ? sourceExcerpt(doc.source, planned[0].range)
        : sourceExcerpt(doc.source, {
            offset: 0,
            endOffset: Math.min(80, doc.source.length),
            line: 1,
            column: 1,
          }),
  });
}

/**
 * Apply a plan to source text purely (nothing is written anywhere).
 * Before splicing, the source summary is verified; every range is
 * re-checked against its recorded original. All checks happen before
 * any splicing, so failure leaves the caller's state untouched.
 */
export function applyEditPlan(plan: EditPlan, source: string): string {
  const candidate = summarize(source);
  if (
    candidate.byteLength !== plan.summary.byteLength ||
    candidate.digest !== plan.summary.digest
  ) {
    let evidence = `expected length ${plan.summary.byteLength}/digest ${plan.summary.digest}, got length ${candidate.byteLength}/digest ${candidate.digest}`;
    if (candidate.byteLength === plan.summary.byteLength) {
      evidence += ` near start: ${sourceExcerpt(source, { offset: 0, endOffset: Math.min(80, source.length), line: 1, column: 1 })}`;
    } else {
      const offset = Math.min(
        source.length,
        Math.max(0, plan.summary.byteLength - 1),
      );
      evidence += `; first boundary evidence at offset ${offset}: ${sourceExcerpt(source, { offset, endOffset: offset, line: 1, column: 1 })}`;
    }
    throw new LosslessPlistError(
      'summary-mismatch',
      'Refusing to apply edit plan: source summary mismatch',
      { offset: 0, evidence },
    );
  }

  // Validate every recorded original before mutating anything.
  for (const replacement of plan.replacements) {
    const actual = source.slice(
      replacement.range.offset,
      replacement.range.endOffset,
    );
    if (actual !== replacement.original) {
      let first = 0;
      while (
        first < actual.length &&
        first < replacement.original.length &&
        actual[first] === replacement.original[first]
      ) {
        first += 1;
      }
      throw new LosslessPlistError(
        'stale-plan',
        `Stale edit range at ${replacement.path}: first difference at offset ${replacement.range.offset + first} (${renderActualExpected(replacement.original, actual, first)})`,
        {
          offset: replacement.range.offset + first,
          evidence: sourceExcerpt(source, replacement.range),
        },
      );
    }
  }

  // Ranges are stored sorted and non-overlapping by planEdit.
  let out = '';
  let cursor = 0;
  for (const replacement of plan.replacements) {
    out += source.slice(cursor, replacement.range.offset);
    out += replacement.replacement;
    cursor = replacement.range.endOffset;
  }
  out += source.slice(cursor);
  return out;
}

function renderActualExpected(
  original: string,
  actual: string,
  first: number,
): string {
  const expectedChar =
    first < original.length ? JSON.stringify(original[first]) : '<eof>';
  const actualChar = first < actual.length ? JSON.stringify(actual[first]) : '<eof>';
  return `expected ${expectedChar}, got ${actualChar}`;
}
