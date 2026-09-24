import { parse } from './parse.js';
import type { PlistValue } from './parse.js';

/**
 * Optional lossless layer for XML property lists.
 *
 * The semantic value is always computed by the production parser
 * (`parse`), so this module never carries a second, test-only copy of the
 * value semantics. On top of that value it records source-oriented metadata
 * (exact source spans, comments, processing instructions, whitespace, key
 * order and raw scalar spelling) and can emit frozen, file-system-free local
 * edit plans. Everything here is stateless: a failed call cannot leave
 * caches, counters or other shared state behind.
 */

export type LosslessErrorCode =
  | 'INVALID_INPUT'
  | 'UNEXPECTED_EOF'
  | 'MALFORMED_TAG'
  | 'MISMATCHED_TAG'
  | 'UNEXPECTED_TEXT'
  | 'UNEXPECTED_ELEMENT'
  | 'UNKNOWN_ELEMENT'
  | 'MISSING_ROOT'
  | 'NOT_A_DICT'
  | 'NOT_AN_ARRAY'
  | 'PATH_NOT_FOUND'
  | 'DIGEST_MISMATCH'
  | 'INVALID_EDIT_RANGE'
  | 'OVERLAPPING_EDITS';

/**
 * Error type for the lossless layer. It extends the ordinary `Error`, so it
 * stays inside the existing parse-time error layering: callers that already
 * catch `Error` keep working, and every instance carries a stable `code` and
 * a deterministic message that names the first violating offset.
 */
export class LosslessPlistError extends Error {
  readonly code: LosslessErrorCode;
  readonly offset: number;

  constructor(code: LosslessErrorCode, message: string, offset = -1) {
    super(message);
    this.name = 'LosslessPlistError';
    this.code = code;
    this.offset = offset;
  }
}

const PLIST_ELEMENTS: ReadonlySet<string> = new Set([
  'plist',
  'dict',
  'array',
  'key',
  'string',
  'integer',
  'real',
  'data',
  'date',
  'true',
  'false',
  'null',
]);

/** Half-open source interval. Offsets are UTF-16 code unit indices. */
export interface SourceSpan {
  start: number;
  end: number;
}

export interface LosslessTrivia {
  kind: 'text' | 'comment' | 'pi' | 'cdata' | 'doctype';
  span: SourceSpan;
  raw: string;
}

export type LosslessTriviaKind = LosslessTrivia['kind'];

export interface LosslessElementChild {
  kind: 'element';
  node: LosslessNode;
}

export type LosslessChild = LosslessElementChild | LosslessTrivia;

export interface LosslessNode {
  /** Element name, always one of the known plist tags. */
  name: string;
  /** Entire element: opening tag through closing tag. */
  span: SourceSpan;
  /** Just the opening (or self-closing) tag. */
  openTag: SourceSpan;
  /** Region strictly between the opening and closing tag. */
  inner: SourceSpan;
  selfClosing: boolean;
  children: LosslessChild[];
}

export interface LosslessPlistDocument {
  /** Original XML source. */
  source: string;
  /** Digest of `source`; edit plans bind to it. */
  digest: string;
  /** Semantic value produced by the production `parse()` path. */
  value: PlistValue;
  /** Trivia (PIs, comments, doctype, whitespace) before `<plist>`. */
  prolog: LosslessChild[];
  /** Trivia after `</plist>`. */
  epilog: LosslessChild[];
  /** The `<plist>` element. */
  root: LosslessNode;
}

export interface DictEntry {
  /** Zero-based position of the entry in document order. */
  index: number;
  /** Key text with XML entities decoded. */
  key: string;
  /** Raw key-content spelling as found in the source (entities untouched). */
  keyRaw: string;
  keyNode: LosslessNode;
  /** Value node, or `null` for a dangling trailing key (parser fills `""`). */
  valueNode: LosslessNode | null;
}

export interface EditPlanEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface EditPlan {
  /** Digest of the source the plan was created from. */
  readonly digest: string;
  readonly sourceLength: number;
  /** Always sorted by position; ranges never overlap. */
  readonly edits: readonly EditPlanEdit[];
}

function fail(
  code: LosslessErrorCode,
  message: string,
  source: string,
  offset: number,
): never {
  const from = Math.max(0, offset - 16);
  const to = Math.min(source.length, offset + 16);
  const excerpt = JSON.stringify(source.slice(from, to));
  throw new LosslessPlistError(
    code,
    `${message} (code=${code}, offset=${offset}, near=${excerpt})`,
    offset,
  );
}

function isWhitespace(text: string): boolean {
  return /^[\s\uFEFF]*$/.test(text);
}

function readName(
  source: string,
  pos: number,
): { name: string; next: number } | null {
  if (pos >= source.length || !/[A-Za-z_]/.test(source[pos])) {
    return null;
  }
  const start = pos;
  pos += 1;
  while (pos < source.length && /[A-Za-z0-9_.:-]/.test(source[pos])) {
    pos += 1;
  }
  return { name: source.slice(start, pos), next: pos };
}

interface ScanResult {
  prolog: LosslessChild[];
  epilog: LosslessChild[];
  root: LosslessNode;
}

/**
 * Strict structural scan of an XML plist document. It intentionally does not
 * decode entities or collapse whitespace: every byte is reachable through a
 * span. Semantic interpretation is left to `parse()`.
 */
function scanDocument(source: string): ScanResult {
  const length = source.length;
  const prolog: LosslessChild[] = [];
  const epilog: LosslessChild[] = [];
  const stack: LosslessNode[] = [];
  let root: LosslessNode | null = null;
  let pos = 0;

  const trivia = (
    kind: LosslessTrivia['kind'],
    start: number,
    end: number,
  ): void => {
    const item: LosslessTrivia = {
      kind,
      span: { start, end },
      raw: source.slice(start, end),
    };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(item);
    } else if (root === null) {
      prolog.push(item);
    } else {
      epilog.push(item);
    }
  };

  const textRun = (start: number, end: number): void => {
    const raw = source.slice(start, end);
    if (stack.length === 0 && !isWhitespace(raw)) {
      fail(
        'UNEXPECTED_TEXT',
        'non-whitespace text outside of the <plist> element',
        source,
        start,
      );
    }
    trivia('text', start, end);
  };

  while (pos < length) {
    const lt = source.indexOf('<', pos);
    if (lt === -1) {
      textRun(pos, length);
      pos = length;
      break;
    }
    if (lt > pos) {
      textRun(pos, lt);
      pos = lt;
    }

    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4);
      if (end === -1) {
        fail('UNEXPECTED_EOF', 'unterminated comment', source, pos);
      }
      trivia('comment', pos, end + 3);
      pos = end + 3;
      continue;
    }

    if (source.startsWith('<?', pos)) {
      const end = source.indexOf('?>', pos + 2);
      if (end === -1) {
        fail(
          'UNEXPECTED_EOF',
          'unterminated processing instruction',
          source,
          pos,
        );
      }
      trivia('pi', pos, end + 2);
      pos = end + 2;
      continue;
    }

    if (source.startsWith('<![CDATA[', pos)) {
      const end = source.indexOf(']]>', pos + 9);
      if (end === -1) {
        fail('UNEXPECTED_EOF', 'unterminated CDATA section', source, pos);
      }
      if (stack.length === 0) {
        fail(
          'UNEXPECTED_TEXT',
          'CDATA section outside of the <plist> element',
          source,
          pos,
        );
      }
      trivia('cdata', pos, end + 3);
      pos = end + 3;
      continue;
    }

    if (source.startsWith('<!', pos)) {
      let i = pos + 2;
      let depth = 0;
      while (i < length) {
        const ch = source[i];
        if (ch === '[') {
          depth += 1;
        } else if (ch === ']') {
          depth -= 1;
        } else if (ch === '>' && depth === 0) {
          break;
        }
        i += 1;
      }
      if (i >= length) {
        fail('UNEXPECTED_EOF', 'unterminated declaration', source, pos);
      }
      if (stack.length > 0 || root !== null) {
        fail(
          'UNEXPECTED_ELEMENT',
          'a <! declaration is only allowed before the <plist> element',
          source,
          pos,
        );
      }
      trivia('doctype', pos, i + 1);
      pos = i + 1;
      continue;
    }

    if (source.startsWith('</', pos)) {
      const read = readName(source, pos + 2);
      if (read === null) {
        fail('MALFORMED_TAG', 'missing name in closing tag', source, pos);
      }
      let i = read.next;
      while (i < length && /\s/.test(source[i])) {
        i += 1;
      }
      if (source[i] !== '>') {
        fail('MALFORMED_TAG', 'malformed closing tag', source, pos);
      }
      const current = stack[stack.length - 1];
      if (!current || current.name !== read.name) {
        const expected = current ? `<${current.name}>` : 'no open element';
        fail(
          'MISMATCHED_TAG',
          `closing tag </${read.name}> does not match ${expected}`,
          source,
          pos,
        );
      }
      current.inner.end = pos;
      current.span.end = i + 1;
      stack.pop();
      if (stack.length === 0) {
        root = current;
      }
      pos = i + 1;
      continue;
    }

    // Opening tag.
    const read = readName(source, pos + 1);
    if (read === null || source[pos + 1] === '/') {
      fail('MALFORMED_TAG', 'malformed opening tag', source, pos);
    }
    const name = read.name;
    if (!PLIST_ELEMENTS.has(name)) {
      fail(
        'UNKNOWN_ELEMENT',
        `unknown plist element <${name}>`,
        source,
        pos,
      );
    }
    let i = read.next;
    let selfClosing = false;
    for (;;) {
      while (i < length && /\s/.test(source[i])) {
        i += 1;
      }
      if (source.startsWith('/>', i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (source[i] === '>') {
        i += 1;
        break;
      }
      const attrName = readName(source, i);
      if (attrName === null) {
        fail('MALFORMED_TAG', `malformed attribute in <${name}>`, source, i);
      }
      i = attrName.next;
      while (i < length && /\s/.test(source[i])) {
        i += 1;
      }
      if (source[i] !== '=') {
        fail('MALFORMED_TAG', `attribute missing value in <${name}>`, source, i);
      }
      i += 1;
      while (i < length && /\s/.test(source[i])) {
        i += 1;
      }
      const quote = source[i];
      if (quote !== '"' && quote !== "'") {
        fail('MALFORMED_TAG', `attribute missing value in <${name}>`, source, i);
      }
      const close = source.indexOf(quote, i + 1);
      if (close === -1) {
        fail('UNEXPECTED_EOF', `unterminated attribute in <${name}>`, source, i);
      }
      i = close + 1;
    }

    const node: LosslessNode = {
      name,
      span: { start: pos, end: selfClosing ? i : pos },
      openTag: { start: pos, end: i },
      inner: { start: i, end: i },
      selfClosing,
      children: [],
    };

    if (stack.length === 0) {
      if (root !== null) {
        fail(
          'UNEXPECTED_ELEMENT',
          'a second root element appeared; <plist> is already closed',
          source,
          pos,
        );
      }
      if (name !== 'plist') {
        fail(
          'UNEXPECTED_ELEMENT',
          'the root element must be <plist>',
          source,
          pos,
        );
      }
    } else {
      stack[stack.length - 1].children.push({ kind: 'element', node });
    }

    if (selfClosing) {
      if (stack.length === 0) {
        root = node;
      }
    } else {
      stack.push(node);
    }
    pos = i;
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    fail(
      'UNEXPECTED_EOF',
      `unclosed element <${open.name}>`,
      source,
      open.span.start,
    );
  }
  if (root === null) {
    fail('MISSING_ROOT', 'the document has no <plist> element', source, 0);
  }
  return { prolog, epilog, root };
}

/**
 * Deterministic content digest (FNV-1a over UTF-8 bytes plus length
 * metadata). Depends only on the input string: no locale, timezone or other
 * machine-local configuration is consulted, so identical inputs always
 * produce identical digests on any host.
 */
export function digestSource(source: string): string {
  const bytes = new TextEncoder().encode(source);
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * prime) & mask;
  }
  return `fnv1a-64:${hash.toString(16).padStart(16, '0')}:utf8=${bytes.length}:utf16=${source.length}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Only freeze plain objects and arrays; Date/Uint8Array (semantic values)
    // and class instances keep their identity.
    if (Array.isArray(value) || proto === Object.prototype || proto === null) {
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
  }
  return value;
}

/**
 * Losslessly parse an XML plist string.
 *
 * Returns the semantic `value` (computed by the production `parse()`, so the
 * default contract is untouched) plus source metadata: spans for every
 * element, comments, processing instructions, whitespace runs, dict key
 * order (duplicates included) and raw scalar spellings.
 *
 * The result is deeply frozen; nothing in this module keeps mutable state.
 */
export function parseLossless(xml: string): LosslessPlistDocument {
  if (typeof xml !== 'string') {
    throw new LosslessPlistError(
      'INVALID_INPUT',
      `parseLossless expects an XML string, got ${typeof xml}`,
    );
  }
  const scanned = scanDocument(xml);
  // Semantic value comes from the exact production parse path.
  const value = parse(xml);
  const document: LosslessPlistDocument = {
    source: xml,
    digest: digestSource(xml),
    value,
    prolog: scanned.prolog,
    epilog: scanned.epilog,
    root: scanned.root,
  };
  return deepFreeze(document);
}

/** Raw source text covered by `span`. */
export function sliceSource(
  document: LosslessPlistDocument,
  span: SourceSpan,
): string {
  return document.source.slice(span.start, span.end);
}

/** Raw inner content of a node, exactly as written (entities untouched). */
export function innerText(
  document: LosslessPlistDocument,
  node: LosslessNode,
): string {
  return document.source.slice(node.inner.start, node.inner.end);
}

/** Element children of a node, in document order. */
export function elementChildren(node: LosslessNode): LosslessNode[] {
  const out: LosslessNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'element') {
      out.push(child.node);
    }
  }
  return out;
}

/**
 * Decode the XML entities that the regular parser decodes for semantic
 * values. Anything else (including unknown entities like `&bogus;`) is
 * returned verbatim: the lossless layer never normalizes it.
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, named: string | undefined, decimal: string | undefined, hex: string | undefined) => {
      if (named !== undefined) {
        switch (named) {
          case 'lt':
            return '<';
          case 'gt':
            return '>';
          case 'amp':
            return '&';
          case 'quot':
            return '"';
          case 'apos':
            return "'";
        }
      }
      const codePoint =
        decimal !== undefined ? Number(decimal) : parseInt(hex as string, 16);
      if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    },
  );
}

/**
 * Dict entries in document order. Duplicate keys are preserved as separate
 * entries; nothing is collapsed or normalized. Throws `NOT_A_DICT` when the
 * node is not a `<dict>`.
 */
export function dictEntries(
  document: LosslessPlistDocument,
  node: LosslessNode,
): DictEntry[] {
  if (node.name !== 'dict') {
    throw new LosslessPlistError(
      'NOT_A_DICT',
      `dictEntries() requires a <dict> node, got <${node.name}> (offset=${node.span.start})`,
      node.span.start,
    );
  }
  const elements = elementChildren(node);
  const entries: DictEntry[] = [];
  for (let i = 0; i < elements.length; i += 2) {
    const keyNode = elements[i];
    if (keyNode.name !== 'key') {
      throw new LosslessPlistError(
        'UNEXPECTED_ELEMENT',
        `expected <key> inside <dict>, found <${keyNode.name}> (offset=${keyNode.span.start})`,
        keyNode.span.start,
      );
    }
    const keyRaw = innerText(document, keyNode);
    entries.push({
      index: entries.length,
      key: decodeEntities(keyRaw),
      keyRaw,
      keyNode,
      valueNode: elements[i + 1] ?? null,
    });
  }
  return entries;
}

/**
 * Resolve a path of dict keys (strings) and array indices (numbers) to a
 * node. Dict keys match the entity-decoded key text; the first occurrence
 * wins (use {@link dictEntries} to address duplicates). Throws
 * `PATH_NOT_FOUND` naming the first segment that cannot be resolved.
 */
export function findNode(
  document: LosslessPlistDocument,
  path: ReadonlyArray<string | number>,
): LosslessNode {
  const roots = elementChildren(document.root);
  if (roots.length === 0) {
    throw new LosslessPlistError(
      'PATH_NOT_FOUND',
      'the <plist> element is empty; no root value exists',
      document.root.span.start,
    );
  }
  let node = roots[0];
  const walked: Array<string | number> = [];
  for (const segment of path) {
    walked.push(segment);
    if (typeof segment === 'number') {
      if (node.name !== 'array') {
        throw new LosslessPlistError(
          'NOT_AN_ARRAY',
          `path ${JSON.stringify(walked)} indexes into <${node.name}>, not <array> (offset=${node.span.start})`,
          node.span.start,
        );
      }
      const items = elementChildren(node);
      if (!Number.isInteger(segment) || segment < 0 || segment >= items.length) {
        throw new LosslessPlistError(
          'PATH_NOT_FOUND',
          `path ${JSON.stringify(walked)} is out of range: <array> has ${items.length} element(s) (offset=${node.span.start})`,
          node.span.start,
        );
      }
      node = items[segment];
    } else {
      if (node.name !== 'dict') {
        throw new LosslessPlistError(
          'NOT_A_DICT',
          `path ${JSON.stringify(walked)} looks up a key in <${node.name}>, not <dict> (offset=${node.span.start})`,
          node.span.start,
        );
      }
      const entries = dictEntries(document, node);
      const entry = entries.find((candidate) => candidate.key === segment);
      if (!entry || entry.valueNode === null) {
        const available = entries.map((candidate) => JSON.stringify(candidate.key)).join(', ');
        throw new LosslessPlistError(
          'PATH_NOT_FOUND',
          `path ${JSON.stringify(walked)} not found; available keys: [${available}] (offset=${node.span.start})`,
          node.span.start,
        );
      }
      node = entry.valueNode;
    }
  }
  return node;
}

/**
 * Create a frozen, self-contained edit plan for `document`. The plan is pure
 * data: it never touches the file system and carries the digest of the
 * original source so it can only be applied to the exact input it was
 * created from. Edits are validated, sorted by position (regardless of the
 * order they were passed in) and checked for overlaps.
 */
export function createEditPlan(
  document: LosslessPlistDocument,
  edits: ReadonlyArray<EditPlanEdit>,
): EditPlan {
  const sourceLength = document.source.length;
  const sorted = edits.map((edit) => ({ ...edit }));
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > sourceLength
    ) {
      throw new LosslessPlistError(
        'INVALID_EDIT_RANGE',
        `edit range [${edit.start}, ${edit.end}) is outside the source of length ${sourceLength}`,
        edit.start,
      );
    }
    if (typeof edit.replacement !== 'string') {
      throw new LosslessPlistError(
        'INVALID_INPUT',
        'edit replacement must be a string',
        edit.start,
      );
    }
  }
  // Deterministic order: position first, then replacement text as tie-breaker.
  sorted.sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.replacement < b.replacement ? -1 : a.replacement > b.replacement ? 1 : 0),
  );
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.start < previous.end) {
      throw new LosslessPlistError(
        'OVERLAPPING_EDITS',
        `edits overlap: [${previous.start}, ${previous.end}) vs [${current.start}, ${current.end})`,
        current.start,
      );
    }
  }
  return deepFreeze({
    digest: document.digest,
    sourceLength,
    edits: sorted,
  });
}

/**
 * Apply an edit plan to a source string and return the edited string.
 *
 * The digest of `source` must match the plan's digest; otherwise a
 * `DIGEST_MISMATCH` error is thrown before anything is computed, so a failed
 * application is atomic and leaves no partial result. Unmodified regions are
 * copied verbatim, byte for byte.
 */
export function applyEditPlan(plan: EditPlan, source: string): string {
  const actual = digestSource(source);
  if (actual !== plan.digest) {
    throw new LosslessPlistError(
      'DIGEST_MISMATCH',
      `edit plan digest mismatch: plan expects ${plan.digest} but the source digests to ${actual}`,
    );
  }
  if (source.length !== plan.sourceLength) {
    throw new LosslessPlistError(
      'DIGEST_MISMATCH',
      `edit plan source length mismatch: plan expects ${plan.sourceLength}, got ${source.length}`,
    );
  }
  // Re-validate plan structure so a hand-built plan cannot corrupt output.
  for (let i = 0; i < plan.edits.length; i++) {
    const edit = plan.edits[i];
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > source.length
    ) {
      throw new LosslessPlistError(
        'INVALID_EDIT_RANGE',
        `edit range [${edit.start}, ${edit.end}) is outside the source of length ${source.length}`,
        edit.start,
      );
    }
    if (i > 0 && edit.start < plan.edits[i - 1].end) {
      throw new LosslessPlistError(
        'OVERLAPPING_EDITS',
        `edits overlap: [${plan.edits[i - 1].start}, ${plan.edits[i - 1].end}) vs [${edit.start}, ${edit.end})`,
        edit.start,
      );
    }
  }
  let result = '';
  let cursor = 0;
  for (const edit of plan.edits) {
    result += source.slice(cursor, edit.start);
    result += edit.replacement;
    cursor = edit.end;
  }
  result += source.slice(cursor);
  return result;
}

/** Convenience: plan that replaces the whole span of `node`. */
export function planReplaceNode(
  document: LosslessPlistDocument,
  node: LosslessNode,
  replacement: string,
): EditPlan {
  return createEditPlan(document, [
    { start: node.span.start, end: node.span.end, replacement },
  ]);
}
