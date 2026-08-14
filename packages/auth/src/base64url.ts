const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeTextBase64Url(value: string): string {
  return encodeBase64Url(encoder.encode(value));
}

export function decodeTextBase64Url(value: string): string {
  return decoder.decode(decodeBase64Url(value));
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}
