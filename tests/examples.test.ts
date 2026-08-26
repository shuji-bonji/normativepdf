/**
 * The examples in docs/examples/ ARE the tutorial: the site displays their
 * source. Executing them here is what keeps the displayed code from
 * drifting — an example that stops working fails CI (same rule as the
 * generated reference and the lock-generated measurements page).
 *
 * T-3: break any example — a wrong operator, a stale API name — and the
 * corresponding test here falls.
 */

import { describe, expect, it } from 'vitest';

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

describe('docs/examples (executed documentation)', () => {
  it('01: builds a one-page PDF that starts and ends like a PDF', async () => {
    const { bytes } = await import('../docs/examples/01-build-a-minimal-pdf.mts');
    const text = latin1(bytes);
    expect(text.startsWith('%PDF-1.7\n')).toBe(true);
    expect(text).toContain('%%EOF');
    expect(text).toContain('Hello from normativepdf');
  });

  it('02: reads the document back down to its content stream', async () => {
    const { operators } = await import('../docs/examples/02-read-and-inspect.mts');
    expect(operators).toContain('BT');
    expect(operators).toContain('(Hello from normativepdf) Tj');
    expect(operators).toContain('ET');
  });

  it('03: appends an update without rewriting the original bytes', async () => {
    const [{ bytes: original }, { updated, hasAnnots }] = await Promise.all([
      import('../docs/examples/01-build-a-minimal-pdf.mts'),
      import('../docs/examples/03-incremental-update.mts'),
    ]);
    expect(updated.length).toBeGreaterThan(original.length);
    expect(latin1(updated.slice(0, original.length))).toBe(latin1(original));
    expect(hasAnnots).toBe(true);
  });

  it('04: encrypts, refuses without the password, reads back with it', async () => {
    const { encrypted, refusedWithoutPassword, catalog } = await import(
      '../docs/examples/04-encrypt.mts'
    );
    expect(latin1(encrypted)).toContain('/Encrypt');
    expect(refusedWithoutPassword).toBe(true);
    expect(catalog.kind).toBe('dict');
  });
});
