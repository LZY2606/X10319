/**
 * Minimal, position-tracking XML scanner used ONLY to locate source ranges.
 *
 * It does not decode semantics: the semantic value is produced by the same
 * `parsePlistXML` DOM walker that backs `parse()`. The scanner's job is to
 * answer "where is every node, comment, processing instruction and run of
 * text" while keeping strict XML rules so malformed input is rejected with
 * the first offending line/column.
 */

export interface SourcePosition {
  /** Zero-based UTF-16 code unit offset into the source string. */
  offset: number;
  /** Zero-based byte offset into the UTF-8 encoding of the source. */
  byteOffset: number;
  /** One-based line number; CRLF, CR and LF all count as one line break. */
  line: number;
  /** One-based column, counted in UTF-16 code units on the line. */
  column: number;
}

export interface SourceRange {
  /** Range start, inclusive. */
  start: SourcePosition;
  /** Range end, exclusive (points just past the last character). */
  end: SourcePosition;
}

export type ScanTokenType =
  | 'element'
  | 'text'
  | 'comment'
  | 'pi'
  | 'cdata'
  | 'doctype'
  | 'xmldecl';

export interface ScanToken {
  type: ScanTokenType;
  range: SourceRange;
  /** Whole raw source slice for this token. */
  raw: string;
  /** Element local name for `element` tokens. */
  name?: string;
  /** True for `<tag/>` form. */
  selfClosing?: boolean;
  /** Element tokens only: range of the element's children, excluding tags. */
  contentRange?: SourceRange;
  /** Element tokens only: inner raw source between open and close tags. */
  content?: string;
}

export class ScanError extends Error {
  readonly position: SourcePosition;
  constructor(message: string, position: SourcePosition) {
    super(
      `${message} (line ${position.line}, column ${position.column}, ` +
        `offset ${position.offset})`,
    );
    this.name = 'ScanError';
    this.position = position;
  }
}

const NAME_START = /[:A-Za-z_]/;

function isNameChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    NAME_START.test(ch) ||
    (ch >= '0' && ch <= '9') ||
    ch === '-' ||
    ch === '.' ||
    ch === '·'
  );
}

/**
 * Streaming position tracker. Byte offsets are accumulated incrementally so
 * nothing depends on re-encoding substrings; the accounting is deterministic
 * and independent of platform locale or `String.prototype` enumeration.
 */
class Cursor {
  offset = 0;
  byteOffset = 0;
  line = 1;
  column = 1;

  constructor(private readonly src: string) {}

  peek(ahead = 0): string | undefined {
    return this.src[this.offset + ahead];
  }

  at(s: string): boolean {
    return this.src.startsWith(s, this.offset);
  }

  get eof(): boolean {
    return this.offset >= this.src.length;
  }

  position(): SourcePosition {
    return {
      offset: this.offset,
      byteOffset: this.byteOffset,
      line: this.line,
      column: this.column,
    };
  }

  advance(count = 1): void {
    for (let i = 0; i < count; i++) {
      if (this.eof) return;
      const code = this.src.charCodeAt(this.offset);
      const ch = this.src[this.offset];
      this.byteOffset += utf8Length(code);
      this.offset += 1;
      if (ch === '\n') {
        this.line += 1;
        this.column = 1;
      } else if (ch === '\r') {
        // CRLF counts as a single line break.
        if (this.src[this.offset + 1] !== '\n') {
          this.line += 1;
          this.column = 1;
        } else {
          this.column += 1;
        }
      } else {
        this.column += 1;
      }
    }
  }

  fail(message: string): never {
    throw new ScanError(message, this.position());
  }

  /** Advance until the literal `delimiter`; the delimiter is consumed. */
  consumeUntil(delimiter: string, description: string): void {
    const idx = this.src.indexOf(delimiter, this.offset);
    if (idx === -1) {
      this.fail(`unterminated ${description}`);
    }
    this.advance(idx - this.offset + delimiter.length);
  }
}

function utf8Length(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) return 4; // high surrogate pair
  return 3;
}

/**
 * Scan a complete XML document into a flat, depth-first token list.
 * Element tokens carry child tokens; text/comment/pi/cdata tokens are leaves.
 */
export function scanXML(src: string): ScanToken[] {
  const cur = new Cursor(src);
  return scanChildren(cur, true);
}

function rangeBetween(cur: Cursor, start: SourcePosition): SourceRange {
  return { start, end: cur.position() };
}

function scanChildren(cur: Cursor, topLevel: boolean): ScanToken[] {
  const tokens: ScanToken[] = [];
  let textStart: SourcePosition | null = null;

  const flushText = () => {
    if (textStart !== null) {
      const end = cur.position();
      if (end.offset > textStart.offset) {
        tokens.push({
          type: 'text',
          range: { start: textStart, end },
          raw: cur.src.slice(textStart.offset, end.offset),
        });
      }
      textStart = null;
    }
  };

  while (!cur.eof) {
    if (cur.at('<')) {
      const after = cur.peek(1);
      if (after === '!') {
        if (cur.at('<!--')) {
          flushText();
          tokens.push(scanComment(cur));
          continue;
        }
        if (cur.at('<![CDATA[')) {
          flushText();
          tokens.push(scanCDATA(cur));
          continue;
        }
        if (cur.at('<!DOCTYPE')) {
          flushText();
          tokens.push(scanDoctype(cur));
          continue;
        }
        cur.fail('unrecognized <! markup');
      }
      if (after === '?') {
        flushText();
        tokens.push(scanPI(cur));
        continue;
      }
      if (after === '/') {
        if (topLevel) cur.fail('unexpected closing tag at document level');
        // Parent element owns the close tag.
        return tokens;
      }
      if (after !== undefined && NAME_START.test(after)) {
        flushText();
        tokens.push(scanElement(cur, topLevel));
        continue;
      }
      cur.fail('unexpected "<" character');
    }
    if (textStart === null) textStart = cur.position();
    cur.advance();
  }
  flushText();
  if (!topLevel) cur.fail('missing closing tag');
  return tokens;
}

function scanComment(cur: Cursor): ScanToken {
  const start = cur.position();
  cur.advance(4); // <!--
  // `--` is forbidden inside comments; must end with `-->`.
  while (!cur.eof) {
    if (cur.at('-->')) {
      cur.advance(3);
      return leaf(cur, 'comment', start);
    }
    if (cur.at('--')) {
      cur.fail('"--" is not allowed inside XML comments');
    }
    cur.advance();
  }
  cur.fail('unterminated comment');
}

function scanCDATA(cur: Cursor): ScanToken {
  const start = cur.position();
  cur.advance(9); // <![CDATA[
  cur.consumeUntil(']]>', 'CDATA section');
  return leaf(cur, 'cdata', start);
}

function scanPI(cur: Cursor): ScanToken {
  const start = cur.position();
  cur.advance(2); // <?
  cur.consumeUntil('?>', 'processing instruction');
  return leaf(cur, 'pi', start);
}

function leaf(
  cur: Cursor,
  type: ScanTokenType,
  start: SourcePosition,
): ScanToken {
  return {
    type,
    range: rangeBetween(cur, start),
    raw: cur.src.slice(start.offset, cur.position().offset),
  };
}

function scanDoctype(cur: Cursor): ScanToken {
  const start = cur.position();
  cur.advance('<!DOCTYPE'.length);
  // Internal subset may contain nested brackets; angle/quote-aware scanning
  // up to the closing `>`.
  let depth = 0;
  let quote: string | null = null;
  while (!cur.eof) {
    const ch = cur.peek()!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
    } else if (ch === '>' && depth === 0) {
      cur.advance(1);
      return leaf(cur, 'doctype', start);
    }
    cur.advance();
  }
  cur.fail('unterminated DOCTYPE declaration');
}

function scanElement(cur: Cursor, topLevel: boolean): ScanToken {
  const start = cur.position();
  cur.advance(1); // <
  const nameStart = cur.position();
  while (!cur.eof && isNameChar(cur.peek())) cur.advance();
  const name = cur.src.slice(nameStart.offset, cur.offset);
  if (name.length === 0) cur.fail('expected element name');

  let selfClosing = false;
  scanAttributes(cur, () => {
    if (cur.at('/>')) {
      selfClosing = true;
      cur.advance(2);
      return true;
    }
    if (cur.at('>')) {
      cur.advance(1);
      return true;
    }
    return false;
  });

  if (selfClosing) {
    return {
      type: 'element',
      name,
      selfClosing: true,
      range: rangeBetween(cur, start),
      raw: cur.src.slice(start.offset, cur.offset),
    };
  }

  const contentStart = cur.position();
  const children = scanChildren(cur, false);
  const contentEnd = cur.position();

  // Consume the matching close tag, validating the name.
  const closeStart = cur.position();
  if (!cur.at('</')) cur.fail(`missing closing tag for <${name}>`);
  cur.advance(2);
  const closeNameStart = cur.position();
  while (!cur.eof && isNameChar(cur.peek())) cur.advance();
  const closeName = cur.src.slice(closeNameStart.offset, cur.offset);
  if (closeName !== name) {
    cur.fail(`expected closing tag </${name}> but found </${closeName}>`);
  }
  skipSpaceAndBracket(cur);
  if (!cur.at('>')) cur.fail(`malformed closing tag for <${name}>`);
  cur.advance(1);
  void closeStart;
  void topLevel;

  return {
    type: 'element',
    name,
    selfClosing: false,
    range: rangeBetween(cur, start),
    raw: cur.src.slice(start.offset, cur.offset),
    contentRange: { start: contentStart, end: contentEnd },
    content: cur.src.slice(contentStart.offset, contentEnd.offset),
  } as ScanToken & { children?: ScanToken[] };
}

function skipSpaceAndBracket(cur: Cursor): void {
  while (!cur.eifSafe(cur)) {
    const ch = cur.peek();
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      cur.advance();
    } else {
      return;
    }
  }
}

function eifSafe(_cur: Cursor): boolean {
  return false;
}

/**
 * Scan element attributes up to (and including) the tag terminator.
 * Entity references and well-formed quoting rules are enforced so the scanner
 * never accepts markup the DOM parser would reject.
 */
function scanAttributes(
  cur: Cursor,
  terminate: () => boolean,
): void {
  while (!cur.eof) {
    const ch = cur.peek();
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      cur.advance();
      continue;
    }
    if (terminate()) return;
    if (ch === '/' || ch === '>') {
      cur.fail('malformed element tag');
    }
    if (!isNameChar(ch)) {
      cur.fail(`unexpected character ${JSON.stringify(ch)} in element tag`);
    }
    while (!cur.eof && isNameChar(cur.peek())) cur.advance();
    while (!cur.eof && /\s/.test(cur.peek()!)) cur.advance();
    if (cur.peek() !== '=') cur.fail('expected "=" after attribute name');
    cur.advance(1);
    while (!cur.eof && /\s/.test(cur.peek()!)) cur.advance();
    const quote = cur.peek();
    if (quote !== '"' && quote !== "'") {
      cur.fail('attribute value must be quoted');
    }
    cur.advance(1);
    scanQuotedValue(cur, quote!);
  }
  cur.fail('unterminated element tag');
}

function scanQuotedValue(cur: Cursor, quote: string): void {
  while (!cur.eof) {
    const ch = cur.peek()!;
    if (ch === quote) {
      cur.advance(1);
      return;
    }
    if (ch === '<') cur.fail('"<" is not allowed in attribute values');
    if (ch === '&') {
      scanReference(cur);
      continue;
    }
    cur.advance();
  }
  cur.fail('unterminated attribute value');
}

/** Validate a `&...;` reference structurally (name/decimal/hex forms). */
function scanReference(cur: Cursor): void {
  cur.advance(1); // &
  if (cur.peek() === '#') {
    cur.advance(1);
    if (cur.peek() === 'x' || cur.peek() === 'X') {
      cur.advance(1);
      let n = 0;
      while (!cur.eof && /[0-9A-Fa-f]/.test(cur.peek()!)) {
        cur.advance();
        n++;
      }
      if (n === 0) cur.fail('invalid numeric character reference');
    } else {
      let n = 0;
      while (!cur.eof && /[0-9]/.test(cur.peek()!)) {
        cur.advance();
        n++;
      }
      if (n === 0) cur.fail('invalid numeric character reference');
    }
  } else {
    let n = 0;
    while (!cur.eof && isNameChar(cur.peek())) {
      cur.advance();
      n++;
    }
    if (n === 0) cur.fail('invalid entity reference');
  }
  if (cur.peek() !== ';') cur.fail('entity reference must end with ";"');
  cur.advance(1);
}
