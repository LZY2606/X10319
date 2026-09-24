import { describe, it, expect } from 'vitest';
import {
  parse,
  build,
  parseLossless,
  createEditPlan,
  applyEditPlan,
  findNode,
  dictEntries,
} from '../src/index.js';

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

function plistXml(body: string): string {
  return `${HEADER}<plist version="1.0">${body}</plist>`;
}

/** Deterministic PRNG (mulberry32) so the property run never depends on Math.random(). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('lossless plist: deterministic order, idempotency and isolation', () => {
  const xml = plistXml(
    '<dict><key>a</key><string>one</string><key>b</key><string>two</string></dict>',
  );
  const doc = parseLossless(xml);

  it('order: edit plans do not depend on the enumeration order in which edits are passed', () => {
    const a = findNode(doc, ['a']);
    const b = findNode(doc, ['b']);
    const planForward = createEditPlan(doc, [
      { start: a.span.start, end: a.span.end, replacement: '<string>1</string>' },
      { start: b.span.start, end: b.span.end, replacement: '<string>2</string>' },
    ]);
    const planReversed = createEditPlan(doc, [
      { start: b.span.start, end: b.span.end, replacement: '<string>2</string>' },
      { start: a.span.start, end: a.span.end, replacement: '<string>1</string>' },
    ]);
    expect(planReversed).toEqual(planForward);
    expect(planForward.edits.map((edit) => edit.start)).toEqual([a.span.start, b.span.start]);
    expect(applyEditPlan(planReversed, xml)).toBe(applyEditPlan(planForward, xml));
  });

  it('idempotency: applying the same frozen plan repeatedly yields the same result without mutating inputs', () => {
    const plan = createEditPlan(doc, [
      { ...findNode(doc, ['a']).span, replacement: '<string>x</string>' },
    ]);
    const once = applyEditPlan(plan, xml);
    expect(applyEditPlan(plan, xml)).toBe(once);
    expect(applyEditPlan(plan, xml)).toBe(once);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.edits)).toBe(true);
    expect(Object.isFrozen(doc)).toBe(true);
  });

  it('isolation: concurrent interleaved executions on shared inputs produce independent identical results', async () => {
    const other = plistXml('<array><integer>1</integer><integer>2</integer></array>');
    const workers = Array.from({ length: 8 }, (_, worker) => async () => {
      // Interleave the two documents and randomize work ordering per worker.
      const tasks = [
        () => {
          const d = parseLossless(xml);
          return applyEditPlan(createEditPlan(d, [{ ...findNode(d, ['b']).span, replacement: '<string>z</string>' }]), xml);
        },
        () => {
          const d = parseLossless(other);
          return applyEditPlan(createEditPlan(d, [{ ...findNode(d, [0]).span, replacement: '<integer>9</integer>' }]), other);
        },
      ];
      if (worker % 2 === 1) tasks.reverse();
      const [r1, r2] = await Promise.all(tasks.map((task) => Promise.resolve().then(task)));
      return worker % 2 === 1 ? [r2, r1] : [r1, r2];
    });
    const results = await Promise.all(workers.map((worker) => worker()));
    for (const result of results.slice(1)) {
      expect(result).toEqual(results[0]);
    }
    // Every reparse of shared input remains byte-identical.
    const reparsed = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => parseLossless(xml).digest)),
    );
    expect(new Set(reparsed).size).toBe(1);
  });

  it('failure atomicity: rejected calls leave no cache, counter or temporary state behind', () => {
    const before = parseLossless(xml);
    const failures: Array<() => void> = [
      () => applyEditPlan(createEditPlan(before, [{ ...findNode(before, ['a']).span, replacement: '<string>x</string>' }]), xml + ' '),
      () => parseLossless(plistXml('<dict><key>a</key><nope/></dict>')),
      () => findNode(before, ['missing']),
      () => createEditPlan(before, [{ start: 5, end: 2, replacement: 'x' }]),
    ];
    for (const failNow of failures) {
      expect(failNow).toThrow();
    }
    const after = parseLossless(xml);
    expect(after.digest, 'digest is stable after failures').toBe(before.digest);
    expect(after.value, 'semantic value is stable after failures').toEqual(before.value);
    expect(after, 'full metadata is stable after failures').toEqual(before);

    const plan = createEditPlan(after, [{ ...findNode(after, ['a']).span, replacement: '<string>x</string>' }]);
    expect(applyEditPlan(plan, xml), 'a plan still applies identically after failures').toBe(
      applyEditPlan(createEditPlan(before, [{ ...findNode(before, ['a']).span, replacement: '<string>x</string>' }]), xml),
    );
  });

  it('order: dict entry order follows document order, including duplicates, never map enumeration', () => {
    const body =
      '<dict><key>zebra</key><integer>1</integer><key>apple</key><integer>2</integer>' +
      '<key>mango</key><integer>3</integer><key>zebra</key><integer>4</integer></dict>';
    const ordered = parseLossless(plistXml(body));
    const entries = dictEntries(ordered, findNode(ordered, []));
    expect(entries.map((entry) => entry.key)).toEqual(['zebra', 'apple', 'mango', 'zebra']);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
  });

  it('property (seed=0x20260924, budget=40): unrelated trivia permutations never move spans or semantics, and reruns are identical', () => {
    const SEED = 0x20260924;
    const BUDGET = 40;
    const random = mulberry32(SEED);
    const template = plistXml(
      '<dict><key>k</key><string>stable</string><key>n</key><integer>7</integer></dict>',
    );
    // The regular parser only ignores whitespace and comments between
    // elements; processing instructions are legal only in the prolog/epilog.
    const innerPoints: number[] = [];
    const anchor = '<plist version="1.0">';
    innerPoints.push(template.indexOf(anchor) + anchor.length);
    for (const match of template.matchAll(/></g)) {
      innerPoints.push(match.index as number + 1);
    }
    const prologPoint = template.indexOf('<plist');
    const epilogPoint = template.indexOf('</plist>') + '</plist>'.length;
    const triviaChoices = ['', ' ', '\t', '\n', '\r\n', '<!-- c -->', '\r\n  '];
    const prologChoices = ['', '<?p x?>', '<!-- prolog c -->', '\r\n'];

    const baseline = parseLossless(template);
    for (let iteration = 0; iteration < BUDGET; iteration += 1) {
      let generated = template;
      const insertions: Array<{ at: number; text: string }> = [];
      for (const point of innerPoints) {
        const text = triviaChoices[Math.floor(random() * triviaChoices.length)];
        if (text) insertions.push({ at: point, text });
      }
      const prologText = prologChoices[Math.floor(random() * prologChoices.length)];
      if (prologText) insertions.push({ at: prologPoint, text: prologText });
      if (random() < 0.5) insertions.push({ at: epilogPoint, text: '\r\n<!-- epilog c -->' });
      for (const insertion of insertions.sort((x, y) => y.at - x.at)) {
        generated = generated.slice(0, insertion.at) + insertion.text + generated.slice(insertion.at);
      }

      const first = parseLossless(generated);
      expect(first.value, `iteration ${iteration}: semantics changed`).toEqual(baseline.value);
      const second = parseLossless(generated);
      expect(second.digest, `iteration ${iteration}: digest unstable`).toBe(first.digest);
      expect(second, `iteration ${iteration}: metadata unstable`).toEqual(first);
    }
  });

  it('contract guard: default parse/build stay byte-identical interleaved with lossless operations', () => {
    const expectedBuild =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n  <dict>\n    <key>a</key>\n    <integer>1</integer>\n  </dict>\n</plist>';
    const source = plistXml('<dict><key>a</key><integer>1</integer></dict>');

    expect(parse(source)).toEqual({ a: 1 });
    expect(build({ a: 1 })).toBe(expectedBuild);

    const losslessDoc = parseLossless(source);
    const edited = applyEditPlan(
      createEditPlan(losslessDoc, [{ ...findNode(losslessDoc, ['a']).span, replacement: '<integer>2</integer>' }]),
      source,
    );
    expect(parse(edited)).toEqual({ a: 2 });
    expect(build({ a: 1 })).toBe(expectedBuild);
    expect(parse(source)).toEqual({ a: 1 });
  });
});
