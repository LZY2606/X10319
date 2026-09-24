/**
 * Browser replacement for `xml-dom.ts`: delegates to the global `DOMParser`
 * instead of bundling `@xmldom/xmldom`. The semantic walker is re-exported
 * unchanged so Node and browser share one code path.
 */
export {
  base64ToUint8Array,
  parsePlistXML,
  invariant,
} from './xml-dom.js';
export type { PlistValue, XMLParseHandler } from './xml-dom.js';

export function parseXMLDocument(
  xml: string,
  _handler?: { onError?: (level: string, message: string) => void },
): Document {
  return new DOMParser().parseFromString(xml, 'text/xml');
}
