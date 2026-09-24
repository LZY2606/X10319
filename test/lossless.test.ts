import { describe, it, expect } from 'vitest';
import {
  parse,
  build,
  LosslessPlistError,
  parseLossless,
  digestSource,
  sliceSource,
  innerText,
  findNode,
  dictEntries,
  elementChildren,
  createEditPlan,
  applyEditPlan,
} from '../src/index.js';
import type {
  LosslessPlistDocument,
  LosslessNode,
  EditPlan,
} from '../src/index.js';

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

function xmlPlist(body: string, prolog = ''): string {
  return `${prolog}${HEADER}<plist version="1.0">${body}</plist>`;
}

/**
 * First-violation evidence helper: applying `plan` to `source` must throw,
 * and the error must identify what was wrong deterministically.
 */
function expectMismatch(plan: EditPlan, source: string): LosslessPlistError {
  try {
    applyEditPlan(plan, source);
  } catch (error) {
    expect(error).toBeInstanceOf(LosslessPlistError);
    return error as LosslessPlistError;
  }
  throw new Error('applyEditPlan() did not throw on a mismatched source');
}

/**
 * Format-preservation invariant: replacing one span must leave every byte
 * outside that span untouched.
 */
function expectUnmodifiedAround(
  source: string,
  next: string,
  span: { start: number; end: number },
  replacement: string,
): void {
  expect(next.slice(0, span.start), 'bytes before the replaced span').toBe(
    source.slice(0, span.start),
  );
  expect(next.slice(span.start + replacement.length), 'bytes after the replaced span').toBe(
    source.slice(span.end),
  );
}

describe('lossless plist: fixed-input format-preservation contracts', () => {
  it('contract: comments and processing instructions are kept with exact spans and survive a local edit', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?generator pairwise-gsb?>',
      '<!-- leading comment -->',
      '<plist version="1.0">',
      '<dict>',
      '\t<!-- inside the dict -->',
      '\t<key>name</key>',
      '\t<string>ok</string>',
      '</dict>',
      '</plist>',
      '<!-- trailing comment -->',
    ].join('\n');

    const doc = parseLossless(xml);
    expect(doc.value).toEqual({ name: 'ok' });

    const pis = doc.prolog.filter(
      (child) => child.kind === 'pi' && !child.raw.startsWith('<?xml'),
    );
    const comments = [...doc.prolog, ...doc.epilog].filter(
      (child) => child.kind === 'comment',
    );
    expect(
      doc.prolog.some((child) => child.kind === 'pi' && child.raw.startsWith('<?xml')),
      'the XML declaration is retained as a PI too',
    ).toBe(true);
    expect(pis.map((item) => item.raw)).toEqual(['<?generator pairwise-gsb?>']);
    expect(comments.map((item) => item.raw)).toEqual([
      '<!-- leading comment -->',
      '<!-- trailing comment -->',
    ]);
    for (const trivia of [...pis, ...comments]) {
      expect(sliceSource(doc, trivia.span), 'trivia span is exact').toBe(trivia.raw);
    }
    const dict = findNode(doc, []);
    const innerComment = dict.children.find((child) => child.kind === 'comment');
    expect(innerComment?.raw).toBe('<!-- inside the dict -->');

    const stringNode = findNode(doc, ['name']);
    const replacement = '<string>done</string>';
    const next = applyEditPlan(planReplaceNode(doc, stringNode, replacement), xml);
    expect(parse(next)).toEqual({ name: 'done' });
    expectUnmodifiedAround(xml, next, stringNode.span, replacement);
    for (const raw of [...pis.map((p) => p.raw), ...comments.map((c) => c.raw)]) {
      expect(next, 'comments and PIs survive editing').toContain(raw);
    }
  });

  it('contract: duplicate keys keep document order and are never normalized or collapsed', () => {
    const xml = xmlPlist(
      '<dict><key>a</key><integer>1</integer><key>a</key><integer>2</integer></dict>',
    );
    const doc = parseLossless(xml);
    // Existing parser semantics are unchanged: the last duplicate wins.
    expect(doc.value).toEqual({ a: 2 });

    const entries = dictEntries(doc, findNode(doc, []));
    expect(entries.length, 'both duplicates survive in metadata').toBe(2);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(entries.map((entry) => entry.key)).toEqual(['a', 'a']);
    expect(innerText(doc, entries[0].valueNode as LosslessNode)).toBe('1');
    expect(innerText(doc, entries[1].valueNode as LosslessNode)).toBe('2');

    const second = entries[1].valueNode as LosslessNode;
    const replacement = '<integer>9</integer>';
    const next = applyEditPlan(planReplaceNode(doc, second, replacement), xml);
    expect(parse(next)).toEqual({ a: 9 });
    expectUnmodifiedAround(xml, next, second.span, replacement);

    // Editing the first duplicate leaves the semantic value at the last one.
    const first = entries[0].valueNode as LosslessNode;
    const next2 = applyEditPlan(planReplaceNode(doc, first, replacement), xml);
    expect(parse(next2)).toEqual({ a: 2 });
    expectUnmodifiedAround(xml, next2, first.span, replacement);
  });

  it('contract: self-closing nodes keep empty inner spans and stay editable', () => {
    const xml = xmlPlist(
      '<dict><key>empty</key><string/><key>flag</key><true/><key>list</key><array/></dict>',
    );
    const doc = parseLossless(xml);
    expect(doc.value).toEqual({ empty: '', flag: true, list: [] });

    const selfClosingNodes = elementChildren(findNode(doc, []));
    expect(selfClosingNodes.map((node) => node.name)).toEqual(['key', 'string', 'key', 'true', 'key', 'array']);
    const stringNode = findNode(doc, ['empty']);
    expect(stringNode.selfClosing).toBe(true);
    expect(stringNode.inner.start).toBe(stringNode.inner.end);

    const replacement = '<string>filled</string>';
    const next = applyEditPlan(planReplaceNode(doc, stringNode, replacement), xml);
    expect(parse(next)).toEqual({ empty: 'filled', flag: true, list: [] });
    expectUnmodifiedAround(xml, next, stringNode.span, replacement);
  });

  it('contract: entities retain raw scalar spelling (including unknown entities) and edits reparse correctly', () => {
    const xml = xmlPlist(
      '<dict><key>k</key><string>a &amp; b &lt;c&gt;</string><key>u</key><string>x &bogus; y</string></dict>',
    );
    const doc = parseLossless(xml);
    expect(doc.value).toMatchObject({ k: 'a & b <c>' });

    const known = findNode(doc, ['k']);
    const unknown = findNode(doc, ['u']);
    expect(innerText(doc, known), 'known entities are not normalized away').toBe(
      'a &amp; b &lt;c&gt;',
    );
    expect(innerText(doc, unknown), 'unknown entities stay verbatim').toBe('x &bogus; y');

    const replacement = '<string>p &lt; q</string>';
    const next = applyEditPlan(planReplaceNode(doc, known, replacement), xml);
    expect(parse(next)).toMatchObject({ k: 'p < q', u: 'x &bogus; y' });
    expectUnmodifiedAround(xml, next, known.span, replacement);
  });

  it('contract: CRLF whitespace is preserved in metadata and outside the edited span', () => {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>line</key>',
      '\t<string>unix</string>',
      '</dict>',
      '</plist>',
    ];
    const xml = lines.join('\r\n');
    const doc = parseLossless(xml);
    expect(doc.value).toEqual({ line: 'unix' });
    expect(doc.digest).toBe(digestSource(xml));

    const crlfTrivia = doc.root.children.find((child) => child.kind === 'text');
    expect(crlfTrivia?.raw).toContain('\r\n');

    const stringNode = findNode(doc, ['line']);
    const replacement = '<string>dos</string>';
    const next = applyEditPlan(planReplaceNode(doc, stringNode, replacement), xml);
    expect(parse(next)).toEqual({ line: 'dos' });
    expectUnmodifiedAround(xml, next, stringNode.span, replacement);
    expect(next.split('\r\n').length, 'CRLF count is unchanged').toBe(xml.split('\r\n').length);
  });

  it('contract: <data> line breaks are raw in metadata while the semantic value is base64', () => {
    const xml = xmlPlist('<dict><key>blob</key><data>\n\tQUJD\n\tRA==\n</data></dict>');
    const doc = parseLossless(xml);
    const bytes = doc.value as { blob: Uint8Array };
    expect(Array.from(bytes.blob)).toEqual([65, 66, 67, 68]);

    const dataNode = findNode(doc, ['blob']);
    expect(innerText(doc, dataNode)).toBe('\n\tQUJD\n\tRA==\n');

    const replacement = '<data>AA==</data>';
    const next = applyEditPlan(planReplaceNode(doc, dataNode, replacement), xml);
    expect(Array.from((parse(next) as { blob: Uint8Array }).blob)).toEqual([0]);
    expectUnmodifiedAround(xml, next, dataNode.span, replacement);
  });

  it('contract: emoji ranges stay on code-point boundaries and edits never split surrogate pairs', () => {
    const xml = xmlPlist('<dict><key>face</key><string>🍎 ok 😀</string></dict>');
    const doc = parseLossless(xml);
    expect(doc.value).toEqual({ face: '🍎 ok 😀' });

    const stringNode = findNode(doc, ['face']);
    expect(stringNode.span.start).toBe(xml.indexOf('<string>🍎 ok 😀</string>'));
    expect(sliceSource(doc, stringNode.span)).toBe('<string>🍎 ok 😀</string>');

    const replacement = '<string>🍏</string>';
    const next = applyEditPlan(planReplaceNode(doc, stringNode, replacement), xml);
    expect(parse(next)).toEqual({ face: '🍏' });
    expectUnmodifiedAround(xml, next, stringNode.span, replacement);
    for (let i = 0; i < next.length; i += 1) {
      expect(isSurrogateStart(next, i) ? next[i + 1] !== undefined : true).toBe(true);
    }
  });

  it('contract: applying a plan to a changed source fails with digest-mismatch evidence and is repeatable', () => {
    const xml = xmlPlist('<dict><key>n</key><integer>1</integer></dict>');
    const doc = parseLossless(xml);
    const plan = planReplaceNode(doc, findNode(doc, ['n']), '<integer>2</integer>');

    const tampered = xml.replace('<integer>1</integer>', '<integer>11</integer>');
    const error1 = expectMismatch(plan, tampered);
    expect(error1.code).toBe('DIGEST_MISMATCH');
    expect(error1.message).toContain(plan.digest);
    expect(error1.message).toContain(digestSource(tampered));
    expect(error1).toBeInstanceOf(Error);

    // Reproducible: the exact same failing input yields the exact same result.
    const error2 = expectMismatch(plan, tampered);
    expect(error2.message).toBe(error1.message);

    // Recoverable: the same plan applied to the matching source still works.
    const next = applyEditPlan(plan, xml);
    expect(parse(next)).toEqual({ n: 2 });
  });

  it('contract: unknown elements are rejected through the existing Error layer, naming the first offending offset', () => {
    const xml = xmlPlist('<dict><key>a</key><foo/></dict>');
    const expectedOffset = xml.indexOf('<foo/>');
    const run = (): LosslessPlistDocument => parseLossless(xml);
    expect(run).toThrow(LosslessPlistError);
    try {
      run();
    } catch (error) {
      const typed = error as LosslessPlistError;
      expect(typed).toBeInstanceOf(Error);
      expect(typed.code).toBe('UNKNOWN_ELEMENT');
      expect(typed.offset).toBe(expectedOffset);
      expect(typed.message).toContain('offset=' + expectedOffset);
      expect(run, 'rejection is deterministic').toThrow(typed.message);
    }
  });

  it('contract: malformed nesting is rejected instead of being repaired silently', () => {
    const xml = xmlPlist('<dict></plist>');
    try {
      parseLossless(xml);
    } catch (error) {
      const typed = error as LosslessPlistError;
      expect(typed).toBeInstanceOf(LosslessPlistError);
      expect(typed.code).toBe('MISMATCHED_TAG');
      expect(typed.offset).toBe(xml.indexOf('</plist>'));
      return;
    }
    throw new Error('mismatched tags were silently accepted');
  });
});

function isSurrogateStart(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function planReplaceNode(
  doc: LosslessPlistDocument,
  node: LosslessNode,
  replacement: string,
): EditPlan {
  return createEditPlan(doc, [
    { start: node.span.start, end: node.span.end, replacement },
  ]);
}

/**
 * End-to-end acceptance story through the public entry points only:
 *
 * 1. losslessly parse a document containing every format-preservation feature;
 * 2. plan and apply one local edit per feature and re-parse with the regular parser;
 * 3. mid-story, inject a recoverable failure (plan applied to tampered source);
 * 4. prove default parse/build behavior and no shared-state residue;
 * 5. retry the exact same inputs and compare against the recorded results.
 */
describe('acceptance story: lossless XML parse and format-preserving edit plans', () => {
  const storyXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?story pi?>',
    '<!-- story comment -->',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>name</key>',
    '\t<string>apple &amp; pear</string>',
    '\t<key>dup</key>',
    '\t<integer>1</integer>',
    '\t<key>dup</key>',
    '\t<integer>2</integer>',
    '\t<key>flag</key>',
    '\t<true/>',
    '\t<key>blob</key>',
    '\t<data>',
    '\t\tQUJD',
    '\t\tRA==',
    '\t</data>',
    '\t<key>emoji</key>',
    '\t<string>🍎</string>',
    '</dict>',
    '</plist>',
    '<!-- end -->',
  ].join('\r\n');

  interface StoryRecord {
    digest: string;
    value: unknown;
    keyOrder: string[];
    rawSpellings: Record<string, string>;
    outputs: string[];
  }

  const record: Partial<StoryRecord> = {};

  it('step 1: parses losslessly and records caller-visible result plus internal invariants', () => {
    const doc = parseLossless(storyXml);
    expect(doc.value).toEqual({
      name: 'apple & pear',
      dup: 2,
      flag: true,
      blob: expect.any(Uint8Array),
      emoji: '🍎',
    });
    const entries = dictEntries(doc, findNode(doc, []));
    record.digest = doc.digest;
    record.value = doc.value;
    record.keyOrder = entries.map((entry) => entry.key);
    record.rawSpellings = {
      name: innerText(doc, entries[0].valueNode as LosslessNode),
      firstDup: innerText(doc, entries[1].valueNode as LosslessNode),
      secondDup: innerText(doc, entries[2].valueNode as LosslessNode),
    };
    record.outputs = [];

    expect(record.keyOrder).toEqual(['name', 'dup', 'dup', 'flag', 'blob', 'emoji']);
    expect(record.rawSpellings.name).toBe('apple &amp; pear');
    expect(record.rawSpellings.firstDup).toBe('1');
    expect(record.rawSpellings.secondDup).toBe('2');
    expect(innerText(doc, findNode(doc, ['blob']))).toContain('\r\n\t\tQUJD');
    expect(sliceSource(doc, findNode(doc, ['emoji']).span)).toBe('<string>🍎</string>');
    expect(doc.prolog.some((child) => child.kind === 'pi' && child.raw === '<?story pi?>')).toBe(true);
    expect(doc.prolog.some((child) => child.kind === 'comment' && child.raw === '<!-- story comment -->')).toBe(true);
  });

  it('step 2: plans and applies local edits for every feature; the regular parser sees the expected values', () => {
    const doc = parseLossless(storyXml);
    const secondDupNode = (): LosslessNode => {
      const duplicates = dictEntries(doc, findNode(doc, [])).filter(
        (entry) => entry.key === 'dup',
      );
      return duplicates[1].valueNode as LosslessNode;
    };
    const cases: Array<{ label: string; node: () => LosslessNode; replacement: string; expected: (value: unknown) => void }> = [
      {
        label: 'comment+PI surrounding edit',
        node: () => findNode(doc, ['name']),
        replacement: '<string>changed</string>',
        expected: (value) => expect((value as { name: string }).name).toBe('changed'),
      },
      {
        label: 'duplicate key second occurrence',
        node: secondDupNode,
        replacement: '<integer>9</integer>',
        expected: (value) => expect((value as { dup: number }).dup).toBe(9),
      },
      {
        label: 'self-closing node',
        node: () => findNode(doc, ['flag']),
        replacement: '<false/>',
        expected: (value) => expect((value as { flag: boolean }).flag).toBe(false),
      },
      {
        label: 'data with line breaks',
        node: () => findNode(doc, ['blob']),
        replacement: '<data>AA==</data>',
        expected: (value) =>
          expect(Array.from((value as { blob: Uint8Array }).blob)).toEqual([0]),
      },
      {
        label: 'emoji range',
        node: () => findNode(doc, ['emoji']),
        replacement: '<string>🍏</string>',
        expected: (value) => expect((value as { emoji: string }).emoji).toBe('🍏'),
      },
    ];

    for (const testCase of cases) {
      const node = testCase.node();
      const next = applyEditPlan(planReplaceNode(doc, node, testCase.replacement), storyXml);
      expectUnmodifiedAround(storyXml, next, node.span, testCase.replacement);
      testCase.expected(parse(next));
      record.outputs!.push(next);
    }
    expect(record.outputs).toHaveLength(cases.length);
  });

  it('step 3: a mid-story recoverable failure leaves no partial result and no shared state residue', () => {
    const doc = parseLossless(storyXml);
    const plan = planReplaceNode(doc, findNode(doc, ['name']), '<string>x</string>');

    const tampered = storyXml.replace('apple &amp; pear', 'apple &amp; P EAR');
    let output: string | undefined;
    let threw: unknown;
    try {
      output = applyEditPlan(plan, tampered);
    } catch (error) {
      threw = error;
    }
    expect(output, 'no partial output is produced').toBeUndefined();
    expect(threw).toBeInstanceOf(LosslessPlistError);
    expect((threw as LosslessPlistError).code).toBe('DIGEST_MISMATCH');

    // The document object and plan are frozen metadata; the failure cannot mutate them.
    const retryDoc = parseLossless(storyXml);
    expect(retryDoc.digest).toBe(record.digest);
    expect(retryDoc.value).toEqual(record.value);
    expect(dictEntries(retryDoc, findNode(retryDoc, [])).map((entry) => entry.key)).toEqual(
      record.keyOrder,
    );
    // Same input immediately re-applied succeeds with a stable result.
    expect(applyEditPlan(plan, storyXml)).toBe(applyEditPlan(plan, storyXml));
  });

  it('step 4: default parse/build behavior is unchanged after the failure', () => {
    const parsed = parse(
      HEADER + '<plist version="1.0"><dict><key>n</key><integer>3</integer></dict></plist>',
    );
    expect(parsed).toEqual({ n: 3 });
    expect(build('test')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n  <string>test</string>\n</plist>',
    );
  });

  it('step 5: retrying the exact same inputs reproduces the recorded outputs byte for byte', () => {
    const doc = parseLossless(storyXml);
    expect(doc.digest).toBe(record.digest);

    const dupSecond = dictEntries(doc, findNode(doc, []))
      .filter((entry) => entry.key === 'dup')[1]
      .valueNode as LosslessNode;
    const replacements: Array<{ node: LosslessNode; replacement: string }> = [
      { node: findNode(doc, ['name']), replacement: '<string>changed</string>' },
      { node: dupSecond, replacement: '<integer>9</integer>' },
      { node: findNode(doc, ['flag']), replacement: '<false/>' },
      { node: findNode(doc, ['blob']), replacement: '<data>AA==</data>' },
      { node: findNode(doc, ['emoji']), replacement: '<string>🍏</string>' },
    ];
    const retried: string[] = [];
    for (const item of replacements) {
      retried.push(applyEditPlan(planReplaceNode(doc, item.node, item.replacement), storyXml));
    }
    expect(retried).toEqual(record.outputs);
  });
});
