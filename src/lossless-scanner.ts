/**
 * Minimal, deterministic source scanner for XML plist documents.
 *
 * The default parser delegates to an external DOM implementation,
 * which drops source positions and trivia. For the lossless view we
 * scan the same source ourselves, producing a concrete syntax tree
 * that records, for every element and text node:
 *
 *   - the exact source range (UTF-16 code unit offsets, matching JS
 *     `String.prototype.slice`),
 *   - the raw text as authored,
 *   - the resolved text (entity + XML end-of-line normalization),
 *   - entity references and where they occur,
 *   - comments, processing instructions, CDATA sections and the
 *     document prelude (XML declaration, doctype, surrounding text).
 *
 * The scanner itself performs no plist tag interpretation. Plist tag
 * semantics are applied afterwards through `convertPlistNode` from
 * `xml-elements.ts`, the exact same function the default DOM parser
 * uses, so the two entry points cannot drift apart.
 */

import {
  CDATA_NODE,
  COMMENT_NODE,
  PROCESSING_INSTRUCTION_NODE,
  TEXT_NODE,
  type XmlElementLike,
} from './xml-elements.js';

export interface SourceRange {
  /** UTF-16 code unit offset of the first character (inclusive). */
  readonly offset: number;
  /** UTF-16 code unit offset one past the last character. */
  readonly endOffset: number;
  /** 1-based source line of `offset`. */
  readonly line: number;
  /** 1-based UTF-16 column of `offset`. */
  readonly column: number;
}

export interface EntityRef {
  readonly raw: string;
  readonly resolved: string | null;
  readonly known: boolean;
  readonly range: SourceRange;
}

interface CstNodeBase {
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null;
  readonly range: SourceRange;
  /** Raw source slice for this node (elements: whole element). */
  readonly raw: string;
  /** Entity references found inside (text-bearing nodes only). */
  readonly entities: readonly EntityRef[];
}

export interface CstElement extends CstNodeBase {
  readonly nodeType: 1;
  readonly nodeName: string;
  nodeValue: null;
  readonly childNodes: CstNode[];
  /** Range covering `<name ...>`. */
  readonly openTag: SourceRange;
  /** Range covering `</name>` or null for self closing elements. */
  readonly closeTag: SourceRange | null;
  readonly selfClosing: boolean;
}

export interface CstText extends CstNodeBase {
  readonly nodeType: 3;
  readonly nodeName: '#text';
  nodeValue: string;
}

export interface CstCData extends CstNodeBase {
  readonly nodeType: 4;
  readonly nodeName: '#cdata-section';
  nodeValue: string;
}

export interface CstComment extends CstNodeBase {
  readonly nodeType: 8;
  readonly nodeName: '#comment';
  nodeValue: string;
}

export interface CstProcessingInstruction extends CstNodeBase {
  readonly nodeType: 7;
  readonly nodeName: string;
  nodeValue: string;
}

export type CstNode =
  | CstElement
  | CstText
  | CstCData
  | CstComment
  | CstProcessingInstruction;

/** Document level items outside of the root <plist> element. */
export type CstMisc = CstProcessingInstruction | CstComment | CstText;

export interface CstDocument {
  readonly source: string;
  readonly root: CstElement;
  readonly prelude: readonly CstMisc[];
  readonly trailing: readonly CstMisc[];
}

export class PlistScanError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly sourceSnippet: string;
  constructor(
    message: string,
    source: string,
    offset: number,
  ) {
    const pos = lineColumn(source, offset);
    const snippet = snippetAround(source, offset);
    super(
      message +
        ` (offset ${offset}, line ${pos.line}, column ${pos.column})`,
    );
    this.name = 'PlistScanError';
    this.offset = offset;
    this.line = pos.line;
    this.column = pos.column;
    this.sourceSnippet = snippet;
  }
}

export function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function snippetAround(source: string, offset: number, radius = 32): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(source.length, offset + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return prefix + source.slice(start, end).replace(/\r/g, '\\r').replace(/\n/g, '\\n') + suffix;
}

/**
 * XML 1.0 end-of-line normalization: `\r\n` and `\r` both become `\n`.
 * Applied to text and CDATA content (and comments), matching a
 * conformant XML parser's reported node values.
 */
function normalizeEol(text: string): string {
  if (text.indexOf('\r') === -1) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 13) {
      out += '\n';
      if (text.charCodeAt(i + 1) === 10) i += 1;
    } else {
      out += text[i];
    }
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

interface DecodeResult {
  value: string;
  entities: EntityRef[];
}

function decodeEntities(
  source: string,
  raw: string,
  baseOffset: number,
  makeError: (offset: number) => never,
): DecodeResult {
  if (raw.indexOf('&') === -1) {
    return { value: normalizeEol(raw), entities: [] };
  }
  let value = '';
  const entities: EntityRef[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw.charCodeAt(i);
    if (ch !== 38 /* & */) {
      value += raw[i];
      i += 1;
      continue;
    }
    const semi = raw.indexOf(';', i + 1);
    if (semi === -1) {
      makeError(baseOffset + i);
    }
    const body = raw.slice(i + 1, semi);
    const range: SourceRange = {
      offset: baseOffset + i,
      endOffset: baseOffset + semi + 1,
      ...lineColumn(source, baseOffset + i),
    };
    let resolved: string | null = null;
    let known = false;
    if (body[0] === '#') {
      const codepoint = parseCharRef(body, () => makeError(baseOffset + i));
      resolved = String.fromCodePoint(codepoint);
      known = true;
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      resolved = NAMED_ENTITIES[body];
      known = true;
    }
    entities.push({ raw: raw.slice(i, semi + 1), resolved, known, range });
    // Unknown entities stay verbatim, exactly like the DOM parser
    // leaves `&bogus;` in place; the edit layer treats them as
    // protected trivia instead of silently rewriting them.
    value += known ? (resolved as string) : raw.slice(i, semi + 1);
    i = semi + 1;
  }
  return { value: normalizeEol(value), entities };
}

function parseCharRef(body: string, invalid: () => never): number {
  let digits: string;
  let radix: number;
  if (body[1] === 'x' || body[1] === 'X') {
    digits = body.slice(2);
    radix = 16;
  } else {
    digits = body.slice(1);
    radix = 10;
  }
  if (digits.length === 0 || !new RegExp(`^[0-9a-fA-F]+$`).test(digits)) {
    invalid();
  }
  const cp = parseInt(digits, radix);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    invalid();
  }
  return cp;
}

const PI_NODE = PROCESSING_INSTRUCTION_NODE;

/**
 * Scan `source` into a concrete syntax tree.
 */
export function scanXmlPlist(source: string): CstDocument {
  const scan = new Scanner(source);
  return scan.run();
}

class Scanner {
  private pos = 0;
  private readonly source: string;
  private readonly prelude: CstMisc[] = [];
  private readonly trailing: CstMisc[] = [];
  private root: CstElement | null = null;

  constructor(source: string) {
    this.source = source;
  }

  private fail(offset: number, message: string): never {
    throw new PlistScanError(message, this.source, offset);
  }

  private range(offset: number, endOffset: number): SourceRange {
    return { offset, endOffset, ...lineColumn(this.source, offset) };
  }

  private makeNodeRangeFail(): (offset: number) => never {
    return (offset: number) => {
      this.fail(offset, 'Invalid XML entity reference');
    };
  }

  run(): CstDocument {
    // The document may start with a UTF-8/UTF-16 BOM; a conformant XML
    // parser strips it. It is not part of any node range.
    if (this.source.charCodeAt(0) === 0xfeff) {
      this.pos = 1;
    }
    this.consumeMisc(this.prelude);

    while (this.pos < this.source.length) {
      if (this.source.charCodeAt(this.pos) !== 60 /* < */) {
        this.fail(this.pos, 'Unexpected text outside of document element');
      }
      const next = this.source[this.pos + 1];
      if (next === '?') {
        this.consumePi();
        continue;
      }
      if (next === '!') {
        if (this.source.startsWith('<!--', this.pos)) {
          this.consumeComment(this.prelude);
          continue;
        }
        if (this.source.startsWith('<!DOCTYPE', this.pos)) {
          this.consumeDoctype();
          continue;
        }
        this.fail(this.pos, 'Unsupported XML declaration');
      }
      if (next === '/') {
        this.fail(this.pos, 'Unexpected end tag');
      }
      // Root element start.
      break;
    }

    this.root = this.consumeElement() as CstElement;
    this.consumeMisc(this.trailing);
    if (this.pos !== this.source.length) {
      this.fail(this.pos, 'Unexpected content after document element');
    }
    return {
      source: this.source,
      root: this.root,
      prelude: this.prelude,
      trailing: this.trailing,
    };
  }

  private consumeMisc(bucket: CstMisc[]): void {
    while (this.pos < this.source.length) {
      const pos = this.pos;
      if (this.source.startsWith('<!--', pos)) {
        this.consumeComment(bucket);
        continue;
      }
      if (this.source.charCodeAt(pos) === 60 && this.source[pos + 1] === '?') {
        this.consumePi(bucket);
        continue;
      }
      // Raw text up to the next `<` (whitespace, newlines, BOM-less).
      const next = this.source.indexOf('<', pos);
      const end = next === -1 ? this.source.length : next;
      if (end > pos) {
        const raw = this.source.slice(pos, end);
        const decoded = decodeEntities(this.source, raw, pos, this.makeNodeRangeFail());
        const node: CstText = {
          nodeType: TEXT_NODE,
          nodeName: '#text',
          nodeValue: decoded.value,
          range: this.range(pos, end),
          raw,
          entities: decoded.entities,
        };
        bucket.push(node);
        this.pos = end;
        continue;
      }
      break;
    }
  }

  private consumeComment(bucket?: CstNode[] | CstMisc[]): CstComment {
    const start = this.pos;
    const end = this.source.indexOf('-->', start + 4);
    if (end === -1) {
      this.fail(start, 'Unterminated XML comment');
    }
    const endOffset = end + 3;
    const inner = this.source.slice(start + 4, end);
    if (inner.indexOf('--') !== -1 || inner.endsWith('-')) {
      this.fail(start, 'Invalid XML comment');
    }
    const node: CstComment = {
      nodeType: COMMENT_NODE,
      nodeName: '#comment',
      nodeValue: normalizeEol(inner),
      range: this.range(start, endOffset),
      raw: this.source.slice(start, endOffset),
      entities: [],
    };
    this.pos = endOffset;
    bucket?.push(node);
    return node;
  }

  private consumePi(bucket?: CstNode[] | CstMisc[]): CstProcessingInstruction {
    const start = this.pos;
    const end = this.source.indexOf('?>', start + 2);
    if (end === -1) {
      this.fail(start, 'Unterminated processing instruction');
    }
    const endOffset = end + 2;
    const bodyStart = start + 2;
    let nameEnd = bodyStart;
    while (
      nameEnd < end &&
      !/\s/.test(this.source[nameEnd])
    ) {
      nameEnd += 1;
    }
    const target = this.source.slice(bodyStart, nameEnd);
    let dataStart = nameEnd;
    while (dataStart < end && /\s/.test(this.source[dataStart])) {
      dataStart += 1;
    }
    const data = this.source.slice(dataStart, end);
    const node: CstProcessingInstruction = {
      nodeType: PI_NODE,
      nodeName: target,
      nodeValue: data,
      range: this.range(start, endOffset),
      raw: this.source.slice(start, endOffset),
      entities: [],
    };
    this.pos = endOffset;
    bucket?.push(node);
    return node;
  }

  private consumeDoctype(): void {
    // Consume the whole declaration, including any internal subset.
    const start = this.pos;
    let i = start + '<!DOCTYPE'.length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < this.source.length; i++) {
      const ch = this.source[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth -= 1;
      } else if (ch === '>' && depth === 0) {
        this.pos = i + 1;
        return;
      }
    }
    this.fail(start, 'Unterminated DOCTYPE declaration');
  }

  private consumeElement(): CstNode {
    const start = this.pos;
    if (this.source.charCodeAt(start) !== 60) {
      this.fail(start, 'Expected element start tag');
    }
    const nameStart = start + 1;
    let i = nameStart;
    while (
      i < this.source.length &&
      /[A-Za-z0-9_:.-]/.test(this.source[i])
    ) {
      i += 1;
    }
    if (i === nameStart) {
      this.fail(start, 'Invalid element start tag');
    }
    const name = this.source.slice(nameStart, i);

    // Skip attributes while tracking quotes; record the tag span.
    while (i < this.source.length) {
      const ch = this.source[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < this.source.length && this.source[i] !== q) i += 1;
        if (i >= this.source.length) {
          this.fail(start, 'Unterminated element start tag');
        }
        i += 1;
        continue;
      }
      if (ch === '>') break;
      if (ch === '/' && this.source[i + 1] === '>') break;
      i += 1;
    }
    if (i >= this.source.length) {
      this.fail(start, 'Unterminated element start tag');
    }
    const selfClosing = this.source[i] === '/';
    const tagEnd = selfClosing ? i + 2 : i + 1;
    const openTag = this.range(start, tagEnd);

    const element: CstElement = {
      nodeType: 1,
      nodeName: name,
      nodeValue: null,
      range: this.range(start, start),
      raw: '',
      entities: [],
      childNodes: [],
      openTag,
      closeTag: null,
      selfClosing,
    };
    this.pos = tagEnd;

    if (!selfClosing) {
      this.consumeChildren(element);
      // Expect matching close tag.
      const closeStart = this.pos;
      if (
        this.source.charCodeAt(closeStart) !== 60 ||
        this.source[closeStart + 1] !== '/'
      ) {
        this.fail(closeStart, 'Expected end tag for <' + name + '>');
      }
      const closeNameStart = closeStart + 2;
      const closeGt = this.source.indexOf('>', closeNameStart);
      if (closeGt === -1) {
        this.fail(closeStart, 'Unterminated end tag for <' + name + '>');
      }
      const closeName = this.source
        .slice(closeNameStart, closeGt)
        .replace(/\s+$/, '');
      if (closeName !== name) {
        this.fail(
          closeStart,
          `Mismatched end tag </${closeName}> for <${name}>`,
        );
      }
      this.pos = closeGt + 1;
      element.closeTag = this.range(closeStart, this.pos);
    }

    const endOffset = this.pos;
    (element as { range: SourceRange }).range = this.range(start, endOffset);
    (element as { raw: string }).raw = this.source.slice(start, endOffset);
    return element;
  }

  private consumeChildren(element: CstElement): void {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if (ch === '<') {
        const next = this.source[this.pos + 1];
        if (next === '/') return;
        if (this.source.startsWith('<!--', this.pos)) {
          this.consumeComment(element.childNodes);
          continue;
        }
        if (next === '!') {
          if (this.source.startsWith('<![CDATA[', this.pos)) {
            this.consumeCdata(element.childNodes);
            continue;
          }
          this.fail(this.pos, 'Unsupported XML declaration inside element');
        }
        if (next === '?') {
          this.consumePi(element.childNodes);
          continue;
        }
        element.childNodes.push(this.consumeElement());
        continue;
      }
      this.consumeText(element.childNodes);
    }
    this.fail(this.pos, 'Missing end tag for <' + element.nodeName + '>');
  }

  private consumeCdata(bucket: CstNode[]): void {
    const start = this.pos;
    const end = this.source.indexOf(']]>', start + '<![CDATA['.length);
    if (end === -1) {
      this.fail(start, 'Unterminated CDATA section');
    }
    const endOffset = end + ']]>'.length;
    const inner = this.source.slice(start + '<![CDATA['.length, end);
    const node: CstCData = {
      nodeType: CDATA_NODE,
      nodeName: '#cdata-section',
      nodeValue: normalizeEol(inner),
      range: this.range(start, endOffset),
      raw: this.source.slice(start, endOffset),
      entities: [],
    };
    this.pos = endOffset;
    bucket.push(node);
  }

  private consumeText(bucket: CstNode[]): void {
    const start = this.pos;
    const next = this.source.indexOf('<', start);
    const end = next === -1 ? this.source.length : next;
    const raw = this.source.slice(start, end);
    const decoded = decodeEntities(
      this.source,
      raw,
      start,
      this.makeNodeRangeFail(),
    );
    const node: CstText = {
      nodeType: TEXT_NODE,
      nodeName: '#text',
      nodeValue: decoded.value,
      range: this.range(start, end),
      raw,
      entities: decoded.entities,
    };
    this.pos = end;
    bucket.push(node);
  }
}

// Re-export so downstream code can rely on the structural interface.
export type { XmlElementLike };
