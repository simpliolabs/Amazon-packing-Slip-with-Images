/**
 * Celebrity / proper-noun output scrub (PO 2026-07-21). A published apparel field must NEVER carry a
 * living-person's name — athlete, musician, actor, politician — even when the keyword-intelligence pool
 * (Jungle Scout / SQP) surfaces it as a legitimate high-volume search term. Publishing a celebrity name
 * on a listing is a personality-rights / trademark-adjacent claim and a repeat Amazon takedown vector.
 *
 * Precipitating incidents:
 *   - B0H9VDCBZJ 2026-07-21: "lamine" (Lamine Yamal) landed in 3 child backends via the LLM council fill
 *     for a Spain 2026 tee — same "spain jersey women" pool the shopper searches. NOT a trademark per
 *     scrubTrademarks; needs its OWN seam.
 *   - task #72: "usher and chris brown shirt", "grafica tees women" — same class from ingestion.
 *
 * Applied SYMMETRICALLY at THREE seams:
 *   (a) Generation, per-token: isCelebrityToken inside banBackendTok (listingPipeline.ts) keeps a
 *       SINGLE-token name out of the byte-fill. PHRASE entries never match here by construction —
 *       each half is a common word and deliberately not a token.
 *   (a2) Generation EXIT, phrase-aware (2026-08-09, adversarial fix): scrubCelebrityNames runs in
 *       the pipeline's scrubPublished choke point beside scrubTrademarks, on every published
 *       surface (title/bullets/description/backend + per-child twins) — THE seam that catches a
 *       composed phrase ("forrest frank", "chris brown") so stored bytes ≡ pushed bytes.
 *   (b) Push boundary: the same terminal net catching an ingestion contaminant or stale stored
 *       value (pushExecutor.ts: executePush + executeBulkCorePush both scrub-at-push so a
 *       manually-typed OR stale value can never write to Amazon). Idempotent.
 *   The TITLE_MONEY_TAIL derivation additionally gates candidates via hasCelebrityName, so a
 *   demanded name ("forrest frank shirt" on B0FKKN8XKV) can never be welded into the visible title.
 *
 * Meta (PO 2026-07-21, "LLM should figure it out with training"): this seed list should GROW from a
 * data source — a versioned JSON/CSV appended by a "PO flagged a drop" workflow — rather than
 * hand-edited per case. Follow-on task #104. Today's ship is the tactical seam + a small seed list.
 */

/** Curated seed — first names + last names + common single-name aliases of high-visibility athletes,
 *  musicians, and actors likely to appear in apparel keyword pools. Every entry is a lowercase token
 *  match (word-boundary), so common English words (e.g. "the", "will") that overlap with names are
 *  NOT included here — the rule is CONSERVATIVE to avoid false positives. Ordered roughly by
 *  world-cup / celebrity-tee frequency; append when a real slip is caught. */
const CELEBRITY_TOKENS: string[] = [
  // Football (soccer) — currently active or recent, the actual incident class
  'lamine', 'yamal',
  'messi', 'ronaldo', 'ronaldinho', 'neymar', 'mbappe', 'mbappé',
  'haaland', 'salah', 'benzema', 'modric', 'kroos',
  'lewandowski', 'griezmann', 'suarez', 'iniesta', 'xavi',
  'vinicius', 'rodrygo', 'valverde', 'pedri', 'gavi', 'nico',
  'kane', 'foden', 'saka', 'bellingham', 'rashford',
  'zidane', 'beckham', 'pele', 'maradona',
  // American football / basketball / baseball
  'mahomes', 'brady', 'rodgers', 'lamar',
  'lebron', 'curry', 'durant', 'kobe', 'jordan',
  'trout', 'ohtani',
  // Music (task #72 class)
  'usher', 'drake', 'beyonce', 'beyoncé', 'rihanna', 'taylor swift', 'kanye',
  'chris brown', 'bruno mars', 'ariana grande', 'billie eilish',
  // Christian music (PO ruling 2026-08-08: real search demand on B0FKKN8XKV, scrubbed anyway —
  // 'forrest frank' as a phrase; bare 'forrest'/'frank' deliberately NOT tokens (common
  // names/words — the conservative rule above). Phrase entries are enforced by the PHRASE-AWARE
  // seams — the scrubPublished generation-exit scrub, the push-boundary scrub, and the money-tail
  // derivation's hasCelebrityName gate — NOT by the per-token banBackendTok check, which by
  // construction cannot see a two-word phrase (each half passes alone).
  'forrest frank',
  // Politics / celebrities occasionally hitting apparel pools
  'trump', 'biden', 'obama', 'harris',
]

/** Multi-word celebrity phrases (e.g. "chris brown", "taylor swift") — matched as adjacent
 *  word-boundary phrases BEFORE single-token scrubbing so we drop the whole phrase, not one half. */
const CELEBRITY_PHRASES: string[] = CELEBRITY_TOKENS.filter((t) => t.includes(' '))
const CELEBRITY_SINGLE_TOKENS = new Set(CELEBRITY_TOKENS.filter((t) => !t.includes(' ')))

/** True when a normalized single token is a celebrity name. Used at generation seams
 *  (a per-token ban paralleling banBackendTok) — keeps the name out of produced bytes. */
export function isCelebrityToken(tokenLower: string): boolean {
  if (!tokenLower) return false
  return CELEBRITY_SINGLE_TOKENS.has(tokenLower)
}

/** True when the text contains any celebrity name (single-token or phrase). Gates the
 *  TITLE_MONEY_TAIL keyword derivation (listingPipeline.ts) and serves assertions/flagging. */
export function hasCelebrityName(text: string): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  for (const p of CELEBRITY_PHRASES) if (new RegExp(`\\b${p.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text)) return true
  for (const t of CELEBRITY_SINGLE_TOKENS) if (new RegExp(`\\b${t}\\b`, 'i').test(lower)) return true
  return false
}

/** Terminal scrub for a published field. Removes every celebrity phrase + token, then tidies the
 *  whitespace/punctuation artifacts the removal leaves behind. Idempotent. Logs every strip.
 *
 *  Backend keyword strings are space-separated tokens with no punctuation, so the tidy step is a
 *  no-op there; bullets/description sentences get their commas/double-spaces collapsed the same way
 *  scrubTrademarks does (parity). */
export function scrubCelebrityNames(text: string, ctx?: string): string {
  if (!text) return text
  let out = text
  const dropped: string[] = []
  for (const p of CELEBRITY_PHRASES) {
    const re = new RegExp(`\\b${p.replace(/\s+/g, '\\s+')}\\b`, 'gi')
    if (re.test(out)) { dropped.push(p); out = out.replace(re, '') }
  }
  for (const t of CELEBRITY_SINGLE_TOKENS) {
    const re = new RegExp(`\\b${t}\\b`, 'gi')
    if (re.test(out)) { dropped.push(t); out = out.replace(re, '') }
  }
  if (dropped.length) {
    console.warn(`[celebrityGuard] scrubbed ${dropped.length} name(s) from ${ctx || 'field'}: ${dropped.join(', ')}`)
  }
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim()
}

/** Array variant for bullets / per-child backend lines. */
export function scrubCelebrityNamesArr(items: (string | null | undefined)[], ctx?: string): string[] {
  return items.map((s, i) => scrubCelebrityNames(s || '', ctx ? `${ctx}[${i}]` : undefined))
}
