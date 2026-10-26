// Argon2 parameter sets this extension has used for master password Key
// records: the v2 `key` and early v3 Keys use the first, Argon.hash uses the
// second. Verification rejects any other encoding, so a Key record synced in
// with weaker parameters or argon2d can't be used to unlock.
const KNOWN_PARAMS = [
  { m: 16384, t: 1, p: 1 },
  { m: 19456, t: 2, p: 1 },
];

// Unpadded base64 lengths of 24- and 32-byte hashes.
const KNOWN_HASH_LENGTHS = [32, 43];

const ENCODED_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]{11,}\$([A-Za-z0-9+/]+)$/;

export function isKnownArgonEncoding(encoded: string): boolean {
  const match = ENCODED_PATTERN.exec(encoded);
  if (!match) {
    return false;
  }
  const [, m, t, p, hash] = match;
  return (
    KNOWN_HASH_LENGTHS.includes(hash.length) &&
    KNOWN_PARAMS.some(
      (params) =>
        params.m === Number(m) &&
        params.t === Number(t) &&
        params.p === Number(p),
    )
  );
}
