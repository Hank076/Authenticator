import { argon2id } from "@noble/hashes/argon2.js";
import { isKnownArgonEncoding } from "./argon-params";

// Parameters for new master password hashes. They must stay in the
// KNOWN_PARAMS whitelist (argon-params.ts), and existing hashes keep the
// parameters encoded in them.
const HASH_PARAMS = { m: 19456, t: 2, p: 1, dkLen: 32 };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/, "");
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// argon2id in the PHC encoded format argon2-browser produced, so Key records
// written by earlier versions verify unchanged:
// $argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt base64>$<hash base64>
export function argonHashEncoded(value: string, salt: string): string {
  const { m, t, p, dkLen } = HASH_PARAMS;
  const hash = argon2id(value, salt, { m, t, p, dkLen });
  const saltBytes = new TextEncoder().encode(salt);
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${toBase64(saltBytes)}$${toBase64(hash)}`;
}

// Recomputes the hash with the parameters, salt and length stored in the
// encoded string. Encodings outside the whitelist never match.
export function argonVerifyEncoded(value: string, encoded: string): boolean {
  if (typeof encoded !== "string" || !isKnownArgonEncoding(encoded)) {
    return false;
  }
  const [, , , params, salt, hash] = encoded.split("$");
  const [m, t, p] = params.split(",").map((part) => Number(part.slice(2)));
  const expected = fromBase64(hash);
  const actual = argon2id(value, fromBase64(salt), {
    m,
    t,
    p,
    dkLen: expected.length,
  });
  return equalBytes(actual, expected);
}
