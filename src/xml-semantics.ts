/**
 * Shared semantic walker for XML plist documents.
 *
 * Both the default {@link parse} entry point (which walks the @xmldom/xmldom
 * DOM) and the lossless parser (which walks the token tree produced by
 * `lossless.ts`) call this exact function. The walker is written against a
 * minimal structural node interface so that neither path needs a copy of the
 * tag semantics.
 */

const TEXT_NODE = 3;
const CDATA_NODE = 4;
const COMMENT_NODE = 8;

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
 * Minimal surface of an XML node that the semantic walker depends on.
 * `Node` (xmldom) and the token-tree adapter nodes both satisfy it.
 */
export interface SemanticNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<SemanticNode>;
}

export function shouldIgnoreNode(node: SemanticNode): boolean {
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
export function isEmptyNode(node: SemanticNode): boolean {
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
 * Convert an XML based plist document into a JSON representation.
 */
export function parsePlistXML(node: SemanticNode): PlistValue {
  if (!node) return null;

  if (node.nodeName === "plist") {
    const new_arr: PlistValue[] = [];
    if (isEmptyNode(node)) {
      return new_arr;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (!shouldIgnoreNode(node.childNodes[i])) {
        new_arr.push(parsePlistXML(node.childNodes[i]));
      }
    }
    return new_arr;
  } else if (node.nodeName === "dict") {
    const new_obj: { [key: string]: PlistValue } = {};
    let key: string | null = null;
    let counter = 0;
    if (isEmptyNode(node)) {
      return new_obj;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (shouldIgnoreNode(node.childNodes[i])) continue;
      if (counter % 2 === 0) {
        invariant(
          node.childNodes[i].nodeName === "key",
          "Missing key while parsing <dict/>.",
        );
        key = parsePlistXML(node.childNodes[i]) as string;
      } else {
        invariant(
          node.childNodes[i].nodeName !== "key",
          "Unexpected <key> while parsing <dict/>. Keys and values must alternate.",
        );
        new_obj[key!] = parsePlistXML(node.childNodes[i]);
      }
      counter += 1;
    }
    if (counter % 2 === 1) {
      new_obj[key!] = "";
    }

    return new_obj;
  } else if (node.nodeName === "array") {
    const new_arr: PlistValue[] = [];
    if (isEmptyNode(node)) {
      return new_arr;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (!shouldIgnoreNode(node.childNodes[i])) {
        const res = parsePlistXML(node.childNodes[i]);
        if (null != res) new_arr.push(res);
      }
    }
    return new_arr;
  } else if (node.nodeName === "#text") {
    // TODO: what should we do with text types? (CDATA sections)
  } else if (node.nodeName === "key") {
    if (isEmptyNode(node)) {
      return "";
    }

    invariant(
      node.childNodes[0].nodeValue !== "__proto__",
      "__proto__ keys can lead to prototype pollution. More details on CVE-2022-22912",
    );

    return node.childNodes[0].nodeValue as string;
  } else if (node.nodeName === "string") {
    let res = "";
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
  } else if (node.nodeName === "integer") {
    invariant(!isEmptyNode(node), 'Cannot parse "" as integer.');
    return parseInt(node.childNodes[0].nodeValue as string, 10);
  } else if (node.nodeName === "real") {
    invariant(!isEmptyNode(node), 'Cannot parse "" as real.');
    let res = "";
    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === TEXT_NODE) {
        res += node.childNodes[i].nodeValue ?? '';
      }
    }
    return parseFloat(res);
  } else if (node.nodeName === "data") {
    let res = "";
    if (isEmptyNode(node)) {
      return base64ToUint8Array(res);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (node.childNodes[i].nodeType === TEXT_NODE) {
        res += (node.childNodes[i].nodeValue ?? '').replace(
          /\s+/g,
          "",
        );
      }
    }
    return base64ToUint8Array(res);
  } else if (node.nodeName === "date") {
    invariant(!isEmptyNode(node), 'Cannot parse "" as Date.');
    return new Date(node.childNodes[0].nodeValue as string);
  } else if (node.nodeName === "null") {
    return null;
  } else if (node.nodeName === "true") {
    return true;
  } else if (node.nodeName === "false") {
    return false;
  } else {
    throw new Error("Invalid PLIST tag " + node.nodeName);
  }

  return null;
}
