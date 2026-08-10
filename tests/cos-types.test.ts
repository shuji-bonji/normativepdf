import { describe, expect, it } from 'vitest';
import { COS_NULL, type CosDict, type CosObject, dictGet, dictGetRaw } from '../src/cos/types.js';

function dict(entries: Record<string, CosObject>): CosDict {
  return { kind: 'dict', entries: new Map(Object.entries(entries)) };
}

describe('null-equivalence at access time (R-7.3.7-7, R-7.3.9-3)', () => {
  it('dictGet treats a null-valued entry the same as an absent entry', () => {
    const d = dict({ A: COS_NULL, B: { kind: 'integer', value: 1 } });
    expect(dictGet(d, 'A')).toBeUndefined();
    expect(dictGet(d, 'Missing')).toBeUndefined();
    expect(dictGet(d, 'B')).toEqual({ kind: 'integer', value: 1 });
  });

  it('dictGetRaw preserves the parsed representation (round-trip fidelity)', () => {
    const d = dict({ A: COS_NULL });
    expect(dictGetRaw(d, 'A')).toEqual({ kind: 'null' });
    expect(dictGetRaw(d, 'Missing')).toBeUndefined();
  });
});

describe('exhaustiveness of the CosObject union (§7.3 closed enumeration)', () => {
  it('a switch over kind covers every member', () => {
    const kinds: CosObject['kind'][] = [
      'boolean',
      'integer',
      'real',
      'string',
      'name',
      'array',
      'dict',
      'stream',
      'null',
      'ref',
    ];
    // Type-level exhaustiveness: this function fails to compile if a kind
    // is added to the union without extending the switch.
    function label(o: CosObject): string {
      switch (o.kind) {
        case 'boolean':
        case 'integer':
        case 'real':
        case 'string':
        case 'name':
        case 'array':
        case 'dict':
        case 'stream':
        case 'null':
        case 'ref':
          return o.kind;
        default: {
          const unreachable: never = o;
          return unreachable;
        }
      }
    }
    expect(kinds.length).toBe(10);
    expect(label(COS_NULL)).toBe('null');
  });
});
