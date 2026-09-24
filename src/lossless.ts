/**
 * Lossless XML plist parser and format-preserving edit plans.
 *
 * Unlike the default {@link parse} entry point, the lossless parser keeps the
 * original document: source ranges of every node, comments, processing
 * instructions, inter-element whitespace, key order (including duplicate
 * keys) and the original scalar spelling (entities, leading zeros, base64
 * line breaks, ...).
 *
 * Semantic values are produced by the exact same walker used by the default
 * parser (`xml-semantics.ts`), driven through a small DOM-shaped adapter over
 * the token tree, so the two entry points can never drift.
 */

import {
  base64ToUint8Array,
  parsePlistXML,
  type PlistValue,
  type SemanticNode,
} from './xml-semantics.js';

/**
 * Source range. Offsets are UTF-16 code unit indices into the exact string
 * passed to {@link parseLossless}; `[startOffset, endOffset)` is a half-open
 * interval that round-trips through `String.prototype.slice`. Line and
 * column are 1-based; column counts UTF-16 code units.
 */
export interface SourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
}

export interface LosslessDiagnostic {
  /** Stable machine code, e.g. `duplicateKey` / `unknownEntity`. */
  code: 'duplicateKey' | 'unknownEntity';
  message: string;
  /** Index (UTF-16 code units) of the first offending construct. */
  index: number;
  line: number;
  column: number;
}

export interface LosslessNodeBase {
  /** Full source span of the node, including its markup. */
  range: SourceRange;
}

/** Raw character data / ignorable whitespace between elements. */
export interface LText extends LosslessNodeBase {
  kind: 'text';
  /** Raw, un-decoded text as it appears in the source (EOLs preserved). */
  raw: string;
}

export interface LComment extends LosslessNodeBase {
  kind: 'comment';
  /** Comment body, excluding the `<!--` / `-->` delimiters. */
  data: string;
  raw: string;
}

export interface LProcessingInstruction extends LosslessNodeBase {
  kind: 'pi';
  target: string;
  data: string;
  raw: string;
}

export interface LCDATA extends LosslessNodeBase {
  kind: 'cdata';
  raw: string;
}

export interface LDTD extends LosslessNodeBase {
  kind: 'dtd';
  raw: string;
}

export interface LDeclaration extends LosslessNodeBase {
  kind: 'declaration';
  raw: string;
}

export interface LAttribute {
  name: string;
  value: string;
  raw: string;
  range: SourceRange;
}

export interface LEntityRef {
  kind: 'entity';
  /** Exact reference spelling, e.g. `&amp;` or `&#65;`. */
  raw: string;
  /** Decoded character when the reference is a known XML entity. */
  resolved: string | null;
  index: number;
}

/** One key/value pair in a dict, in source order, duplicates retained. */
export interface LDictEntry {
  key: LElement;
  value: LElement | null;
}

export interface LElement extends LosslessNodeBase {
  kind: 'element';
  tag: string;
  selfClosing: boolean;
  attributes: LAttribute[];
  /** All child tokens, including comments, PIs, CDATA and whitespace. */
  children: LosslessNode[];
  /**
   * Inner source span (between the open and close tags). `null` for
   * self-closing elements.
   */
  innerRange: SourceRange | null;
  /** Range of just the open tag (or the whole node when self-closing). */
  openTagRange: SourceRange;
  closeTagRange: SourceRange | null;
  /** Concatenated raw markup/text inside the element. */
  rawInner: string;
  /** Entity references found in the raw character data, source ordered. */
  entityRefs: LEntityRef[];
  /** Dict pairing, populated for `<dict>` elements, source ordered. */
  entries: LDictEntry[] | null;
}

export type LosslessNode =
  | LElement
  | LText
  | LComment
  | LProcessingInstruction
  | LCDATA
  | LDTD
  | LDeclaration;

export interface LosslessPlist {
  /** Document tokens in source order (declaration, DTD, comments, root...). */
  tokens: LosslessNode[];
  /** The `<plist>` root element. */
  root: LElement;
  /**
   * Decoded semantic value, identical to what the default {@link parse}
   * returns for the same input (the shared walker computes both).
   */
  value: PlistValue;
  /**
   * Non-fatal findings in source order. Duplicate keys and unknown entities
   * are reported here: they are represented losslessly, never silently
   * normalized.
   */
  diagnostics: LosslessDiagnostic[];
  source: string;
  /** Opaque digest of `source`, carried by every edit plan. */
  digest: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const NODE_TEXT = 3;
const NODE_CDATA = 4;
const NODE_COMMENT = 8;
const NODE_PI = 7;

class LosslessParseError extends Error {
  index: number;
  line: number;
  column: number;
  snippet: string;
  constructor(
    message: string,
    loc: { index: number; line: number; column: number },
    source: string,
  ) {
    super(message);
    this.name = 'Error';
    this.index = loc.index;
    this.line = loc.line;
    this.column = loc.column;
    this.snippet = makeSnippet(source, loc.index);
  }
}

/** Up to 20 characters of context on each side of `index`. */
function makeSnippet(source: string, index: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(source.length, index + 20);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return prefix + source.slice(start, end).replace(/\s+/g, ' ') + suffix;
}

/** FNV-1a (32 bit) over UTF-8 bytes, prefixed with the byte length. */
function fnv1aUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return bytes.length.toString(16) + '-' + hash.toString(16).padStart(8, '0');
}

/**
 * Normalize line endings the way the XML specification requires for parsed
 * character data: CRLF and CR both become LF. Raw spelling is kept separately.
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

class Tokenizer {
  private pos = 0;
  private readonly lineStarts: number[] = [0];

  constructor(
    private readonly src: string,
    private readonly diagnostics: LosslessDiagnostic[],
  ) {
    for (let i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  locationAt(offset: number): { index: number; line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { index: offset, line: lo + 1, column: offset - this.lineStarts[lo] + 1 };
  }

  fail(message: string, at: number = this.pos): never {
    throw new LosslessParseError(message, this.locationAt(at), this.src);
  }

  scanDocument(): LosslessNode[] {
    const tokens: LosslessNode[] = [];
    while (this.pos < this.src.length) {
      if (this.src.startsWith('<!--', this.pos)) {
        tokens.push(this.scanComment());
      } else if (this.src.startsWith('<!', this.pos)) {
        tokens.push(this.scanDtd());
      } else if (this.src.startsWith('<?', this.pos)) {
        tokens.push(this.scanPI());
      } else if (this.src.charCodeAt(this.pos) === 60 /* < */) {
        tokens.push(this.scanElement());
      } else {
        tokens.push(this.scanText());
      }
    }
    return tokens;
  }

  private scanComment(): LComment {
    const start = this.pos;
    this.pos += 4; // <!--
    const dataStart = this.pos;
    const end = this.src.indexOf('-->', this.pos);
    if (end === -1) this.fail('Unterminated comment.');
    const data = this.src.slice(dataStart, end);
    this.pos = end + 3;
    return {
      kind: 'comment',
      data,
      raw: this.src.slice(start, this.pos),
      range: this.range(start),
    };
  }

  private scanDtd(): LDTD | LDeclaration {
    const start = this.pos;
    const head = this.src.slice(this.pos, this.pos + 10).toUpperCase();
    if (head.startsWith('<!DOCTYPE')) {
      this.pos += 9;
      let depth = 0;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth === 0) {
          this.pos++;
          return { kind: 'dtd', raw: this.src.slice(start, this.pos), range: this.range(start) };
        }
        this.pos++;
      }
      this.fail('Unterminated DOCTYPE declaration.', start);
    }
    // Other declarations (e.g. <!ELEMENT>) are not expected in plists.
    this.fail('Unsupported markup declaration.', start);
  }

  private scanPI(): LProcessingInstruction | LDeclaration {
    const start = this.pos;
    this.pos += 2; // <?
    const targetStart = this.pos;
    while (this.pos < this.src.length && !/\s/.test(this.src[this.pos]) && this.src[this.pos] !== '?') {
      this.pos++;
    }
    const target = this.src.slice(targetStart, this.pos);
    const end = this.src.indexOf('?>', this.pos);
    if (end === -1) this.fail('Unterminated processing instruction.', start);
    let data = this.src.slice(this.pos, end);
    if (data.length && data.charCodeAt(0) === 32) data = data.slice(1);
    this.pos = end + 2;
    const range = this.range(start);
    if (target === 'xml') {
      return { kind: 'declaration', raw: this.src.slice(start, this.pos), range };
    }
    return { kind: 'pi', target, data, raw: this.src.slice(start, this.pos), range };
  }

  private scanText(): LText {
    const start = this.pos;
    const next = this.src.indexOf('<', this.pos);
    this.pos = next === -1 ? this.src.length : next;
    return { kind: 'text', raw: this.src.slice(start, this.pos), range: this.range(start) };
  }

  private scanElement(): LElement {
    const start = this.pos;
    this.pos++; // <
    const tagStart = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_.:-]/.test(this.src[this.pos])) {
      this.pos++;
    }
    const tag = this.src.slice(tagStart, this.pos);
    if (!tag) this.fail('Invalid tag name.', start + 1);

    const attributes: LAttribute[] = [];
    let selfClosing = false;
    for (;;) {
      this.skashSpaces();
      if (this.src.startsWith('/>', this.pos)) {
        this.pos += 2;
        selfClosing = true;
        break;
      }
      if (this.src.charCodeAt(this.pos) === 62 /* > */) {
        this.pos++;
        break;
      }
      const attr = this.scanAttribute(start);
      if (attr) attributes.push(attr);
      else this.fail('Malformed open tag.');
    }
    const openTagRange = this.range(start);

    if (selfClosing) {
      return this.finalizeElement({
        tag,
        selfClosing: true,
        attributes,
        children: [],
        innerRange: null,
        openTagRange,
        closeTagRange: null,
        range: this.range(start),
      });
    }

    const innerStart = this.pos;
    const children: LosslessNode[] = [];
    for (;;) {
      if (this.src.startsWith('</', this.pos)) {
        const closeStart = this.pos;
        this.pos += 2;
        const closeTagStart = this.pos;
        while (this.pos < this.src.length && this.src[this.pos] !== '>') this.pos++;
        if (this.pos >= this.src.length) this.fail('Unterminated close tag.', closeStart);
        const closeTag = this.src.slice(closeTagStart, this.pos).trimEnd();
        this.pos++; // >
        if (closeTag !== tag) {
          this.fail(`Mismatched close tag: expected </${tag}> but found </${closeTag}>.`, closeStart);
        }
        const closeTagRange = this.range(closeStart);
        const innerRange = this.range(innerStart, closeStart);
        return this.finalizeElement({
          tag,
          selfClosing: false,
          attributes,
          children,
          innerRange,
          openTagRange,
          closeTagRange,
          range: this.range(start),
        });
      }
      if (this.pos >= this.src.length) {
        this.fail(`Unclosed <${tag}> element.`, start);
      }
      if (this.src.startsWith('<!--', this.pos)) children.push(this.scanComment());
      else if (this.src.startsWith('<![CDATA[', this.pos)) children.push(this.scanCData());
      else if (this.src.startsWith('<?', this.pos)) children.push(this.scanPI());
      else if (this.src.charCodeAt(this.pos) === 60) children.push(this.scanElement());
      else children.push(this.scanText());
    }
  }

  private scanCData(): LCDATA {
    const start = this.pos;
    const dataStart = this.pos + 9;
    const end = this.src.indexOf(']]>', dataStart);
    if (end === -1) this.fail('Unterminated CDATA section.', start);
    this.pos = end + 3;
    return { kind: 'cdata', raw: this.src.slice(start, this.pos), range: this.range(start) };
  }

  private scanAttribute(elementStart: number): LAttribute | null {
    const start = this.pos;
    const nameStart = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_.:-]/.test(this.src[this.pos])) this.pos++;
    const name = this.src.slice(nameStart, this.pos);
    if (!name) return null;
    this.skashSpaces();
    if (this.src[this.pos] !== '=') this.fail('Expected "=" after attribute name.', start);
    this.pos++;
    this.skashSpaces();
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") this.fail('Attribute value must be quoted.', this.pos);
    this.pos++;
    const valueStart = this.pos;
    const end = this.src.indexOf(quote, this.pos);
    if (end === -1) this.fail('Unterminated attribute value.', valueStart - 1);
    const raw = this.src.slice(valueStart, end);
    const { decoded } = this.scanCharData(raw, valueStart, /* record */ false);
    this.pos = end + 1;
    void elementStart;
    return {
      name,
      value: normalizeEol(decoded),
      raw,
      range: this.range(start),
    };
  }

  private skashSpaces(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private range(start: number, end: number = this.pos): SourceRange {
    const loc = this.locationAt(start);
    return {
      startOffset: start,
      endOffset: end,
      startLine: loc.line,
      startColumn: loc.column,
    };
  }

  /**
   * Scan parsed character data: returns raw segments, decoded content and
   * the entity references encountered. Unknown entities are kept verbatim
   * (matching the default parser) and recorded as diagnostics.
   */
  scanCharData(
    raw: string,
    offset: number,
    record: boolean,
  ): { decoded: string; refs: LEntityRef[] } {
    const refs: LEntityRef[] = [];
    let decoded = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch !== '&') {
        decoded += ch;
        i++;
        continue;
      }
      const semi = raw.indexOf(';', i + 1);
      const body = semi === -1 ? null : raw.slice(i + 1, semi);
      const resolved = body === null ? null : resolveEntity(body);
      const refEnd = semi === -1 ? raw.length : semi + 1;
      const refRaw = raw.slice(i, refEnd);
      const ref: LEntityRef = {
        kind: 'entity',
        raw: refRaw,
        resolved,
        index: offset + i,
      };
      refs.push(ref);
      if (resolved !== null) {
        decoded += resolved;
      } else {
        decoded += refRaw;
        if (record) {
          const loc = this.locationAt(offset + i);
          this.diagnostics.push({
            code: 'unknownEntity',
            message: `Unknown XML entity reference ${refRaw}.`,
            index: loc.index,
            line: loc.line,
            column: loc.column,
          });
        }
      }
      i = refEnd;
    }
    return { decoded, refs };
  }

  private finalizeElement(partial: {
    tag: string;
    selfClosing: boolean;
    attributes: LAttribute[];
    children: LosslessNode[];
    innerRange: SourceRange | null;
    openTagRange: SourceRange;
    closeTagRange: SourceRange | null;
    range: SourceRange;
  }): LElement {
    const element: LElement = {
      kind: 'element',
      tag: partial.tag,
      selfClosing: partial.selfClosing,
      attributes: partial.attributes,
      children: partial.children,
      innerRange: partial.innerRange,
      openTagRange: partial.openTagRange,
      closeTagRange: partial.closeTagRange,
      range: partial.range,
      rawInner: '',
      entityRefs: [],
      entries: null,
    };
    let rawInner = '';
    for (const child of partial.children) {
      if (child.kind === 'text' || child.kind === 'cdata') {
        rawInner += child.raw;
        const raw =
          child.kind === 'cdata'
            ? child.raw.slice(9, child.raw.length - 3)
            : child.raw;
        const offset =
          child.kind === 'cdata' ? child.range.startOffset + 9 : child.range.startOffset;
        const { refs } = this.scanCharData(raw, offset, true);
        element.entityRefs.push(...refs);
      }
    }
    element.rawInner = rawInner;
    return element;
  }
}

function resolveEntity(body: string): string | null {
  if (body[0] === '#') {
    let codePoint: number;
    if (body[1] === 'x' || body[1] === 'X') {
      if (!/^[0-9a-fA-F]+$/.test(body.slice(2))) return null;
      codePoint = parseInt(body.slice(2), 16);
    } else {
      if (!/^[0-9]+$/.test(body.slice(1))) return null;
      codePoint = parseInt(body.slice(1), 10);
    }
    if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return null;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return null;
    }
  }
  return NAMED_ENTITIES[body] ?? null;
}

/**
 * Adapter exposing a token-tree node through the {@link SemanticNode} surface
 * consumed by the shared plist walker. Text nodes are served *decoded*
 * (entities resolved, EOL normalized), reproducing exactly the character data
 * the xmldom DOM exposes to the default parser.
 */
class AdapterNode implements SemanticNode {
  private _childNodes: AdapterNode[] | undefined;

  private constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly nodeValue: string | null,
    private readonly token: LosslessNode,
    private readonly decoder: Tokenizer | null,
  ) {}

  static from(token: LosslessNode, decoder: Tokenizer): AdapterNode {
    if (token.kind === 'element') {
      return new AdapterNode(1, token.tag, null, token, decoder);
    }
    if (token.kind === 'text') {
      const { decoded } = decoder.scanCharData(token.raw, token.range.startOffset, false);
      return new AdapterNode(NODE_TEXT, '#text', normalizeEol(decoded), token, decoder);
    }
    if (token.kind === 'cdata') {
      const body = token.raw.slice(9, token.raw.length - 3);
      return new AdapterNode(NODE_CDATA, '#cdata-section', normalizeEol(body), token, decoder);
    }
    if (token.kind === 'comment') {
      return new AdapterNode(NODE_COMMENT, '#comment', token.data, token, decoder);
    }
    if (token.kind === 'pi') {
      return new AdapterNode(NODE_PI, token.target, token.data, token, decoder);
    }
    // declaration / dtd are not element children in practice.
    return new AdapterNode(NODE_TEXT, '#text', '', token, decoder);
  }

  get childNodes(): ArrayLike<AdapterNode> {
    if (this._childNodes) return this._childNodes;
    const out: AdapterNode[] = [];
    const { token, decoder } = this;
    if (token.kind === 'element' && decoder) {
      for (const child of token.children) {
        out.push(AdapterNode.from(child, decoder));
      }
    }
    this._childNodes = out;
    return out;
  }
}

const SCALAR_TAGS: ReadonlySet<string> = new Set([
  'string',
  'key',
  'integer',
  'real',
  'data',
  'date',
]);

/** Pair dict key/value elements in the same order the semantic walker uses. */
function buildDictEntries(dict: LElement): LDictEntry[] {
  const elements: LElement[] = [];
  for (const child of dict.children) {
    if (child.kind === 'element') elements.push(child);
  }
  const entries: LDictEntry[] = [];
  for (let i = 0; i < elements.length; i += 2) {
    const keyEl = elements[i];
    const valueEl = i + 1 < elements.length ? elements[i + 1] : null;
    entries.push({ key: keyEl, value: valueEl && valueEl.tag !== 'key' ? valueEl : null });
  }
  return entries;
}

function decodedText(element: LElement, tokenizer: Tokenizer): string {
  let decoded = '';
  for (const child of element.children) {
    if (child.kind === 'text') {
      decoded += normalizeEol(
        tokenizer.scanCharData(child.raw, child.range.startOffset, false).decoded,
      );
    } else if (child.kind === 'cdata') {
      decoded += normalizeEol(child.raw.slice(9, child.raw.length - 3));
    }
  }
  return decoded;
}

/**
 * Parse an XML plist document into a {@link LosslessPlist}: the semantic
 * value plus source ranges, comments, PIs, whitespace, key order and the
 * original scalar spelling.
 */
export function parseLossless(source: string): LosslessPlist {
  if (typeof source !== 'string') {
    throw new TypeError('parseLossless() expects an XML string.');
  }
  const diagnostics: LosslessDiagnostic[] = [];
  const tokenizer = new Tokenizer(source, diagnostics);
  const tokens = tokenizer.scanDocument();

  const roots: LElement[] = [];
  for (const token of tokens) {
    if (token.kind === 'element') roots.push(token);
  }
  if (roots.length !== 1 || roots[0].tag !== 'plist') {
    throw new Error('malformed document. First element should be <plist>');
  }
  const root = roots[0];

  // Drive the shared semantic walker through the token tree. Structural
  // errors use the same messages and Error class as the default parser.
  let value: PlistValue;
  try {
    value = parsePlistXML(AdapterNode.from(root, tokenizer) as unknown as SemanticNode);
  } catch (err) {
    if (err instanceof LosslessParseError) throw err;
    const located = locateSemanticError(err, root);
    if (located) {
      const enriched = new Error((err as Error).message) as Error & {
        index?: number;
        line?: number;
        column?: number;
        snippet?: string;
      };
      const loc = tokenizer.locationAt(located);
      enriched.index = loc.index;
      enriched.line = loc.line;
      enriched.column = loc.column;
      enriched.snippet = makeSnippet(source, loc.index);
      throw enriched;
    }
    throw err;
  }
  if (Array.isArray(value) && value.length === 1) value = value[0];

  // Build dict entry pairings and detect duplicate keys. Each dict has an
  // independent key namespace; the map is rebuilt per dict.
  const dupes: LosslessDiagnostic[] = [];
  walkElements(root, (element) => {
    if (element.tag === 'dict') {
      element.entries = buildDictEntries(element);
      const seen = new Map<string, number>();
      for (const entry of element.entries) {
        const name = decodedText(entry.key, tokenizer);
        const firstOffset = entry.key.range.startOffset;
        const prior = seen.get(name);
        if (prior !== undefined) {
          const loc = tokenizer.locationAt(firstOffset);
          dupes.push({
            code: 'duplicateKey',
            message: `Duplicate <key>${name}</key> at line ${loc.line} (first seen at offset ${prior}).`,
            index: loc.index,
            line: loc.line,
            column: loc.column,
          });
        } else {
          seen.set(name, firstOffset);
        }
      }
    }
  });

  const all = diagnostics.concat(dupes);
  all.sort((a, b) => a.index - b.index || (a.code < b.code ? -1 : 1));

  return {
    tokens,
    root,
    value,
    diagnostics: all,
    source,
    digest: fnv1aUtf8(source),
  };
}

function walkElements(element: LElement, visit: (el: LElement) => void): void {
  visit(element);
  for (const child of element.children) {
    if (child.kind === 'element') walkElements(child, visit);
  }
}

/**
 * Best-effort mapping from a shared-walker error message to the offending
 * element's offset, so rejections still point at the first violation.
 */
function locateSemanticError(err: unknown, root: LElement): number | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  let target: LElement | null = null;
  if (msg.startsWith('Invalid PLIST tag')) {
    walkElements(root, (el) => {
      if (!target && !isKnownTag(el.tag)) target = el;
    });
  }
  return target ? target.range.startOffset : null;
}

function isKnownTag(tag: string): boolean {
  return (
    tag === 'plist' ||
    tag === 'dict' ||
    tag === 'array' ||
    tag === 'key' ||
    SCALAR_TAGS.has(tag) ||
    tag === 'null' ||
    tag === 'true' ||
    tag === 'false'
  );
}

/* ------------------------------------------------------------------ */
/* Value reading / path location                                       */
/* ------------------------------------------------------------------ */

/**
 * Semantic value of a single scalar/container element, using the shared
 * decoding rules. Useful for asserting what a located node currently means.
 */
export function elementValue(element: LElement, doc: LosslessPlist): PlistValue {
  const tokenizer = new Tokenizer(doc.source, []);
  return parsePlistXML(AdapterNode.from(element, tokenizer) as unknown as SemanticNode);
}

/** Decoded character data of a scalar/key element. */
export function elementText(element: LElement, doc: LosslessPlist): string {
  const tokenizer = new Tokenizer(doc.source, []);
  return decodedText(element, tokenizer);
}

/**
 * Locate the element found by following dict keys and array indices from the
 * plist root. Duplicate dict keys are rejected; locate by entry index with
 * {@link locateEntry} instead.
 */
export function locateNode(doc: LosslessPlist, path: readonly (string | number)[]): LElement {
  let current: LElement = doc.root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      const elements = childElements(current);
      const next = elements[segment];
      if (!next) {
        throw new Error(`Array index ${segment} not found at path <${current.tag}>.`);
      }
      current = next;
      continue;
    }
    const dict = requireDict(current);
    const matches: LDictEntry[] = [];
    for (const entry of dict.entries ?? []) {
      if (entry.key && elementText(entry.key, doc) === segment) matches.push(entry);
    }
    if (matches.length === 0) {
      throw new Error(`Key "${segment}" not found at path <${current.tag}>.`);
    }
    if (matches.length > 1) {
      const loc = doc.diagnostics.find(
        (d) =>
          d.code === 'duplicateKey' &&
          matches.some((m) => m.key.range.startOffset === d.index),
      );
      throw makeLocationError(
        `Key "${segment}" is not unique at path <${current.tag}>; use locateEntry() with an entry index.`,
        matches[1].key.range.startOffset,
        doc,
        loc?.message,
      );
    }
    if (!matches[0].value) {
      throw new Error(`Key "${segment}" has no value element.`);
    }
    current = matches[0].value;
  }
  return current;
}

/**
 * Locate a dict entry by key path plus the position of the entry within the
 * last dict. `entryIndex` is required when the final key is duplicated.
 */
export function locateEntry(
  doc: LosslessPlist,
  keyPath: readonly (string | number)[],
  entryIndex = 0,
): LDictEntry {
  const parentPath = keyPath.slice(0, -1);
  const finalKey = keyPath[keyPath.length - 1];
  const dict = requireDict(locateNode(doc, parentPath));
  if (typeof finalKey !== 'string') {
    throw new Error('locateEntry() requires a string final key.');
  }
  const matches: LDictEntry[] = [];
  for (const entry of dict.entries ?? []) {
    if (entry.key && elementText(entry.key, doc) === finalKey) matches.push(entry);
  }
  if (matches.length === 0) {
    throw new Error(`Key "${finalKey}" not found.`);
  }
  const chosen = matches[entryIndex];
  if (!chosen) {
    throw new Error(
      `Entry index ${entryIndex} for key "${finalKey}" not found (${matches.length} occurrences).`,
    );
  }
  return chosen;
}

function childElements(element: LElement): LElement[] {
  const out: LElement[] = [];
  for (const child of element.children) {
    if (child.kind === 'element') out.push(child);
  }
  return out;
}

function requireDict(element: LElement): LElement {
  if (element.tag !== 'dict') {
    throw new Error(`Expected <dict> at path but found <${element.tag}>.`);
  }
  return element;
}

function makeLocationError(
  message: string,
  index: number,
  doc: LosslessPlist,
  detail?: string,
): Error {
  const err = new Error(detail ? `${message} ${detail}` : message) as Error & {
    index?: number;
    line?: number;
    column?: number;
    snippet?: string;
  };
  const tokenizer = new Tokenizer(doc.source, []);
  const loc = tokenizer.locationAt(index);
  err.index = loc.index;
  err.line = loc.line;
  err.column = loc.column;
  err.snippet = makeSnippet(doc.source, index);
  return err;
}

/* ------------------------------------------------------------------ */
/* Format-preserving edit plans                                        */
/* ------------------------------------------------------------------ */

/** Values that an edit plan can write into the document. */
export type EditValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | Uint8Array
  | EditValue[]
  | { [key: string]: EditValue };

export type EditOperation =
  | { type: 'set'; path: (string | number)[]; value: EditValue }
  | {
      type: 'setEntry';
      keyPath: (string | number)[];
      entryIndex: number;
      value: EditValue;
    }
  | { type: 'replaceKey'; path: (string | number)[]; newName: string };

export interface PlannedReplacement {
  /** Half-open source span to replace. */
  startOffset: number;
  endOffset: number;
  oldText: string;
  newText: string;
  /** Short description, used in error messages and traces. */
  description: string;
}

export interface EditPlan {
  /** Digest of the source the plan was built for. */
  sourceDigest: string;
  /** Original length, re-checked alongside the digest on apply. */
  sourceLength: number;
  /** Replacements sorted from the end of the document to the beginning. */
  replacements: PlannedReplacement[];
  /** Human-readable summary of each planned change. */
  summary: string[];
}

/** Error thrown when a plan is applied to a different source document. */
export class DigestMismatchError extends Error {
  name = 'DigestMismatchError';
  expectedDigest: string;
  actualDigest: string;
  constructor(expected: string, actual: string) {
    super(
      `Source digest mismatch: plan was built for ${expected}, current source is ${actual}. ` +
        'Refusing to apply a format-preserving edit plan to modified input.',
    );
    this.expectedDigest = expected;
    this.actualDigest = actual;
  }
}

function escapeXmlText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else out += ch;
  }
  return out;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function tagForScalar(value: string | number | bigint | boolean | Date | Uint8Array | null): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
  if (typeof value === 'bigint') return 'integer';
  if (value instanceof Date) return 'date';
  if (value instanceof Uint8Array) return 'data';
  return 'string';
}

/**
 * Serialize a value to plist XML without pretty-printing. Containers are
 * emitted on a single line; this keeps new/inserted values self-contained.
 */
export function serializeValue(value: EditValue): string {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (value === null) return '<null/>';
  if (typeof value === 'bigint') return `<integer>${value.toString()}</integer>`;
  if (typeof value === 'number') {
    const tag = tagForScalar(value);
    return `<${tag}>${value.toString()}</${tag}>`;
  }
  if (value instanceof Date) {
    return `<date>${new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`;
  }
  if (value instanceof Uint8Array) {
    return `<data>${uint8ToBase64(value)}</data>`;
  }
  if (typeof value === 'string') {
    return `<string>${escapeXmlText(value)}</string>`;
  }
  if (Array.isArray(value)) {
    const inner = value.map((item) => serializeValue(item)).join('');
    return `<array>${inner}</array>`;
  }
  if (typeof value === 'object') {
    const parts: string[] = ['<dict>'];
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined) continue;
      parts.push(`<key>${escapeXmlText(key)}</key>`);
      parts.push(serializeValue(v));
    }
    parts.push('</dict>');
    return parts.join('');
  }
  throw new TypeError(`Unsupported edit value type: ${typeof value}`);
}

/**
 * Build a format-preserving edit plan. The plan is a pure description: it
 * never touches the file system and can be applied later with
 * {@link applyEditPlan}.
 */
export function planEdits(
  doc: LosslessPlist,
  operations: readonly EditOperation[],
): EditPlan {
  const replacements: PlannedReplacement[] = [];

  const addScalarReplacement = (
    element: LElement,
    value: EditValue,
    description: string,
  ): void => {
    const fragment = serializeValue(value);
    const match = /^<([a-z]+)(\/>|>)/.exec(fragment);
    const newTag = match ? match[1] : '';
    const selfClose = fragment.endsWith('/>');

    if (!element.selfClosing && !selfClose && element.tag === newTag) {
      // Same open/close tags: only swap the inner character data, keeping
      // both the tags and all surrounding bytes untouched.
      const inner = element.innerRange!;
      const innerText = fragment.slice(
        newTag.length + 2,
        fragment.length - (newTag.length + 3),
      );
      replacements.push({
        startOffset: inner.startOffset,
        endOffset: inner.endOffset,
        oldText: doc.source.slice(inner.startOffset, inner.endOffset),
        newText: innerText,
        description,
      });
    } else {
      // Tag shape changes (e.g. <string/> -> <true/>): replace the element.
      replacements.push({
        startOffset: element.range.startOffset,
        endOffset: element.range.endOffset,
        oldText: doc.source.slice(element.range.startOffset, element.range.endOffset),
        newText: fragment,
        description,
      });
    }
  };

  for (const op of operations) {
    if (op.type === 'set') {
      const element = locateNode(doc, op.path);
      addScalarReplacement(
        element,
        op.value,
        `set ${formatPath(op.path)}`,
      );
    } else if (op.type === 'setEntry') {
      const entry = locateEntry(doc, op.keyPath, op.entryIndex);
      if (!entry.value) {
        throw new Error(`Cannot set duplicate-key entry without an existing value element.`);
      }
      addScalarReplacement(
        entry.value,
        op.value,
        `set ${formatPath(op.keyPath)}#${op.entryIndex}`,
      );
    } else {
      const element = locateNode(doc, op.path);
      if (element.tag !== 'key') {
        throw new Error(
          `replaceKey target must be a <key> element, got <${element.tag}>.`,
        );
      }
      const inner = element.innerRange;
      if (!inner) {
        throw new Error('Cannot rename a self-closing <key/>.');
      }
      replacements.push({
        startOffset: inner.startOffset,
        endOffset: inner.endOffset,
        oldText: doc.source.slice(inner.startOffset, inner.endOffset),
        newText: escapeXmlText(op.newName),
        description: `rename ${formatPath(op.path)} -> ${op.newName}`,
      });
    }
  }

  // Deterministic order regardless of how callers supplied the operations:
  // sort by start offset; reject overlapping plans up front (atomicity).
  replacements.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  for (let i = 1; i < replacements.length; i++) {
    const prev = replacements[i - 1];
    const cur = replacements[i];
    if (cur.startOffset < prev.endOffset) {
      throw new Error(
        `Overlapping edits at offsets ${prev.startOffset}..${prev.endOffset} and ` +
          `${cur.startOffset}..${cur.endOffset}; refusing to build an ambiguous plan.`,
      );
    }
  }

  return {
    sourceDigest: doc.digest,
    sourceLength: doc.source.length,
    replacements: replacements.slice().reverse(),
    summary: replacements.map(
      (r) => `${r.description}: [${r.startOffset},${r.endOffset}) "${r.oldText.trim()}" -> "${r.newText.trim()}"`,
    ),
  };
}

function formatPath(path: readonly (string | number)[]): string {
  return '/' + path.map((p) => (typeof p === 'number' ? `[${p}]` : p)).join('/');
}

/**
 * Apply an edit plan to exactly the source it was built for and return the
 * new document. Pure: the input string is never mutated and nothing is
 * written to disk. Any digest/source failure throws before the output is
 * produced, so a failed call cannot leave partially applied state.
 */
export function applyEditPlan(plan: EditPlan, source: string): string {
  if (typeof source !== 'string') {
    throw new TypeError('applyEditPlan() expects the original XML string.');
  }
  const digest = fnv1aUtf8(source);
  if (digest !== plan.sourceDigest || source.length !== plan.sourceLength) {
    throw new DigestMismatchError(plan.sourceDigest, digest);
  }
  // Replacements are stored in descending order, so earlier offsets stay
  // valid while splicing. Verify every span's original text first.
  for (const r of plan.replacements) {
    const actual = source.slice(r.startOffset, r.endOffset);
    if (actual !== r.oldText) {
      throw new Error(
        `Edit "${r.description}" expected "${r.oldText}" at offsets ` +
          `${r.startOffset}..${r.endOffset} but found "${actual}".`,
      );
    }
  }
  let out = source;
  for (const r of plan.replacements) {
    out = out.slice(0, r.startOffset) + r.newText + out.slice(r.endOffset);
  }
  return out;
}
