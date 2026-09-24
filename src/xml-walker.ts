/**
 * Shared XML-plist semantic walker.
 *
 * This module contains the single source of truth for turning a tree of
 * XML element nodes into a `PlistValue`. The default `parse()` entry feeds it
 * an `@xmldom/xmldom` document; the lossless parser feeds it the internal
 * scanner tree produced by `lossless-scanner.ts`. Both paths therefore share
 * exactly the same tag handling, error messages and edge-case behaviour.
 *
 * The node shape declared here is structural: both the xmldom `Node` and the
 * scanner's nodes satisfy it.
 */

const TEXT_NODE = 3;
const CDATA_NODE = 4;
const COMMENT_NODE = 8;
const PI_NODE = 7;

export const PLIST_TEXT_NODE = TEXT_NODE;
export const PLIST_CDATA_NODE = CDATA_NODE;
export const PLIST_COMMENT_NODE = COMMENT_NODE;
export const PLIST_PROCESSING_INSTRUCTION_NODE = PI_NODE;

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
 * and raw CDATA nodes. Processing instructions are ignored only when the
 * lossless walker asks for them (default parse rejects `<pi/>`-like tags by
 * letting them fall through to the invalid-tag error, matching xmldom).
 */
export function shouldIgnoreNode(
  node: XmlWalkerNode,
  ignoreProcessingInstructions = false,
): boolean {
  return (
    node.nodeType === TEXT_NODE ||
    node.nodeType === COMMENT_NODE ||
    node.nodeType === CDATA_NODE ||
    (ignoreProcessingInstructions && node.nodeType === PI_NODE)
  );
}

/**
 * Check if the node is empty. Some plist file has such node:
 * <key />
 * this node should be ignored.
 *
 * @see https://github.com/TooTallNate/plist.js/issues/66
 */
export function isEmptyNode(node: XmlWalkerNode): boolean {
  if (!node.childNodes || node.childNodes.length === 0) {
    return true;
  } else {
    return false;
  }
}

export function invariant(test: boolean, message: string): asserts test {
  if (!test) {
    throw new Error(message);
  }
}

/**
 * Structural node contract consumed by the shared walker.
 */
export interface XmlWalkerNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<XmlWalkerNode>;
}

/**
 * The subset of {@link PlistValue} handled by the XML walker.
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

export interface DictEntryEvent {
  /** Position of the entry among non-ignored element children (0-based). */
  index: number;
  /** The `<key>` element node. */
  keyNode: XmlWalkerNode;
  /** Decoded key text. Empty string for a dangling trailing `<key>`. */
  key: string;
  /** The value element node, or synthetic node when the value is missing. */
  valueNode: XmlWalkerNode;
  /** The decoded semantic value. */
  value: PlistValue;
  /** True when the dict ended with a trailing key and no value element. */
  dangling: boolean;
}

export interface ArrayEntryEvent {
  /** Position among non-ignored element children (0-based). */
  index: number;
  node: XmlWalkerNode;
  value: PlistValue;
}

export interface NodeEvent {
  node: XmlWalkerNode;
  value: PlistValue;
}

export interface WalkerHooks {
  /** Fired for every complete key/value pair of a dict, in source order. */
  onDictEntry?: (event: DictEntryEvent) => void;
  /** Fired for every element child of an array, in source order. */
  onArrayEntry?: (event: ArrayEntryEvent) => void;
  /** Fired bottom-up for every parsed element node. */
  onNode?: (event: NodeEvent) => void;
}

export interface WalkerOptions {
  hooks?: WalkerHooks;
  /**
   * When true, processing-instruction nodes inside containers are skipped
   * instead of reaching the invalid-tag branch. Used by the lossless parser,
   * which records them as misc metadata. The default parser never enables
   * this, so unknown tags and PIs keep throwing.
   */
  ignoreProcessingInstructions?: boolean;
  /** Wrap any thrown error together with the offending node. */
  wrapError?: (error: Error, node: XmlWalkerNode) => Error;
}

/**
 * Convert an XML based plist document into a JSON representation.
 *
 * This is the exact algorithm previously inlined in `parse.ts`; hooks let
 * the lossless parser observe the same pairing/filtering decisions without
 * duplicating any of the tag semantics.
 */
export function parsePlistXML(
  node: XmlWalkerNode,
  options: WalkerOptions = {},
): PlistValue {
  if (!node) return null;
  const ignorePIs = options.ignoreProcessingInstructions === true;
  const hooks = options.hooks;

  const walk = (current: XmlWalkerNode): PlistValue => {
    let result: PlistValue;
    if (current.nodeName === "plist") {
      const new_arr: PlistValue[] = [];
      if (isEmptyNode(current)) {
        result = new_arr;
      } else {
        for (let i = 0; i < current.childNodes.length; i++) {
          if (!shouldIgnoreNode(current.childNodes[i], ignorePIs)) {
            new_arr.push(walk(current.childNodes[i]));
          }
        }
        result = new_arr;
      }
    } else if (current.nodeName === "dict") {
      const new_obj: { [key: string]: PlistValue } = {};
      let key: string | null = null;
      let counter = 0;
      if (!isEmptyNode(current)) {
        for (let i = 0; i < current.childNodes.length; i++) {
          if (shouldIgnoreNode(current.childNodes[i], ignorePIs)) continue;
          if (counter % 2 === 0) {
            invariant(
              current.childNodes[i].nodeName === "key",
              "Missing key while parsing <dict/>.",
            );
            key = walk(current.childNodes[i]) as string;
          } else {
            invariant(
              current.childNodes[i].nodeName !== "key",
              "Unexpected <key> while parsing <dict/>. Keys and values must alternate.",
            );
            const valueNode = current.childNodes[i];
            const value = walk(valueNode);
            new_obj[key!] = value;
            hooks?.onDictEntry?.({
              index: (counter - 1) / 2,
              keyNode: current.childNodes[i - elementBackStep(current, i, ignorePIs)],
              key: key!,
              valueNode,
              value,
              dangling: false,
            });
          }
          counter += 1;
        }
        if (counter % 2 === 1) {
          const keyNode = lastKeyNode(current, ignorePIs);
          new_obj[key!] = "";
          hooks?.onDictEntry?.({
            index: (counter - 1) / 2,
            keyNode,
            key: key!,
            valueNode: danglingSyntheticNode(keyNode),
            value: "",
            dangling: true,
          });
        }
      }
      result = new_obj;
    } else if (current.nodeName === "array") {
      const new_arr: PlistValue[] = [];
      if (!isEmptyNode(current)) {
        for (let i = 0; i < current.childNodes.length; i++) {
          if (!shouldIgnoreNode(current.childNodes[i], ignorePIs)) {
            const res = walk(current.childNodes[i]);
            if (null != res) new_arr.push(res);
            hooks?.onArrayEntry?.({
              index: new_arr.length - 1 < 0 ? 0 : elementCount(new_arr, res),
              node: current.childNodes[i],
              value: res,
            });
          }
        }
      }
      result = new_arr;
    } else if (current.nodeName === "#text") {
      // TODO: what should we do with text types? (CDATA sections)
      result = undefined as unknown as PlistValue;
    } else if (current.nodeName === "key") {
      if (isEmptyNode(current)) {
        result = "";
      } else {
        invariant(
          current.childNodes[0].nodeValue !== "__proto__",
          "__proto__ keys can lead to prototype pollution. More details on CVE-2022-22912",
        );
        result = current.childNodes[0].nodeValue;
      }
    } else if (current.nodeName === "string") {
      let res = "";
      if (!isEmptyNode(current)) {
        for (let i = 0; i < current.childNodes.length; i++) {
          const type = current.childNodes[i].nodeType;
          if (type === TEXT_NODE || type === CDATA_NODE) {
            res += current.childNodes[i].nodeValue;
          }
        }
      }
      result = res;
    } else if (current.nodeName === "integer") {
      invariant(!isEmptyNode(current), 'Cannot parse "" as integer.');
      result = parseInt(current.childNodes[0].nodeValue!, 10);
    } else if (current.nodeName === "real") {
      invariant(!isEmptyNode(current), 'Cannot parse "" as real.');
      let res = "";
      for (let i = 0; i < current.childNodes.length; i++) {
        if (current.childNodes[i].nodeType === TEXT_NODE) {
          res += current.childNodes[i].nodeValue;
        }
      }
      result = parseFloat(res);
    } else if (current.nodeName === "data") {
      let res = "";
      if (!isEmptyNode(current)) {
        for (let i = 0; i < current.childNodes.length; i++) {
          if (current.childNodes[i].nodeType === TEXT_NODE) {
            res += current.childNodes[i].nodeValue!.replace(/\s+/g, "");
          }
        }
      }
      result = base64ToUint8Array(res);
    } else if (current.nodeName === "date") {
      invariant(!isEmptyNode(current), 'Cannot parse "" as Date.');
      result = new Date(current.childNodes[0].nodeValue!);
    } else if (current.nodeName === "null") {
      result = null;
    } else if (current.nodeName === "true") {
      result = true;
    } else if (current.nodeName === "false") {
      result = false;
    } else {
      throw new Error("Invalid PLIST tag " + current.nodeName);
    }

    try {
      hooks?.onNode?.({ node: current, value: result });
    } catch {
      // observer hooks must never change parse semantics
    }
    return result;
  };

  try {
    return walk(node);
  } catch (error) {
    if (options.wrapError) {
      throw options.wrapError(error as Error, node);
    }
    throw error;
  }
}

function elementCount(arr: PlistValue[], res: PlistValue): number {
  // mirrors push order: index of the element just appended
  return res === null ? arr.length : arr.length - 1;
}

function elementBackStep(
  parent: XmlWalkerNode,
  valueIndex: number,
  ignorePIs: boolean,
): number {
  // The key node is the nearest previous non-ignored sibling.
  for (let i = valueIndex - 1; i >= 0; i--) {
    if (!shouldIgnoreNode(parent.childNodes[i], ignorePIs)) {
      return valueIndex - i;
    }
  }
  return 0;
}

function lastKeyNode(
  parent: XmlWalkerNode,
  ignorePIs: boolean,
): XmlWalkerNode {
  for (let i = parent.childNodes.length - 1; i >= 0; i--) {
    if (!shouldIgnoreNode(parent.childNodes[i], ignorePIs)) {
      return parent.childNodes[i];
    }
  }
  return parent;
}

/**
 * Synthetic value node used to describe a dict that ends on a trailing key
 * with no value element. Its source range is empty (zero length).
 */
export function danglingSyntheticNode(keyNode: XmlWalkerNode): XmlWalkerNode {
  const end = sourceEnd(keyNode);
  return {
    nodeType: 1,
    nodeName: "#synthetic-empty",
    nodeValue: "",
    childNodes: [],
    ...(end !== null ? { sourceStart: end, sourceEnd: end } : {}),
  } as XmlWalkerNode;
}

export interface SyntheticSourceNode extends XmlWalkerNode {
  sourceStart: number;
  sourceEnd: number;
}

function sourceEnd(node: XmlWalkerNode): number | null {
  const withSource = node as Partial<SyntheticSourceNode>;
  if (typeof withSource.sourceEnd === "number") return withSource.sourceEnd;
  return null;
}
