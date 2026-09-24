import { parseBinary } from './parse-binary.js';
import { parseOpenStep } from './parse-openstep.js';
import {
  assertIsPlistRoot,
  unwrapPlistRoot,
  type PlistValue,
} from './xml-elements.js';

export type { PlistValue } from './xml-elements.js';

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
    return parseBinary(encoder.encode(xml);
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

  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  assertIsPlistRoot(root as unknown as Parameters<typeof assertIsPlistRoot>[0]);

  // the root <plist> node gets interpreted as an Array,
  // so pull out the inner data first
  return unwrapPlistRoot(root as unknown as Parameters<typeof unwrapPlistRoot>[0]);
}
