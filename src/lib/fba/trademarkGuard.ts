/**
 * Trademark output scrub (PO 2026-06-15). Protected marks must NEVER be PUBLISHED to a listing —
 * "World Cup" is FIFA's registered trademark; the seller's safe convention is "World Soccer Cup".
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
  { mark: 'fifa\\s+world\\s+cup', sub: 'world soccer cup' },
  { mark: 'world\\s+cup', sub: 'world soccer cup' }, // the PO's primary case
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
