/**
 * titleLearningMiner.test.ts — the miner as a PURE function over fixture `listing_change_log` rows.
 *
 * Every test asserts on real CONTENT (exact strings survive/are excluded) AND on COUNTS (a filter
 * that silently returns an empty corpus must not be able to pass as "no bad golds" — see the
 * `[truth filter]` block, which proves `verdictForAssembledTitle` itself excludes a real lying title
 * before ever trusting `mineTitleGolds`'s consumption of the stamped column).
 */
import { describe, it, expect } from 'vitest'
import { mineTitleGolds, mineTitleRejectPairs, type ChangeLogTitleRow, REJECT_PAIR_BRIEF_LIMIT } from './titleLearningMiner'
import { verdictForAssembledTitle, type AssembledTitleCtx } from './titleBand'
import { buildPhraseTruthCtx, type PhraseTruthFacts } from './contentTruth'

/** A fully-specified row with sane defaults, so each test only states what it varies. */
function row(over: Partial<ChangeLogTitleRow> & { parent_asin: string; changed_at: string }): ChangeLogTitleRow {
  return {
    sku: null,
    field: 'title (locked)',
    action: 'edit',
    source: 'manual_edit',
    before_value: '',
    after_value: '',
    title_truth_ok: true,
    title_truth_reason: null,
    ...over,
  }
}

describe('mineTitleGolds', () => {
  it('LAST-WORD-ONLY: an earlier lock on the same family is superseded and excluded, only the newest survives', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0AAA', changed_at: '2026-08-01T00:00:00Z', after_value: 'THE CEO Old Design Tee Shirt | Comfort Colors Graphic Tee for Women' }),
      row({ parent_asin: 'B0AAA', changed_at: '2026-08-10T00:00:00Z', after_value: 'THE CEO New Design Tee Shirt | Comfort Colors Graphic Tee for Women' }),
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(1)                          // NOT 2 — the earlier lock is superseded
    expect(golds[0].title).toBe('THE CEO New Design Tee Shirt | Comfort Colors Graphic Tee for Women')
    expect(golds.some((g) => g.title.includes('Old Design'))).toBe(false)
  })

  it('TRUTH FILTER: title_truth_ok=false excludes; title_truth_ok=null (unvetted) ALSO excludes — only true admits', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0LIE', changed_at: '2026-08-10T00:00:00Z', after_value: 'A lying title', title_truth_ok: false, title_truth_reason: 'wrong-garment-noun' }),
      row({ parent_asin: 'B0UNVET', changed_at: '2026-08-10T00:00:00Z', after_value: 'Not yet vetted title', title_truth_ok: null }),
      row({ parent_asin: 'B0TRUE', changed_at: '2026-08-10T00:00:00Z', after_value: 'A truthful title', title_truth_ok: true }),
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(1)
    expect(golds[0].title).toBe('A truthful title')
    expect(golds.map((g) => g.parent_asin)).not.toContain('B0LIE')
    expect(golds.map((g) => g.parent_asin)).not.toContain('B0UNVET')
  })

  it('PER-DESIGN ATTRIBUTION: two different SKUs under the SAME parent both survive as separate golds', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0FAM', sku: 'SKU-RED', changed_at: '2026-08-10T00:00:00Z', after_value: 'THE CEO Red Design Tee Shirt | Comfort Colors Graphic Tee for Women' }),
      row({ parent_asin: 'B0FAM', sku: 'SKU-BLUE', changed_at: '2026-08-11T00:00:00Z', after_value: 'THE CEO Blue Design Tee Shirt | Comfort Colors Graphic Tee for Women' }),
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(2)                           // the whole point: per-design, not per-parent
    const bySku = new Map(golds.map((g) => [g.sku, g.title]))
    expect(bySku.get('SKU-RED')).toBe('THE CEO Red Design Tee Shirt | Comfort Colors Graphic Tee for Women')
    expect(bySku.get('SKU-BLUE')).toBe('THE CEO Blue Design Tee Shirt | Comfort Colors Graphic Tee for Women')
  })

  it('a later lock on a DIFFERENT sku under the same parent does not supersede a sibling design\'s gold', () => {
    // Guards against a key bug class: grouping by parent_asin alone (ignoring sku) would make the
    // newest lock ANYWHERE in the family evict every other design's gold.
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0FAM', sku: 'SKU-RED', changed_at: '2026-08-01T00:00:00Z', after_value: 'THE CEO Red Design Tee Shirt | Comfort Colors Graphic Tee for Women' }),
      row({ parent_asin: 'B0FAM', sku: 'SKU-BLUE', changed_at: '2026-08-20T00:00:00Z', after_value: 'THE CEO Blue Design Tee Shirt | Comfort Colors Graphic Tee for Women' }),
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(2)
    expect(golds.some((g) => g.sku === 'SKU-RED')).toBe(true)
  })

  it('DEDUP: two different (parent_asin, sku) keys that locked the IDENTICAL title collapse to ONE, newest wins', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0ONE', changed_at: '2026-08-01T00:00:00Z', after_value: 'THE CEO Shared Text Tee Shirt | Comfort Colors Graphic Tee for Women' }),
      row({ parent_asin: 'B0TWO', changed_at: '2026-08-15T00:00:00Z', after_value: 'the ceo shared text tee shirt | comfort colors graphic tee for women' }), // same text, different case
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(1)
    expect(golds[0].parent_asin).toBe('B0TWO')             // the newer occurrence survives
  })

  it('excludes non-candidate rows: unlock, push, ai-sourced, and empty after_value', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0X1', changed_at: '2026-08-10T00:00:00Z', field: 'title (unlocked)', before_value: 'A', after_value: 'A' }),
      row({ parent_asin: 'B0X2', changed_at: '2026-08-10T00:00:00Z', action: 'push', source: 'push_executor', after_value: 'THE CEO Pushed Not Locked Tee Shirt | Comfort Colors Graphic Tee for Women' }),
      row({ parent_asin: 'B0X3', changed_at: '2026-08-10T00:00:00Z', source: 'ai', after_value: 'THE CEO AI Written Tee Shirt | Comfort Colors Graphic Tee for Women' }),
      row({ parent_asin: 'B0X4', changed_at: '2026-08-10T00:00:00Z', after_value: '' }),
      row({ parent_asin: 'B0X5', changed_at: '2026-08-10T00:00:00Z', field: 'bullet_1', after_value: 'not a title field' }),
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(0)
  })

  it('respects the limit cap, newest first', () => {
    const rows: ChangeLogTitleRow[] = Array.from({ length: 20 }, (_, i) => row({
      parent_asin: `B0N${i}`, changed_at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      after_value: `THE CEO Design Number ${i} Tee Shirt | Comfort Colors Graphic Tee for Women`,
    }))
    const golds = mineTitleGolds(rows, 5)
    expect(golds.length).toBe(5)
    // Newest-first: day 20 down to day 16.
    expect(golds.map((g) => g.title)).toEqual([
      'THE CEO Design Number 19 Tee Shirt | Comfort Colors Graphic Tee for Women',
      'THE CEO Design Number 18 Tee Shirt | Comfort Colors Graphic Tee for Women',
      'THE CEO Design Number 17 Tee Shirt | Comfort Colors Graphic Tee for Women',
      'THE CEO Design Number 16 Tee Shirt | Comfort Colors Graphic Tee for Women',
      'THE CEO Design Number 15 Tee Shirt | Comfort Colors Graphic Tee for Women',
    ])
  })
})

describe('mineTitleRejectPairs', () => {
  it('ALL PAIRS: extracts every before→after edit, including one SUPERSEDED by a later edit', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0SEQ', changed_at: '2026-08-01T00:00:00Z', before_value: 'AI draft A', after_value: 'seller fix A' }),
      row({ parent_asin: 'B0SEQ', changed_at: '2026-08-10T00:00:00Z', before_value: 'seller fix A', after_value: 'seller fix B (final)' }),
    ]
    const pairs = mineTitleRejectPairs(rows, REJECT_PAIR_BRIEF_LIMIT)
    expect(pairs.length).toBe(2)                           // BOTH survive — the PO ruling, not last-word
    expect(pairs.map((p) => `${p.before}→${p.after}`)).toEqual(
      expect.arrayContaining(['AI draft A→seller fix A', 'seller fix A→seller fix B (final)']),
    )
  })

  it('excludes empty before/after and a no-op edit (before === after)', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0E1', changed_at: '2026-08-10T00:00:00Z', before_value: '', after_value: 'seed row, no prior title' }),
      row({ parent_asin: 'B0E2', changed_at: '2026-08-10T00:00:00Z', before_value: 'unlock re-stamp', after_value: 'unlock re-stamp' }),
      row({ parent_asin: 'B0E3', changed_at: '2026-08-10T00:00:00Z', before_value: 'Same Text', after_value: '  same text  ' }), // case/whitespace-only
    ]
    expect(mineTitleRejectPairs(rows, REJECT_PAIR_BRIEF_LIMIT).length).toBe(0)
  })

  it('dedups the exact (before, after) pair and caps at the limit', () => {
    const rows: ChangeLogTitleRow[] = [
      row({ parent_asin: 'B0D1', changed_at: '2026-08-01T00:00:00Z', before_value: 'AI draft', after_value: 'seller fix' }),
      row({ parent_asin: 'B0D2', changed_at: '2026-08-05T00:00:00Z', before_value: 'AI draft', after_value: 'seller fix' }), // exact dupe pair, different family
    ]
    expect(mineTitleRejectPairs(rows, REJECT_PAIR_BRIEF_LIMIT).length).toBe(1)

    const many: ChangeLogTitleRow[] = Array.from({ length: 20 }, (_, i) => row({
      parent_asin: `B0M${i}`, changed_at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      before_value: `AI draft ${i}`, after_value: `seller fix ${i}`,
    }))
    expect(mineTitleRejectPairs(many, 3).length).toBe(3)
  })
})

/* ─── THE TRUTH FILTER, PROVEN — the real live case ─────────────────────────────────────────────── */

describe('truth filter — the real live case (kids_tee family)', () => {
  // A minimal, deliberately spare kids_tee ctx — no spec, no allowed brand, no design tokens — so
  // nothing in this fixture depends on values a real family lookup would supply. Built with the SAME
  // `buildPhraseTruthCtx` every generation/read-time truth site in the app uses (contentTruth.ts) —
  // this test adds no new ctx-construction logic of its own.
  const facts: PhraseTruthFacts = {
    garmentFamily: 'kids_tee',
    spec: null,
    allowedBrand: null,
    designTokens: [],
    audienceLean: 'unisex',
  }
  const ctx = buildPhraseTruthCtx(facts, 'title')
  const verifyCtx: AssembledTitleCtx = { truth: ctx }

  const LYING_TITLE = "Don't Quit Unisex T-Shirt – Motivational Crewneck for Kids & Adults"
  const CLEAN_GOLD = 'THE CEO Don\'t Quit Kids Tee Shirt | Motivational T-Shirt for Children'

  it('EXCLUDES the locked title that calls a kids tee a "Crewneck" (a sweatshirt noun)', () => {
    expect(ctx).not.toBeNull()
    const verdict = verdictForAssembledTitle(LYING_TITLE, verifyCtx)
    expect(verdict.ok).toBe(false)
  })

  it('INCLUDES the PO\'s actual clean gold — 69 chars, asserts "Kids", true garment noun', () => {
    expect(CLEAN_GOLD.length).toBe(69)
    const verdict = verdictForAssembledTitle(CLEAN_GOLD, verifyCtx)
    expect(verdict.ok).toBe(true)
  })

  it('END-TO-END: mineTitleGolds admits only the title that the real predicate above passed', () => {
    // Simulates the ingestion-time stamp (computeTitleTruthVerdict) having already run against this
    // exact ctx for both rows — this is what `lockTitleTruthStamp`/the backfill route actually store.
    const lyingVerdict = verdictForAssembledTitle(LYING_TITLE, verifyCtx)
    const cleanVerdict = verdictForAssembledTitle(CLEAN_GOLD, verifyCtx)
    const rows: ChangeLogTitleRow[] = [
      row({
        parent_asin: 'B0KIDSLIE', changed_at: '2026-08-01T00:00:00Z', after_value: LYING_TITLE,
        title_truth_ok: lyingVerdict.ok, title_truth_reason: lyingVerdict.ok ? null : lyingVerdict.reason,
      }),
      row({
        parent_asin: 'B0KIDSGOLD', changed_at: '2026-08-02T00:00:00Z', after_value: CLEAN_GOLD,
        title_truth_ok: cleanVerdict.ok, title_truth_reason: cleanVerdict.ok ? null : cleanVerdict.reason,
      }),
    ]
    const golds = mineTitleGolds(rows, 12)
    expect(golds.length).toBe(1)                            // NOT 2 — a filter that admits both is broken
    expect(golds[0].parent_asin).toBe('B0KIDSGOLD')
    expect(golds[0].title).toBe(CLEAN_GOLD)
    expect(golds.some((g) => g.parent_asin === 'B0KIDSLIE')).toBe(false)
  })
})
