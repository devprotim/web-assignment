import { describe, expect, it } from 'vitest';
import { decideNsfw, type NsfwScores } from './nsfw.service.js';

const THRESHOLDS = { porn: 0.6, hentai: 0.6, sexy: 0.85, combined: 0.75 };

const scores = (partial: Partial<NsfwScores>): NsfwScores => ({
  neutral: 0,
  drawing: 0,
  sexy: 0,
  hentai: 0,
  porn: 0,
  ...partial,
});

describe('decideNsfw', () => {
  it('allows a confidently neutral image', () => {
    expect(decideNsfw(scores({ neutral: 0.97, drawing: 0.02 }), THRESHOLDS).safe).toBe(true);
  });

  it('allows a drawing, which is not explicit on its own', () => {
    expect(decideNsfw(scores({ drawing: 0.93, neutral: 0.05 }), THRESHOLDS).safe).toBe(true);
  });

  it('blocks a confident porn prediction', () => {
    const verdict = decideNsfw(scores({ porn: 0.91 }), THRESHOLDS);
    expect(verdict.safe).toBe(false);
    expect(verdict.rule).toBe('porn>=0.6');
  });

  it('blocks a confident hentai prediction', () => {
    expect(decideNsfw(scores({ hentai: 0.72 }), THRESHOLDS).safe).toBe(false);
  });

  it('tolerates moderate "sexy" alone, which fires on swimwear and ordinary photos', () => {
    // A low sexy threshold is the main source of false positives, so 0.7 passes.
    expect(decideNsfw(scores({ sexy: 0.7, neutral: 0.28 }), THRESHOLDS).safe).toBe(true);
  });

  it('blocks an overwhelming "sexy" prediction', () => {
    expect(decideNsfw(scores({ sexy: 0.9 }), THRESHOLDS).safe).toBe(false);
  });

  it('blocks a spread that trips no single threshold but sums past the combined rule', () => {
    // This is the case individual thresholds miss entirely.
    const verdict = decideNsfw(scores({ porn: 0.4, sexy: 0.4 }), THRESHOLDS);
    expect(verdict.safe).toBe(false);
    expect(verdict.rule).toBe('porn+hentai+sexy>=0.75');
  });

  it('allows a spread that stays under the combined rule', () => {
    expect(decideNsfw(scores({ porn: 0.2, sexy: 0.3, neutral: 0.5 }), THRESHOLDS).safe).toBe(true);
  });

  it('applies thresholds at the boundary', () => {
    expect(decideNsfw(scores({ porn: 0.6 }), THRESHOLDS).safe).toBe(false);
    expect(decideNsfw(scores({ porn: 0.599 }), THRESHOLDS).safe).toBe(true);
  });
});
