/**
 * checkPresence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Determines where a keyword appears in a listing's content fields.
 * Uses tokenized matching (not substring) to avoid false positives like
 * "card" matching "cardboard".
 *
 * Karpathy principle: Simple, surgical, goal-driven.
 * No fuzzy matching, no stemming — exact token boundary match only.
 */

export interface ListingContent {
  title?: string | null;
  // Column-based bullets matching actual listing_content DB schema
  bullet_1?: string | null;
  bullet_2?: string | null;
  bullet_3?: string | null;
  bullet_4?: string | null;
  bullet_5?: string | null;
  description?: string | null;
  backend_keywords?: string | null; // SP-API generic_keyword field
}

export interface PresenceResult {
  inTitle: boolean;
  inBullets: boolean;
  inDescription: boolean;
  inBackend: boolean;
  /** Total number of fields the keyword appears in (0–4) */
  coverageCount: number;
  /** Usage gap multiplier for scoring: higher = bigger opportunity */
  usageGapMultiplier: number;
}

/**
 * Tokenize text into lowercase words, stripping punctuation.
 * Preserves word boundaries so "card" does NOT match "cardboard".
 *
 * Hyphen handling: hyphens are replaced with spaces (standard tokenization),
 * but we ALSO generate a collapsed form for each hyphenated word so that
 * "T-Shirt" produces tokens {t, shirt, tshirt} and matches both "t shirt"
 * and "tshirt" spellings.
 */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  // Standard tokens: replace all non-alphanumeric (including hyphens) with spaces
  const standard = lower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Collapsed tokens: join hyphen-separated segments into a single token
  // e.g. "t-shirt" → "tshirt", "long-sleeve" → "longsleeve"
  const collapsed = lower
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(word => {
      if (word.includes('-')) {
        return [word.replace(/-/g, '')];
      }
      return [];
    });
  return new Set([...standard, ...collapsed]);
}

/**
 * Check if ALL tokens of the keyword phrase appear in the text tokens.
 * This is a phrase-level match: "sd card 32gb" requires all 3 tokens present.
 * For single-word keywords it's an exact word match.
 */
function containsKeyword(text: string, keywordTokens: string[]): boolean {
  if (!text || keywordTokens.length === 0) return false;
  const textTokens = tokenize(text);
  return keywordTokens.every(token => textTokens.has(token));
}

/**
 * Normalize bullets from column-based storage (bullet_1..bullet_5).
 */
function normalizeBullets(listing: ListingContent): string {
  return [
    listing.bullet_1,
    listing.bullet_2,
    listing.bullet_3,
    listing.bullet_4,
    listing.bullet_5,
  ].filter(Boolean).join(' ');
}

/**
 * Main presence check function.
 * Returns where the keyword appears and the usage gap multiplier for scoring.
 */
export function checkPresence(
  keyword: string,
  listing: ListingContent
): PresenceResult {
  const kwTokens = tokenize(keyword).size > 0
    ? Array.from(tokenize(keyword))
    : [];

  if (kwTokens.length === 0) {
    return {
      inTitle: false,
      inBullets: false,
      inDescription: false,
      inBackend: false,
      coverageCount: 0,
      usageGapMultiplier: 3,
    };
  }

  const inTitle       = containsKeyword(listing.title ?? '', kwTokens);
  const inBullets     = containsKeyword(normalizeBullets(listing), kwTokens);
  const inDescription = containsKeyword(listing.description ?? '', kwTokens);
  const inBackend     = containsKeyword(listing.backend_keywords ?? '', kwTokens);

  const coverageCount = [inTitle, inBullets, inDescription, inBackend]
    .filter(Boolean).length;

  /**
   * Usage Gap Multiplier — the core lever of the scoring model.
   *
   * Not in Title AND not in Bullets = 3.0 (critical gap — easy fix, huge upside)
   * Not in Title but in Bullets     = 2.0 (title gap — move it up)
   * Not in Title but in Backend     = 1.8 (promote from backend to visible field)
   * In Title but not in Bullets     = 1.5 (reinforce in bullets)
   * In Title AND in Bullets         = 1.0 (defended — no gap)
   */
  let usageGapMultiplier: number;
  if (!inTitle && !inBullets && !inBackend && !inDescription) {
    usageGapMultiplier = 3.0; // Completely missing
  } else if (!inTitle && !inBullets) {
    usageGapMultiplier = inBackend ? 1.8 : 2.5; // Backend only or description only
  } else if (!inTitle && inBullets) {
    usageGapMultiplier = 2.0; // Bullets but not title
  } else if (inTitle && !inBullets) {
    usageGapMultiplier = 1.5; // Title but not bullets
  } else {
    usageGapMultiplier = 1.0; // Title + Bullets = defended
  }

  return {
    inTitle,
    inBullets,
    inDescription,
    inBackend,
    coverageCount,
    usageGapMultiplier,
  };
}
