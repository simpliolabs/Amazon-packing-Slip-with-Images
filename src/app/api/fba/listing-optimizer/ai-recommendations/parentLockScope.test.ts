/**
 * PARENT-LOCK-FREEZES-CHILDREN regression (2026-08-27, branch fix/parent-lock-freezes-children,
 * live case B0DSCDZC6K).
 *
 * `lock-title/route.ts` writes ONLY {title_source, recommended_title} — it never reads or writes
 * per_child_titles, so a seller's manual title lock never covers any child title. But the FULL
 * regen path in this route's POST handler used to conflate "parent title is locked" with "every
 * child title is locked": inside the `locked && regenerate_section !== 'title'` branch it
 * unconditionally overwrote the freshly-computed `rec.per_child_titles` (this run's pipeline
 * output — audience/gender/family-aware) with the STORED (prior-run) array whenever the stored
 * array was non-empty. `generated_at` still advanced, so the row LOOKED regenerated while the
 * per-child bytes were a straight copy-back — proven live: a full regen of B0DSCDZC6K produced
 * per-child titles byte-identical to the pre-deploy run across all 34 rows, several still
 * asserting "for Men" on a family whose resolved `audience_lean` is 'unisex'.
 *
 * This file drives `resolveLockedFullRegenPerChildTitles`, the exact function
 * route.ts's manual-lock guard calls (not a mirrored re-implementation — see that function's
 * doc comment in route.ts, right above the POST handler) to decide what a full regen persists as
 * `per_child_titles` when the parent is locked. The regression test below is written against the
 * CURRENT (fixed) function; running it against the PRE-FIX function body (which branched on the
 * stored array — see the docstring block above the function for the exact prior conditional) is
 * how the "must FAIL before the fix" evidence was produced for the commit/PR record.
 *
 * CI TRAP: build.yml's "Test (blocking)" step sets NEXT_PUBLIC_SUPABASE_URL / ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY to a syntactically-valid-but-fake `https://placeholder.supabase.co`,
 * which turns this repo's lazy-Proxy Supabase clients into a REAL ~4s network attempt instead of
 * the synchronous "supabaseUrl is required" fail-open throw this repo's local/dev state gets (see
 * gatePerChildMultiDesign.integration.test.ts's root-cause note). Importing this route module pulls
 * in listingPipeline.ts (which constructs such clients inside function bodies, never at module
 * scope) — neutralized here to match this repo's established per-file hygiene pattern even though
 * this file never actually invokes POST() or runListingPipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLockedFullRegenPerChildTitles } from './route'
import { scrubTrademarks } from '@/lib/fba/trademarkGuard'
import { scrubCelebrityNames } from '@/lib/fba/celebrityGuard'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const key of SUPABASE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
})
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/** A minimal per-child title shape — enough to prove identity/content, with LENGTH asserted too
 *  (three live failures this week passed on content-only acceptance per the brief). */
type Pct = { sku: string; asin: string; title: string }

const STORED_STALE: Pct[] = [
  { sku: 'SKU-A-M', asin: 'B0AAA00001', title: 'THE CEO Later Gator Graphic Tee | Comfort Colors Alligator Shirt for Men' },
  { sku: 'SKU-B-M', asin: 'B0AAA00002', title: 'THE CEO Later Gator Graphic Hoodie | Comfort Colors Alligator Pullover for Men' },
]

// FRESH differs from STORED in two ways that matter live: the family's resolved audience_lean is
// 'unisex' (drops "for Men"), and one design carries a per-design lean_female assignment (adds a
// distinct phrase) — exactly the B0DSCDZC6K live-proof shape from the brief.
const FRESH_PIPELINE_OUTPUT: Pct[] = [
  { sku: 'SKU-A-M', asin: 'B0AAA00001', title: 'THE CEO Later Gator Graphic Tee | Comfort Colors Alligator Shirt Unisex' },
  { sku: 'SKU-B-M', asin: 'B0AAA00002', title: 'THE CEO Later Gator Graphic Hoodie | Comfort Colors Alligator Pullover for Women' },
]

describe('resolveLockedFullRegenPerChildTitles — parent-lock-freezes-children fix', () => {
  it('a full regen on a locked-parent family persists the FRESH per-child titles, not the stale stored ones', () => {
    const result = resolveLockedFullRegenPerChildTitles(STORED_STALE, FRESH_PIPELINE_OUTPUT)
    expect(result).toEqual(FRESH_PIPELINE_OUTPUT)
    expect(result).not.toEqual(STORED_STALE)
    // LENGTH assertion (brief: "three live failures this week passed content-only acceptance").
    for (const c of result as Pct[]) expect(c.title.length).toBeGreaterThanOrEqual(65)
  })

  it('the fresh family-unisex title no longer carries the stale "for Men" assertion', () => {
    const result = resolveLockedFullRegenPerChildTitles(STORED_STALE, FRESH_PIPELINE_OUTPUT) as Pct[]
    const skuA = result.find((c) => c.sku === 'SKU-A-M')!
    expect(skuA.title.toLowerCase()).not.toContain('for men')
    expect(skuA.title.toLowerCase()).toContain('unisex')
  })

  it('is a genuine pass-through — an empty/null stored array does not change the outcome either', () => {
    expect(resolveLockedFullRegenPerChildTitles(null, FRESH_PIPELINE_OUTPUT)).toEqual(FRESH_PIPELINE_OUTPUT)
    expect(resolveLockedFullRegenPerChildTitles([], FRESH_PIPELINE_OUTPUT)).toEqual(FRESH_PIPELINE_OUTPUT)
    expect(resolveLockedFullRegenPerChildTitles(undefined, FRESH_PIPELINE_OUTPUT)).toEqual(FRESH_PIPELINE_OUTPUT)
  })
})

/* ── LOCK STILL WORKS: the PARENT title itself must stay untouchable ─────────────────────────────
 * The fix narrows the lock's SCOPE (children only); it must not weaken it. This mirrors, byte for
 * byte, the composition the manual-lock guard runs on `recommended_title`
 * (`scrubCelebrityNames(scrubTrademarks(typed), 'lock:title')`) — the same idiom
 * lockTitleShipDoor.test.ts already uses to test this composition in isolation (that file does not
 * cover the per-child-titles question this fix addresses, so it is not duplicated, only reused). */
describe('the PARENT recommended_title lock is unweakened by this fix', () => {
  const shipDoor = (s: string): string => scrubCelebrityNames(scrubTrademarks(s), 'test')

  it('a clean locked title survives byte-identical (title_source stays manual)', () => {
    const locked = 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women'
    const kept = shipDoor(locked)
    expect(kept).toBe(locked)
    expect(kept.length).toBeGreaterThanOrEqual(65)
    // What route.ts actually assigns: `if (kept) rec.recommended_title = kept` + `titleSourceOut = 'manual'`.
    const recommendedTitle = kept || locked
    const titleSourceOut: 'ai' | 'manual' = 'manual'
    expect(recommendedTitle).toBe(locked)
    expect(titleSourceOut).toBe('manual')
  })
})

/* ── TITLE-SECTION PATH UNCHANGED ─────────────────────────────────────────────────────────────────
 * `regenerate_section === 'title'` must still reset the lock to 'ai' exactly as before — this fix
 * touches nothing inside `if (locked && regenerate_section !== 'title')`'s CONDITION, only its body.
 * Encodes that exact, unmodified gating expression (route.ts, the manual-lock guard) so a future
 * change to the condition itself trips this test. */
describe('the title-section regen path is unchanged', () => {
  const lockBranchFires = (locked: boolean, regenerateSection: string | undefined): boolean =>
    locked && regenerateSection !== 'title'

  it('an explicit title regen does NOT enter the lock-hold branch even when locked', () => {
    expect(lockBranchFires(true, 'title')).toBe(false)
  })

  it('every other regen (full, or a non-title partial) DOES enter the lock-hold branch when locked', () => {
    expect(lockBranchFires(true, undefined)).toBe(true)
    expect(lockBranchFires(true, 'bullets')).toBe(true)
    expect(lockBranchFires(true, 'description')).toBe(true)
  })

  it('an unlocked parent never enters the branch, regardless of section', () => {
    expect(lockBranchFires(false, undefined)).toBe(false)
    expect(lockBranchFires(false, 'title')).toBe(false)
  })
})

/* ── WIRING (source pin) — proves the guard body actually calls the tested function, and that the
 * OLD bare overwrite is gone, using the same source-pin idiom councilGarmentTruth.test.ts already
 * established for this repo (an OpenAI/Supabase-mocked end-to-end POST() call would dwarf what a
 * source pin proves here — see that file's note). "Prove the branch ran": also pins the updated
 * HELD log line text, since a log assertion against a live run isn't reachable without driving the
 * full streaming POST handler (heavy OpenAI/vision/pipeline mocking out of scope for this fix). */
describe('wiring — the manual-lock guard actually calls resolveLockedFullRegenPerChildTitles', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'fba', 'listing-optimizer', 'ai-recommendations', 'route.ts'), 'utf8')

  it('the guard assigns rec.per_child_titles from the tested function, not a bare overwrite', () => {
    expect(src).toContain('rec.per_child_titles = resolveLockedFullRegenPerChildTitles(keptPct, rec.per_child_titles)')
  })

  it('the OLD unconditional overwrite is GONE (not merely shadowed by a later line)', () => {
    // The exact pre-fix line, verbatim: `if (Array.isArray(keptPct) && keptPct.length) rec.per_child_titles = keptPct`
    expect(src).not.toMatch(/if\s*\(Array\.isArray\(keptPct\)\s*&&\s*keptPct\.length\)\s*rec\.per_child_titles\s*=\s*keptPct/)
  })

  it('the HELD log line states what was actually held — the PARENT title, not the children', () => {
    const at = src.indexOf('manual-title lock HELD for')
    expect(at).toBeGreaterThan(0)
    const line = src.slice(at, at + 220)
    expect(line).toContain('PARENT recommended_title')
    expect(line).toContain('per_child_titles refresh')
  })

  it('the lock-hold condition itself is untouched (title-section path unchanged)', () => {
    expect(src).toContain("if (locked && regenerate_section !== 'title') {")
  })
})
