import { base64ToUint8Array } from './base64.js';

const TEXT_NODE = 3;
const CDATA_NODE = 4;
const COMMENT_NODE = 8;

/**
 * Structural view of an XML node that the plist decoder relies on.
 *
 * Both `@xmldom/xmldom` `Node` instances (default `parse()`) and the
 * concrete syntax tree produced by the lossless scanner satisfy this shape,
 * so there is a single decoding algorithm instead of a test-only copy.
 */
export interface PlistXmlNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<PlistXmlNode>;
  readonly nodeValue: string | null;
}

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue }
  | null;

/**
 * Sentinel value produced for tags that are not part of the plist DTD when
 * decoding runs in "tolerant" mode (lossless parsing). The default `parse()`
 * entry point never installs an `onUnknownTag` hook and therefore keeps
 * throwing, as before.
 */
export const UNKNOWN_TAG: unique symbol = Symbol('plist.unknownTag');

export type DecodedNode = PlistValue | typeof UNKNOWN_TAG;

export interface DecodeOptions {
  /**
   * Called once per element/text node with the semantic value the decoder
   * assigned to it. Used by the lossless parser to attach values onto CST
   * nodes without re-implementing any decoding logic.
   */
  onNodeValue?: (node: PlistXmlNode, value: DecodedNode) => void;
  /**
   * When provided, non-plist tags are reported through this callback and
   * decoded to {@link UNKNOWN_TAG} instead of throwing. The lossless parser
   * uses this to preserve unknown nodes rather than silently normalizing them.
   */
  onUnknownTag?: (node: PlistXmlNode) => void;
}

/**
 * We ignore raw text (usually whitespace), <!-- xml comments -->,
 * and raw CDATA nodes.
 */
function shouldIgnoreNode(node: PlistXmlNode): boolean {
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
function isEmptyNode(node: PlistXmlNode): boolean {
  if (!node.childNodes || node.childNodes.length === 0) {
    return true;
  } else {
    return false;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Convert a node of an XML based plist document into a JSON value.
 *
 * This is the single semantic decoding routine shared by the default
 * `parse()` and the optional lossless parser; it only depends on the
 * {@link PlistXmlNode} structural interface.
 */
export function decodePlistNode(
  node: PlistXmlNode,
  options: DecodeOptions = {},
): DecodedNode {
  if (!node) return null;

  const finish = (value: DecodedNode): DecodedNode => {
    options.onNodeValue?.(node, value);
    return value;
  };

  if (node.nodeName === 'plist') {
    const new_arr: PlistValue[] = [];
    if (isEmptyNode(node)) {
      return finish(new_arr);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (!shouldIgnoreNode(node.childNodes[i])) {
        new_arr.push(decodePlistNode(node.childNodes[i], options) as PlistValue);
      }
    }
    return finish(new_arr);
  } else if (node.nodeName === 'dict') {
    const new_obj: { [key: string]: PlistValue } = {};
    let key: string | null = null;
    let counter = 0;
    if (isEmptyNode(node)) {
      return finish(new_obj);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (shouldIgnoreNode(node.childNodes[i])) continue;
      if (counter % 2 === 0) {
        if (node.childNodes[i].nodeName !== 'key') {
          fail('Missing key while parsing <dict/>.');
        }
        key = decodePlistNode(node.childNodes[i], options) as string;
      } else {
        if (node.childNodes[i].nodeName === 'key') {
          fail(
            'Unexpected <key> while parsing <dict/>. Keys and values must alternate.',
          );
        }
        new_obj[key!] = decodePlistNode(
          node.childNodes[i],
          options,
        ) as PlistValue;
      }
      counter += 1;
    }
    if (counter % 2 === 1) {
      new_obj[key!] = '';
    }

    return finish(new_obj);
  } else if (node.nodeName === 'array') {
    const new_arr: PlistValue[] = [];
    if (isEmptyNode(node)) {
      return finish(new_arr);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (!shouldIgnoreNode(node.childNodes[i])) {
        const res = decodePlistNode(node.childNodes[i], options);
        if (null != res) new_arr.push(res as PlistValue);
      }
    }
    return finish(new_arr);
  } else if (node.nodeName === '#text') {
    // TODO: what should we do with text types? (CDATA sections)
  } else if (node.nodeName === 'key') {
    if (isEmptyNode(node)) {
      return finish('');
    }

    if (node.childNodes[0].nodeValue === '__proto__') {
      fail(
        '__proto__ keys can lead to prototype pollution. More details on CVE-2022-22912',
      );
    }

    return finish(node.childNodes[0].nodeValue);
  } else if (node.nodeName === 'string') {
    let res = '';
    if (isEmptyNode(node)) {
      return finish(res);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const type = node.childNodes[i].nodeType;
      if (type === TEXT_NODE || type === CDATA_NODE) {
        res += node.childNodes[i].nodeValue;
      }
    }
    return finish(res);
  } else if (node.nodeName === 'integer') {
    if (isEmptyNode(node)) fail('Cannot parse "" as integer.');
    return finish(parseInt(node.childNodes[0].nodeValue!, 10));
  } else if (node.nodeName === 'real') {
    if (isEmptyNode(node)) fail('Cannot parse "" as real.');
    let res = '';
    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === TEXT_NODE) {
        res += node.childNodes[i].nodeValue;
      }
    }
    return finish(parseFloat(res));
  } else if (node.nodeName === 'data') {
    let res = '';
    if (isEmptyNode(node)) {
      return finish(base64ToUint8Array(res));
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === TEXT_NODE) {
        res += node.childNodes[i].nodeValue!.replace(/\s+/g, '');
      }
    }
    return finish(base64ToUint8Array(res));
  } else if (node.nodeName === 'date') {
    if (isEmptyNode(node)) fail('Cannot parse "" as Date.');
    return finish(new Date(node.childNodes[0].nodeValue!));
  } else if (node.nodeName === 'null') {
    return finish(null);
  } else if (node.nodeName === 'true') {
    return finish(true);
  } else if (node.nodeName === 'false') {
    return finish(false);
  } else {
    if (options.onUnknownTag) {
      options.onUnknownTag(node);
      return finish(UNKNOWN_TAG);
    }
    fail('Invalid PLIST tag ' + node.nodeName);
  }

  return null;
}

/**
 * Replace every {@link UNKNOWN_TAG} sentinel reachable from `value` with
 * `undefined`, returning the (possibly same) normalized structure.
 */
export function stripUnknownTags(value: DecodedNode): PlistValue | undefined {
  if (value === UNKNOWN_TAG) return undefined;
  if (Array.isArray(value)) {
    const new_arr: PlistValue[] = [];
    for (const item of value) {
      const replaced = stripUnknownTags(item as DecodedNode);
      if (replaced !== undefined) new_arr.push(replaced);
    }
    return new_arr;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      const replaced = stripUnknownTags(
        (value as Record<string, DecodedNode>)[key],
      );
      if (replaced === undefined) {
        delete (value as Record<string, unknown>)[key];
      }
    }
  }
  return value as PlistValue;
}
