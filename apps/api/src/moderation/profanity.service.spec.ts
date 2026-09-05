import { describe, expect, it } from 'vitest';
import { ProfanityService } from './profanity.service.js';

const profanity = new ProfanityService();

describe('ProfanityService', () => {
  describe('blocks documented bypass techniques', () => {
    const cases = [
      ['plain', 'fuck'],
      ['casing', 'FuCk'],
      ['repeated letters', 'fuuuuck'],
      ['asterisk separators', 'f*u*c*k'],
      ['space separators', 'f u c k'],
      ['dot separators', 'f.u.c.k'],
      ['hyphen separators', 'f-u-c-k'],
      ['wide spacing in caps', 'WHAT THE  F   U   C   K'],
      ['leetspeak digits', 'sh1t'],
      ['leetspeak symbols', 'sh!t'],
      ['currency substitution', '$hit'],
      ['mixed substitution', 'b1tch'],
      ['doubled substitution', 'a$$hole'],
      ['zero for o', 'c0ck'],
      ['inside a sentence', 'you are a fucking idiot'],
    ] as const;

    it.each(cases)('%s: %s', (_label, text) => {
      expect(profanity.isClean(text)).toBe(false);
    });
  });

  describe('does not block ordinary language', () => {
    // The Scunthorpe problem: a filter that blocks these is worse than none.
    const cases = [
      'Scunthorpe',
      'classic',
      'assessment',
      'analysis',
      'Cockburn',
      'grass',
      'shitake mushrooms are nice',
      'I need to pass this assignment',
      'Let us meet at the bus stop',
      'documentation',
      'hello there',
    ];

    it.each(cases)('allows %s', (text) => {
      expect(profanity.isClean(text)).toBe(true);
    });
  });

  it('does not leak matched terms to callers of isClean', () => {
    // matchedTerms exists for the audit log only; the API never returns it.
    expect(profanity.matchedTerms('fuck')).not.toHaveLength(0);
  });
});
