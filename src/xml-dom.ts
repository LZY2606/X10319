/**
 * Node.js XML document parser backed by `@xmldom/xmldom`. The browser
 * build swaps this module for `xml-dom.browser.ts`; both share the walker
 * in `xml-walk.ts`.
 */
import { DOMParser } from '@xmldom/xmldom';
import type { Document } from '@xmldom/xmldom';
export {
  base64ToUint8Array,
  parsePlistXML,
  invariant,
} from './xml-walk.js';
export type { PlistValue } from './xml-walk.js';

export interface XMLParseHandler {
  onError?: (level: 'warning' | 'error' | 'fatalError', message: string) => void;
}

export function parseXMLDocument(
  xml: string,
  handler?: XMLParseHandler,
): Document {
  const parser = handler
    ? new DOMParser({ onError: handler.onError })
    : new DOMParser();
  return parser.parseFromString(xml, 'text/xml');
}
