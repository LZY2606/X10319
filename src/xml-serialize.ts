/**
 * Primitive XML serialization shared by the browser `build()` path and
 * by the lossless edit planner. This is production logic, not a test
 * helper: local replacements produced by `planEdit()` are escaped and
 * classified with exactly the same rules as a full document build.
 */

import type { PlistValue } from './xml-elements.js';

/**
 * Encode a Uint8Array into a base64 string.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function escapeXmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function plistDateText(value: Date): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export type SerializedPlist = { tag: string; text: string | null };

/**
 * Map one scalar/plist value to the plist tag and escaped inner text
 * that a builder would emit for it. `null` text means a self closing
 * tag (`<true/>`, `<false/>`, `<null/>`). Container values are not
 * handled here.
 */
export function serializeScalarPlist(
  value: PlistValue,
): SerializedPlist | null {
  if (typeof value === 'undefined') {
    return null;
  }
  if (value instanceof Date) {
    return { tag: 'date', text: plistDateText(value) };
  }
  if (typeof value === 'boolean') {
    return { tag: value ? 'true' : 'false', text: null };
  }
  if (value === null) {
    return { tag: 'null', text: null };
  }
  if (typeof value === 'number') {
    const tag = value % 1 === 0 ? 'integer' : 'real';
    return { tag, text: value.toString() };
  }
  if (typeof value === 'bigint') {
    return { tag: 'integer', text: value.toString() };
  }
  if (typeof value === 'string') {
    return { tag: 'string', text: escapeXmlText(value) };
  }
  if (value instanceof ArrayBuffer) {
    return {
      tag: 'data',
      text: uint8ArrayToBase64(new Uint8Array(value)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
    return { tag: 'data', text: uint8ArrayToBase64(bytes) };
  }
  return null;
}

/**
 * Serialize a single plist element (including nested containers)
 * without indentation. Used by the lossless edit planner; the result
 * is a compact fragment that replaces the original element while
 * every unmodified byte around it is preserved.
 */
export function serializePlistFragment(value: PlistValue): string {
  const scalar = serializeScalarPlist(value);
  if (scalar !== null) {
    if (scalar.text === null) {
      return '<' + scalar.tag + '/>';
    }
    return '<' + scalar.tag + '>' + scalar.text + '</' + scalar.tag + '>';
  }
  if (Array.isArray(value)) {
    const parts: string[] = ['<array>'];
    for (const item of value) {
      parts.push(serializePlistFragment(item));
    }
    parts.push('</array>');
    return parts.join('');
  }
  if (typeof value === 'object' && value !== null) {
    const parts: string[] = ['<dict>'];
    for (const name of Object.keys(value)) {
      const item = value[name];
      // undefined and null entries are skipped, mirroring build()
      if (item === undefined || item === null) {
        continue;
      }
      parts.push('<key>' + escapeXmlText(name) + '</key>');
      parts.push(serializePlistFragment(item));
    }
    parts.push('</dict>');
    return parts.join('');
  }
  // null/undefined top level values emit nothing, mirroring build()
  return '';
}
