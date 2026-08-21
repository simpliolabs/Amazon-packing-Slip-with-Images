/**
 * Trademark output scrub (PO 2026-06-15, updated 2026-07-21). Protected marks must NEVER be PUBLISHED
 * to a listing — "World Cup" is FIFA's registered trademark; the seller's safe convention is
 * "World Futbol Cup" (PO 2026-07-21: matches bilingual/Spanish design language and preserves the
 * "cup" token for coverage; prior "world soccer cup" is also safe but "futbol" is preferred).
 * Publishing an infringing mark risks Amazon listing suppression + an IP/account-health strike, so
 * this is the legal safety net applied to every GENERATED published field (title/bullets/description/
 * backend) + the research seeds. Scope A (minimal, approved): substitute to safe phrasing where one
 * exists; drop the mark otherwise. Per-seller configurability is a future scope-C follow-on.
 *
 * NOT applied to the raw research/Intelligence pool (that's data, not published) — only to text that
 * gets WRITTEN to Amazon, and to seeds (so we don't spend a credit researching a trademark term).
 */

// Order matters: more-specific marks first so "FIFA World Cup" collapses cleanly to one safe phrase.
// `sub: ''` = no safe synonym → drop the mark. Extend this list here (or lift to per-seller config, scope C).
const TRADEMARK_RULES: { mark: string; sub: string }[] = [
  { mark: 'fifa\\s+world\\s+cup', sub: 'world futbol cup' },
  { mark: 'world\\s+cup', sub: 'world futbol cup' }, // the PO's primary case (2026-07-21: futbol > soccer)
  { mark: 'super\\s*bowl', sub: 'big game' },
  { mark: 'fifa', sub: '' },
  { mark: 'olympics?', sub: '' },
  { mark: 'paralympics?', sub: '' },
  { mark: 'nfl', sub: '' },
  { mark: 'nba', sub: '' },
  { mark: 'mlb', sub: '' },
  { mark: 'nhl', sub: '' },
  { mark: 'ncaa', sub: '' },
  // MEDIA/PARK MARKS (2026-08-20): the fresh futbol harvest surfaced "disney world shirts" and the
  // composer's trademark door passed it — the lexicon covered leagues but no media franchises. The
  // empty sub follows the league precedent: scrub paths drop the mark; the composer's byte-identity
  // door rejects the whole phrase (a candidate naming a franchise never composes).
  { mark: 'disney(?:\\s*(?:land|world))?', sub: '' },
  { mark: 'marvel', sub: '' },
  { mark: 'star\\s*wars', sub: '' },
  { mark: 'harry\\s*potter', sub: '' },
  { mark: 'pokemon', sub: '' },
  { mark: 'nintendo', sub: '' },
  { mark: 'hello\\s*kitty', sub: '' },
  { mark: 'nike', sub: '' },
  { mark: 'adidas', sub: '' },
  // REGISTERED APPAREL MARK (2026-08-21): "salt life shirts" surfaced in a live fishing-family pool.
  // A mark, not a blank maker — so it lives here (every published field + the composer's
  // byte-identity door), not in the composer's APPAREL_BRAND_RE.
  { mark: 'salt\\s*life', sub: '' },
]

/** Casing helper: keep the substitution's case roughly matching the matched text so a Title-Case
 *  title doesn't get a lowercase "world soccer cup" spliced into it. */
function matchCase(sub: string, matched: string): string {
  if (!sub) return sub
  if (matched === matched.toUpperCase()) return sub.toUpperCase()
  // Title Case if the matched mark started with a capital (the common title/bullet case).
  if (/^[A-Z]/.test(matched)) return sub.replace(/\b\w/g, (c) => c.toUpperCase())
  return sub
}

/** Build the trademark clause used by the title-council adversary prompt (spec §5.4 / TITLE_COUNCIL_V3):
 *  the adversary used to hardcode "World Cup -> World Soccer Cup" — stale since the 2026-07-21 PO flip
 *  to "World Futbol Cup". Generating the clause from TRADEMARK_RULES keeps prompt text in sync with the
 *  runtime scrub so an adversary can NEVER instruct the judge to use a substitution the scrub then
 *  overwrites. Marks with a safe substitute render as `"foo" -> "bar"`; marks that must be dropped
 *  render as `"foo"` in the drop list. */
export function buildAdversaryTrademarkClause(): string {
  const subs: string[] = []
  const drops: string[] = []
  for (const { mark, sub } of TRADEMARK_RULES) {
    // Regex-escaped mark -> a display form the model can read (`world\s+cup` -> `world cup`).
    const display = mark.replace(/\\s\+/g, ' ').replace(/\\s\*/g, ' ').replace(/\\/g, '').replace(/\?$/, '').trim()
    if (sub) subs.push(`"${display}" -> "${sub}"`)
    else drops.push(`"${display}"`)
  }
  const parts: string[] = []
  if (subs.length) parts.push(`Substitute: ${subs.join('; ')}`)
  if (drops.length) parts.push(`Drop: ${drops.join(', ')}`)
  return `FLAG any trademarked phrase (sports teams, leagues, universities, media franchises) and REQUIRE the safe swap. ${parts.join('. ')}.`
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * SUBSTITUTION IDEMPOTENCE (live defect B0GVVY5TS9, 2026-08-09).
 *
 * THE SHIPPED SPECIMEN, verbatim:
 *   THE CEO Futbol World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve
 * "Futbol World Futbol Cup". The council wrote "Futbol World Cup" (a bilingual design — "futbol" is
 * this seller's own design vocabulary), the `world cup -> world futbol cup` rule fired ON TOP of a
 * token its own substitution supplies, and the result reads as gibberish.
 *
 * The old idempotence claim ("the safe phrasing contains no protected mark, so re-running is a
 * no-op") was true only of the scrub's OWN output in isolation. It said nothing about input that
 * ALREADY carries the distinguishing token, and it could not see the second half of the live loop:
 * `collapseRepeatedWords` (titleBand.ts) deletes the repeated "Futbol", which RESURRECTS the bare
 * "World Cup", and the route's scrub-on-serve (ai-recommendations/route.ts:2017) then re-doubles it.
 * Two nets, each locally correct, oscillating on the shipped bytes.
 *
 * THE RULE: a substitution must never print a token the adjacent context already supplies. Two
 * shapes, distinguished by how the substitution relates to the mark:
 *   INSERTION  (sub ⊇ mark tokens + exactly ONE new token) — "world cup" -> "world futbol cup".
 *              The new token is ABSORBED when it sits immediately before or after the result, so
 *              "Futbol World Cup" -> "World Futbol Cup" (mark gone, token printed once).
 *   REPLACEMENT (sub shares no structure with the mark) — "super bowl" -> "big game". Only an
 *              immediately-repeated WHOLE substitution collapses ("Big Game Super Bowl" ->
 *              "Big Game"). Deliberately NOT the single-token rule: "big"/"game" are ordinary
 *              English, and absorbing them one at a time would eat "Board Game Super Bowl".
 * Adjacency-only, by construction — a distant "futbol" is left alone; deleting a word elsewhere in
 * the string is a rewrite, not a scrub.
 */

/** Regex-escape a literal for embedding in a RegExp. */
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A rule's MARK as plain display words: `world\s+cup` -> ['world','cup'] (twin of the display
 *  derivation in buildAdversaryTrademarkClause — same escapes, same order). */
function markWords(mark: string): string[] {
  return mark
    .replace(/\\s[+*]/g, ' ')
    .replace(/\\/g, '')
    .replace(/\?/g, '')
    .toLowerCase().split(/\s+/).filter(Boolean)
}

/** Precomputed per substituting rule: the sub as a whitespace-tolerant pattern, plus the single
 *  INSERTED token when the rule is an insertion (null for a replacement rule). Derived from
 *  TRADEMARK_RULES itself, so adding a rule needs no second edit here. */
const TM_ABSORB: { subPattern: string; insertToken: string | null }[] = TRADEMARK_RULES
  .filter((r) => r.sub)
  .map(({ mark, sub }) => {
    const mw = markWords(mark)
    const sw = sub.toLowerCase().split(/\s+/).filter(Boolean)
    const added = sw.filter((w) => !mw.includes(w))
    const isInsertion = mw.every((w) => sw.includes(w)) && added.length === 1
    return { subPattern: sw.map(reEsc).join('\\s+'), insertToken: isInsertion ? added[0] : null }
  })

/** Collapse the adjacency a substitution just created. Pure; loops each rewrite to a fixed point so
 *  a run of three ("Futbol World Futbol Cup Futbol") settles in one call. */
function absorbSubstitutionDuplicates(text: string): string {
  let out = text
  const collapse = (re: RegExp, rep: string): void => {
    let prev: string
    do { prev = out; out = out.replace(re, rep) } while (out !== prev)
  }
  for (const { subPattern, insertToken } of TM_ABSORB) {
    // (1) the whole substitution printed twice in a row — the REPLACEMENT shape
    //     ("Big Game Super Bowl Party" -> "Big Game Big Game Party" -> "Big Game Party").
    collapse(new RegExp(`\\b(?:${subPattern})\\s+(?=(?:${subPattern})\\b)`, 'gi'), '')
    if (!insertToken) continue
    const tok = reEsc(insertToken)
    // (2) the inserted token immediately BEFORE the substitution — the live defect.
    collapse(new RegExp(`\\b${tok}\\s+(?=(?:${subPattern})\\b)`, 'gi'), '')
    // (3) ... or immediately AFTER it ("World Cup Futbol" -> "World Futbol Cup").
    collapse(new RegExp(`\\b((?:${subPattern}))\\s+${tok}\\b`, 'gi'), '$1')
  }
  return out
}

/** One substitution sweep: every protected mark -> its safe substitution (or dropped). */
function substituteMarks(text: string): string {
  let out = text
  for (const { mark, sub } of TRADEMARK_RULES) {
    const re = new RegExp(`\\b${mark}\\b`, 'gi')
    out = out.replace(re, (m) => matchCase(sub, m))
  }
  return out
}

/** Guard rail on the self-checking loop below — a stable rule set converges in ONE pass; anything
 *  that does not is a rule-table bug and must be shouted about, not spun on. */
const TM_MAX_PASSES = 4

/** Replace every protected mark with its safe substitution (or drop it), then tidy the artifacts
 *  a drop/substitution leaves behind (doubled spaces, space-before-punct, dangling commas).
 *
 *  SELF-CHECKING: substitute + absorb is applied until the string stops changing, so the returned
 *  value is a FIXED POINT — `scrubTrademarks(scrubTrademarks(x)) === scrubTrademarks(x)` for every
 *  input, which is exactly the property the route's scrub-on-serve and the generation-exit scrub
 *  both rely on. A rule set that cannot converge logs TRADEMARK_SCRUB_UNSTABLE and bails at the
 *  last stable value rather than looping. */
export function scrubTrademarks(text: string): string {
  if (!text) return text
  let out = text
  for (let pass = 1; ; pass++) {
    const next = absorbSubstitutionDuplicates(substituteMarks(out))
    if (next === out) break
    out = next
    if (pass >= TM_MAX_PASSES) {
      console.warn(JSON.stringify({ tag: 'TRADEMARK_SCRUB_UNSTABLE', passes: pass, input: text, out }))
      break
    }
  }
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim()
}

/** Scrub an array of published strings (bullets / per-child backend keyword lines). */
export function scrubTrademarksArr(items: (string | null | undefined)[]): string[] {
  return items.map((s) => scrubTrademarks(s || ''))
}

/** True if the text STILL contains a protected mark — for assertions/flagging. Builds a fresh
 *  non-global regex each call so there is no stateful-lastIndex bug. */
export function hasTrademark(text: string): boolean {
  if (!text) return false
  return TRADEMARK_RULES.some(({ mark }) => new RegExp(`\\b${mark}\\b`, 'i').test(text))
}

/** Identifier fields a deep scrub must NEVER rewrite: SKU codes and IDs may legitimately embed
 *  mark-like tokens (a family literally named "France-World-Cup-TS-Parent"); rewriting them would
 *  corrupt references. (The whitespace-based rules can't match hyphenated codes anyway — this is
 *  defense in depth.) */
const DEEP_SCRUB_SKIP_KEYS = new Set(['sku', 'asin', 'parent_asin', 'top_child_asin', 'seller_central_path', 'element', 'key', 'designKey', 'field_name', 'spApiKey'])

/** Recursively scrub every STRING VALUE in a JSON-ish structure (arrays/objects/strings), skipping
 *  identifier keys. For seller-facing structured blobs the field-level scrubs don't reach — the
 *  audit's action_plan / keyword_reconciliation (PO-caught leak 2026-07-02: "france world cup tee"
 *  in an action-plan copy block). Idempotent like scrubTrademarks itself. */
export function scrubTrademarksDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubTrademarks(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => scrubTrademarksDeep(v)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = DEEP_SCRUB_SKIP_KEYS.has(k) ? v : scrubTrademarksDeep(v)
    }
    return out as unknown as T
  }
  return value
}
