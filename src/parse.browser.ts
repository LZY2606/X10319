import { parseBinary } from './parse-binary.js';
import { parseOpenStep } from './parse-openstep.js';
import {
  invariant,
  parsePlistXML,
  parseXMLDocument,
} from './xml-dom.browser.js';

import type { PlistValue } from './xml-dom.browser.js';
export type { PlistValue };

/**
 * Parses a Plist XML string. Returns an Object.
 *
 * @param xml - the XML String to decode
 * @returns the decoded value from the Plist XML
 */
export function parse(xml: string | Uint8Array | ArrayBuffer): PlistValue {
  // Handle binary plist input
  if (xml instanceof ArrayBuffer) {
    return parseBinary(new Uint8Array(xml));
  }
  if (xml instanceof Uint8Array) {
    return parseBinary(xml);
  }
  if (typeof xml === 'string' && xml.startsWith('bplist')) {
    const encoder = new TextEncoder();
    return parseBinary(encoder.encode(xml));
  }

  // Detect OpenStep/ASCII plist format
  if (typeof xml === 'string') {
    const trimmed = xml.trimStart();
    if (
      (trimmed[0] === '{' || trimmed[0] === '(') &&
      !trimmed.startsWith('<?xml') &&
      !trimmed.startsWith('<!DOCTYPE') &&
      !trimmed.startsWith('<plist')
    ) {
      return parseOpenStep(xml);
    }
  }

  const doc = parseXMLDocument(xml);
  const root = doc.documentElement;
  invariant(
    root !== null && root.nodeName === 'plist',
    'malformed document. First element should be <plist>',
  );
  let plist = parsePlistXML(root as unknown as Node);

  // the root <plist> node gets interpreted as an Array,
  // so pull out the inner data first
  if (Array.isArray(plist) && plist.length == 1) plist = plist[0];

  return plist;
}
