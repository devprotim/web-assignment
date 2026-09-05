import { Injectable } from '@nestjs/common';
import {
  DataSet,
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
} from 'obscenity';

/**
 * Server-side profanity moderation.
 *
 * The requirement is resistance to casing changes, added spaces, repeated letters
 * and character substitutions. Rather than regexing a hardcoded word list, this
 * runs a normalising transformer pipeline before matching:
 *
 *   - toAsciiLowerCase        "FUUUCK"   -> "fuuuck"      (casing)
 *   - resolveConfusables      "fuµck"     -> "fuck"        (homoglyphs)
 *   - resolveLeetSpeak        "f0ck"     -> "fock"        (substitutions)
 *   - collapseDuplicates      "fuuuck"   -> "fuck"        (repeated letters)
 *   - skipNonAlphabetic       "f*u*c*k"  -> "fuck"        (separators)
 *
 * The whitelist matters as much as the blacklist: without it "Scunthorpe",
 * "classic" and "assessment" are all false positives, and a moderation layer that
 * blocks ordinary words is worse than none. `englishRecommendedTransformers`
 * ships that whitelist.
 *
 * The recommended transformer set deliberately omits separator stripping, because
 * deleting all punctuation globally merges innocent adjacent words into matches.
 * That leaves "f*u*c*k" and "f u c k" through, which the requirements call out
 * explicitly, so `collapseSpacedLetters` handles that case narrowly instead: it
 * only joins runs of *single* letters, which is the spaced-out-word pattern and
 * never merges ordinary multi-letter words. Both forms are matched.
 */

/**
 * "f*u*c*k" / "f u c k" / "F . U . C . K" -> "fuck".
 *
 * Requires at least three single letters in a row, so "a dog" and "I am"
 * are untouched. Ordinary words survive because they are longer than one letter.
 */
export function collapseSpacedLetters(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}])\p{L}(?:[^\p{L}\p{N}]+\p{L}){2,}(?![\p{L}\p{N}])/gu,
    (run) => run.replace(/[^\p{L}\p{N}]+/gu, ''),
  );
}
@Injectable()
export class ProfanityService {
  private readonly dataset: DataSet<{ originalWord: string }>;
  private readonly matcher: RegExpMatcher;

  constructor() {
    this.dataset = new DataSet<{ originalWord: string }>()
      .addAll(englishDataset)
      // Terms the shipped dataset does not cover. Kept small and explicit.
      .addPhrase((phrase) =>
        phrase.setMetadata({ originalWord: 'wanker' }).addPattern(pattern`wanker`),
      );

    this.matcher = new RegExpMatcher({
      ...this.dataset.build(),
      ...englishRecommendedTransformers,
    });
  }

  /** Cheap boolean check; this is the one on the message send path. */
  isClean(text: string): boolean {
    return !this.matcher.hasMatch(text) && !this.matcher.hasMatch(collapseSpacedLetters(text));
  }

  /**
   * The matched terms, for the moderation audit log only.
   *
   * These are never returned to the client: echoing which word tripped the
   * filter turns the endpoint into an oracle for probing the list.
   */
  matchedTerms(text: string): string[] {
    const matches = [
      ...this.matcher.getAllMatches(text, true),
      ...this.matcher.getAllMatches(collapseSpacedLetters(text), true),
    ];
    const terms = matches.map(
      (match) => this.dataset.getPayloadWithPhraseMetadata(match).phraseMetadata?.originalWord,
    );
    return [...new Set(terms.filter((t): t is string => Boolean(t)))];
  }
}
