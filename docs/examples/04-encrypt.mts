/**
 * Encrypt a document (§7.6) and read it back.
 *
 * `encryptPdf` takes the same objects-and-trailer input as `writeFile` and
 * produces a standard-security-handler encrypted file. Two ciphers:
 *
 * - 'AESV3' — AES-256-CBC, R 6 (§7.6.4). The widely-supported one; qpdf
 *   decrypts these files independently, which is how the writer is tested.
 * - 'AESV4' — AES-GCM, R 7 (ISO/TS 32003). Authenticated encryption; a
 *   tampered ciphertext fails its tag check instead of decoding to noise.
 *
 * Strings and streams are encrypted; names and numbers are not (§7.6.2 —
 * the document's structure stays parseable, its content does not).
 */

import { encryptPdf, parsePdf } from 'normativepdf';
import { objects, trailer } from './01-build-a-minimal-pdf.mts';

const password = new TextEncoder().encode('correct horse');

const encrypted = encryptPdf(objects, trailer, {
  method: 'AESV3',
  userPassword: password,
});

// The plaintext must not appear anywhere in the written file.
const surface = new TextDecoder('latin1').decode(encrypted);
if (surface.includes('Hello from normativepdf')) {
  throw new Error('plaintext leaked into the encrypted file');
}

// Without the password, materializing an object is a named error —
// ciphertext is never silently returned (ADR-0008 decision 3).
let refusedWithoutPassword = false;
try {
  const blind = await parsePdf(encrypted);
  await blind.getCatalog();
} catch {
  refusedWithoutPassword = true;
}

// With the password, the document reads back in full.
const doc = await parsePdf(encrypted, { password });
const catalog = await doc.getCatalog();

export { encrypted, refusedWithoutPassword, doc, catalog };
