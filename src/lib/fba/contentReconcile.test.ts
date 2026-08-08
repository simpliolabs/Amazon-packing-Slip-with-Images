import { describe, it, expect } from 'vitest'
import {
  contentReconcileMode,
  describeContentReconcileMode,
  decideReconcileFields,
  jsonChanged,
  perChildChanged,
  resolveTitleLocked,
  type ReconcileCandidate,
} from './contentReconcile'

// CONTENT-RECONCILE decision rules (PO 2026-08-08, SELLER_PROFILE §10): a core field
// auto-ships iff changed ∧ previously-shipped ∧ ¬degrade-preserved ∧ ¬(title ∧ locked).
// The enqueue side (evidence query, dedupe, recency guard, push_jobs insert) is exercised
// live; THIS file pins the pure rules so neither write path can drift from them.

const cand = (field: ReconcileCandidate['field'], changed = true, degradePreserved = false): ReconcileCandidate =>
  ({ field, changed, degradePreserved })

describe('contentReconcileMode — house flag semantics (UNSET = SHADOW; only explicit truthy goes live)', () => {
  it.each([
    // UNSET / blank → shadow soak by default (off→shadow→on doctrine — deploy ≠ activation)
    [undefined, 'shadow'],
    ['', 'shadow'],
    ['   ', 'shadow'],
    ['shadow', 'shadow'],
    ['SHADOW', 'shadow'],
    // a typo or unknown value must NEVER mean live autonomous writes
    ['anything-else', 'shadow'],
    ['enabled', 'shadow'],
    // explicit truthy → live enqueue
    ['1', 'on'],
    ['true', 'on'],
    ['on', 'on'],
    ['yes', 'on'],
    ['ON', 'on'],
    [' Yes ', 'on'],
    // explicit disable — the widened set (no/disabled included; AUTO_RESHIP habit compatible)
    ['0', 'off'],
    ['false', 'off'],
    ['off', 'off'],
    ['no', 'off'],
    ['disabled', 'off'],
    ['OFF', 'off'],
    [' False ', 'off'],
    ['Disabled', 'off'],
  ] as [string | undefined, string][])('%j → %s', (raw, expected) => {
    expect(contentReconcileMode(raw)).toBe(expected)
  })
})

describe('describeContentReconcileMode — /api/health echoes the EFFECTIVE mode', () => {
  it.each([
    [undefined, 'shadow (default)'],  // null must never read as "off" for THIS flag
    ['', 'shadow (default)'],
    ['   ', 'shadow (default)'],
    ['shadow', 'shadow'],
    ['on', 'on'],
    ['1', 'on'],
    ['off', 'off'],
    ['no', 'off'],
    ['garbage-value', 'shadow'],      // unknown value runs shadow — echo says so
  ] as [string | undefined, string][])('%j → %j', (raw, expected) => {
    expect(describeContentReconcileMode(raw)).toBe(expected)
  })
})

describe('jsonChanged / perChildChanged — the per-child compare halves', () => {
  it.each([
    // [name, next, prior, expected]
    ['identical arrays → unchanged', [{ sku: 'A', title: 'x' }], [{ sku: 'A', title: 'x' }], false],
    ['byte-different title → changed', [{ sku: 'A', title: 'x' }], [{ sku: 'A', title: 'y' }], true],
    ['null vs null → unchanged', null, null, false],
    ['undefined folds to null (jsonChanged only)', undefined, null, false],
    ['null vs [] → changed (empty list IS a value)', null, [], true],
    ['added entry → changed', [{ sku: 'A' }, { sku: 'B' }], [{ sku: 'A' }], true],
    ['string vs same string → unchanged', ['b1', 'b2'], ['b1', 'b2'], false],
    ['reordered array → changed (order is content for bullets)', ['b1', 'b2'], ['b2', 'b1'], true],
  ] as [string, unknown, unknown, boolean][])('%s', (_n, next, prior, expected) => {
    expect(jsonChanged(next, prior)).toBe(expected)
  })

  it('perChildChanged: undefined next = the column did NOT land in this persist → unchanged', () => {
    // Partial path: `upd.per_child_*` is undefined when the section had no per-child output OR
    // the missing-column retry deleted it — either way nothing per-child persisted this run.
    expect(perChildChanged(undefined, [{ sku: 'A', title: 'x' }])).toBe(false)
    expect(perChildChanged(undefined, null)).toBe(false)
  })

  it('perChildChanged: an explicit null IS a written value and compares normally', () => {
    expect(perChildChanged(null, [{ sku: 'A', title: 'x' }])).toBe(true)
    expect(perChildChanged(null, null)).toBe(false)
    expect(perChildChanged([{ sku: 'A', title: 'x' }], null)).toBe(true)
  })
})

describe('resolveTitleLocked — FAIL CLOSED on an unreadable lock state', () => {
  it.each([
    // [titleSource, lockReadFailed, expected]
    ['manual', false, true],
    ['ai', false, false],
    [undefined, false, false],   // column absent (pre-044) on a SUCCESSFUL read → genuinely no lock
    [null, false, false],
    ['ai', true, true],          // read failed → unknown ≠ unlocked, even if a stale value says 'ai'
    ['manual', true, true],
    [undefined, true, true],     // the BLOCKER case: failed read must never resolve to unlocked
  ] as [string | null | undefined, boolean, boolean][])('source=%j readFailed=%s → %s', (src, failed, expected) => {
    expect(resolveTitleLocked(src, failed)).toBe(expected)
  })
})

describe('decideReconcileFields — changed + shipped + notDegraded ⇒ field ships', () => {
  it.each([
    // [name, changed, degradePreserved, shipped, expected-included]
    ['all three conditions met', true, false, true, true],
    ['not changed (absence-of-write / byte-identical = preserved)', false, false, true, false],
    ['degrade-preserved this run (prior is better — pushing is churn)', true, true, true, false],
    ['never previously shipped (first-time stays behind the review gate)', true, false, false, false],
    ['changed but degraded AND unshipped', true, true, false, false],
  ] as [string, boolean, boolean, boolean, boolean][])('%s', (_name, changed, degraded, shipped, included) => {
    const out = decideReconcileFields({
      candidates: [cand('bullets', changed, degraded)],
      shippedFields: shipped ? ['bullets'] : [],
      titleLocked: false,
    })
    expect(out).toEqual(included ? ['bullets'] : [])
  })

  it('evidence miss fails SAFE: legacy NULL-field log rows read as no-evidence → no auto-push', () => {
    const out = decideReconcileFields({
      candidates: [cand('title'), cand('bullets'), cand('description'), cand('keywords')],
      shippedFields: [],
      titleLocked: false,
    })
    expect(out).toEqual([])
  })

  it('manual title lock drops ONLY the title — other shipped fields still reconcile', () => {
    const out = decideReconcileFields({
      candidates: [cand('title'), cand('bullets'), cand('keywords')],
      shippedFields: ['title', 'bullets', 'keywords'],
      titleLocked: true,
    })
    expect(out).toEqual(['bullets', 'keywords'])
  })

  it('fail-closed lock (unreadable state) behaves exactly like a manual lock', () => {
    const out = decideReconcileFields({
      candidates: [cand('title'), cand('bullets')],
      shippedFields: ['title', 'bullets'],
      titleLocked: resolveTitleLocked('ai', true), // read failed → locked
    })
    expect(out).toEqual(['bullets'])
  })

  it('per-field independence: a degraded keywords section never blocks the healthy bullets', () => {
    const out = decideReconcileFields({
      candidates: [cand('bullets', true, false), cand('keywords', true, true)],
      shippedFields: ['bullets', 'keywords'],
      titleLocked: false,
    })
    expect(out).toEqual(['bullets'])
  })

  it('partial path shape: a single-section candidate considers ONLY that field', () => {
    const out = decideReconcileFields({
      candidates: [cand('description')],
      shippedFields: ['title', 'bullets', 'description', 'keywords'],
      titleLocked: false,
    })
    expect(out).toEqual(['description'])
  })

  it('per-child-only change still reconciles: broadcast equal but per-child twin differs', () => {
    // The call sites OR perChildChanged into `changed` — this pins the composed rule the
    // multi-design blind-spot fix depends on (broadcast byte-equal, per-child copy moved).
    const broadcastChanged = false
    const changed = broadcastChanged || perChildChanged([{ sku: 'A', title: 'new' }], [{ sku: 'A', title: 'old' }])
    const out = decideReconcileFields({
      candidates: [cand('title', changed)],
      shippedFields: ['title'],
      titleLocked: false,
    })
    expect(out).toEqual(['title'])
  })

  it('output is normalized to PUSH_FIELDS order regardless of candidate order', () => {
    const out = decideReconcileFields({
      candidates: [cand('keywords'), cand('description'), cand('title'), cand('bullets')],
      shippedFields: ['title', 'bullets', 'description', 'keywords'],
      titleLocked: false,
    })
    expect(out).toEqual(['title', 'bullets', 'description', 'keywords'])
  })

  it('no candidates → no fields (a regen that persisted nothing reconciles nothing)', () => {
    expect(decideReconcileFields({ candidates: [], shippedFields: ['title'], titleLocked: false })).toEqual([])
  })
})
