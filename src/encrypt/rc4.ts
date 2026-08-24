/**
 * RC4 stream cipher — pure TS.
 *
 * Named by §7.6.3.2 Algorithm 1 (V 1/2, crypt filter method V2; both
 * deprecated in PDF 2.0 but present in real files and in the corpus:
 * `isartor-6-1-3-t02-fail-a.pdf` is V 2 / R 3). RC4 is symmetric —
 * the same function encrypts and decrypts.
 *
 * Pure TS is forced, not chosen: OpenSSL 3 disables RC4, so node:crypto
 * cannot serve even as an oracle; the tests pin the RFC 6229 vectors
 * instead.
 */

/** Apply RC4 with `key` to `data` (encrypt and decrypt are the same operation). */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    s[i] = i;
  }
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) & 0xff;
    const t = s[i] as number;
    s[i] = s[j] as number;
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k += 1) {
    a = (a + 1) & 0xff;
    b = (b + (s[a] as number)) & 0xff;
    const t = s[a] as number;
    s[a] = s[b] as number;
    s[b] = t;
    out[k] = (data[k] as number) ^ (s[((s[a] as number) + (s[b] as number)) & 0xff] as number);
  }
  return out;
}
