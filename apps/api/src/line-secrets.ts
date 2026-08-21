function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(keyMaterial: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [usage]);
}

/** Secret 可由管理者在後台設定，但 D1 不保存明文。 */
export async function encryptLineSecret(secret: string, keyMaterial: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(keyMaterial, "encrypt");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)));
  return `${base64(iv)}.${base64(ciphertext)}`;
}

export async function decryptLineSecret(value: string, keyMaterial: string): Promise<string | null> {
  try {
    const [ivValue, ciphertextValue] = value.split(".");
    if (!ivValue || !ciphertextValue) return null;
    const key = await encryptionKey(keyMaterial, "decrypt");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(ivValue) }, key, bytes(ciphertextValue));
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
