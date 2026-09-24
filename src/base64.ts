/**
 * Decode a base64 string into a Uint8Array.
 *
 * Shared by the DOM-based XML decoder and the lossless XML parser so that
 * every public entry point performs identical `<data>` decoding.
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
 * Encode a Uint8Array (or any other typed-array view) into a base64 string.
 *
 * Shared by the two `build()` implementations and the lossless edit planner.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Normalize an ArrayBuffer or an ArrayBuffer view into a standalone
 * Uint8Array without copying when the view covers the whole buffer.
 */
export function coerceToUint8Array(
  value: ArrayBuffer | ArrayBufferView,
): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(
    value.buffer as ArrayBuffer,
    value.byteOffset,
    value.byteLength,
  );
}
