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

/** Replace every protected mark with its safe substitution (or drop it), then tidy the artifacts
 *  a drop/substitution leaves behind (doubled spaces, space-before-punct, dangling commas). Idempotent:
 *  the safe phrasing "World Soccer Cup" contains no protected mark, so re-running is a no-op. */
export function scrubTrademarks(text: string): string {
  if (!text) return text
  let out = text
  for (const { mark, sub } of TRADEMARK_RULES) {
    const re = new RegExp(`\\b${mark}\\b`, 'gi')
    out = out.replace(re, (m) => matchCase(sub, m))
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
