/**
 * Structural helpers shared by every XML plist parsing entry point
 * (the default DOM based parser, the browser parser and the lossless
 * parser). Keeping the tag semantics in one place means the lossless
 * result and the regular `parse()` result can never disagree about
 * scalar decoding, dict alternation rules or error messages.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue }
  | null;

export const TEXT_NODE = 3;
export const CDATA_NODE = 4;
export const COMMENT_NODE = 8;
export const PROCESSING_INSTRUCTION_NODE = 7;

/**
 * Structural subset of a DOM node that both `@xmldom/xmldom` nodes and
 * the lossless scanner's CST nodes satisfy.
 */
export interface XmlChildLike {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
}

export interface XmlElementLike extends XmlChildLike {
  readonly childNodes: ArrayLike<XmlChildLike>;
}

/**
 * Decode a base64 string into a Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * We ignore raw text (usually whitespace), <!-- xml comments -->,
 * and raw CDATA nodes.
 */
export function shouldIgnoreNode(node: XmlChildLike): boolean {
  return (
    node.nodeType === TEXT_NODE ||
    node.nodeType === COMMENT_NODE ||
    node.nodeType === CDATA_NODE
  );
}

/**
 * Check if the node is empty. Some plist file has such node:
 * <key />
 * this node should be ignored.
 *
 * @see https://github.com/TooTallNate/plist.js/issues/66
 */
export function isEmptyNode(node: XmlElementLike): boolean {
  if (!node.childNodes || node.childNodes.length === 0) {
    return true;
  }
  return false;
}

export function invariant(test: boolean, message: string): asserts test {
  if (!test) {
    throw new Error(message);
  }
}

export function assertIsPlistRoot(
  root: XmlElementLike | null,
): asserts root is XmlElementLike {
  invariant(
    root !== null && root.nodeName === 'plist',
    'malformed document. First element should be <plist>',
  );
}

export interface DictEntryNodes {
  key: XmlElementLike;
  value: XmlElementLike | null;
}

/**
 * Return a dict element's alternating key/value pairs in source order.
 * A trailing key without a value yields an entry whose `value` is null.
 * Comments, text and CDATA are ignored exactly like the regular parser.
 */
export function dictEntryNodes(node: XmlElementLike): DictEntryNodes[] {
  const significant: XmlChildLike[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (!shouldIgnoreNode(child)) {
      significant.push(child);
    }
  }

  const entries: DictEntryNodes[] = [];
  for (let i = 0; i < significant.length; i++) {
    if (i % 2 === 0) {
      invariant(
        significant[i].nodeName === 'key',
        'Missing key while parsing <dict/>.',
      );
    } else {
      invariant(
        significant[i].nodeName !== 'key',
        'Unexpected <key> while parsing <dict/>. Keys and values must alternate.',
      );
      entries.push({
        key: significant[i - 1] as XmlElementLike,
        value: significant[i] as XmlElementLike,
      });
    }
  }
  if (significant.length % 2 === 1) {
    entries.push({
      key: significant[significant.length - 1] as XmlElementLike,
      value: null,
    });
  }
  return entries;
}

/**
 * Convert an XML based plist node into its JSON style value.
 */
export function convertPlistNode(node: XmlElementLike): PlistValue {
  if (!node) return null;

  if (node.nodeName === 'plist') {
    const new_arr: PlistValue[] = [];
    if (isEmptyNode(node)) {
      return new_arr;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (!shouldIgnoreNode(node.childNodes[i])) {
        new_arr.push(convertPlistNode(node.childNodes[i] as XmlElementLike));
      }
    }
    return new_arr;
  } else if (node.nodeName === 'dict') {
    const new_obj: { [key: string]: PlistValue } = {};
    if (isEmptyNode(node)) {
      return new_obj;
    }
    for (const entry of dictEntryNodes(node)) {
      const key = convertPlistNode(entry.key) as string;
      new_obj[key] =
        entry.value === null ? '' : convertPlistNode(entry.value);
    }
    return new_obj;
  } else if (node.nodeName === 'array') {
    const new_arr: PlistValue[] = [];
    if (isEmptyNode(node)) {
      return new_arr;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (!shouldIgnoreNode(node.childNodes[i])) {
        const res = convertPlistNode(node.childNodes[i] as XmlElementLike);
        if (null != res) new_arr.push(res);
      }
    }
    return new_arr;
  } else if (node.nodeName === '#text') {
    // TODO: what should we do with text types? (CDATA sections)
  } else if (node.nodeName === 'key') {
    if (isEmptyNode(node)) {
      return '';
    }

    invariant(
      node.childNodes[0].nodeValue !== '__proto__',
      '__proto__ keys can lead to prototype pollution. More details on CVE-2022-22912',
    );

    return node.childNodes[0].nodeValue;
  } else if (node.nodeName === 'string') {
    let res = '';
    if (isEmptyNode(node)) {
      return res;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const type = node.childNodes[i].nodeType;
      if (type === TEXT_NODE || type === CDATA_NODE) {
        res += node.childNodes[i].nodeValue;
      }
    }
    return res;
  } else if (node.nodeName === 'integer') {
    invariant(!isEmptyNode(node), 'Cannot parse "" as integer.');
    return parseInt(node.childNodes[0].nodeValue!, 10);
  } else if (node.nodeName === 'real') {
    invariant(!isEmptyNode(node), 'Cannot parse "" as real.');
    let res = '';
    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === TEXT_NODE) {
        res += node.childNodes[i].nodeValue;
      }
    }
    return parseFloat(res);
  } else if (node.nodeName === 'data') {
    let res = '';
    if (isEmptyNode(node)) {
      return base64ToUint8Array(res);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === TEXT_NODE) {
        res += node.childNodes[i].nodeValue!.replace(/\s+/g, '');
      }
    }
    return base64ToUint8Array(res);
  } else if (node.nodeName === 'date') {
    invariant(!isEmptyNode(node), 'Cannot parse "" as Date.');
    return new Date(node.childNodes[0].nodeValue!);
  } else if (node.nodeName === 'null') {
    return null;
  } else if (node.nodeName === 'true') {
    return true;
  } else if (node.nodeName === 'false') {
    return false;
  } else {
    throw new Error('Invalid PLIST tag ' + node.nodeName);
  }

  return null;
}

/**
 * The root <plist> node converts to an Array; a single top level value
 * is unwrapped, matching `parse()`.
 */
export function unwrapPlistRoot(root: XmlElementLike): PlistValue {
  let plist = convertPlistNode(root);
  if (Array.isArray(plist) && plist.length == 1) {
    plist = plist[0];
  }
  return plist;
}
