/**
 * Proves the ACTUAL wiring: resolveChildColor feeding PipelineChild.color makes
 * backendOutputProblems (listingPipeline.ts's degrade gate) stop flagging a family whose per-color
 * backend tails legitimately differentiate — the B0DP5H8QBT-class defect (opaque Amazon-generated
 * SKUs → decodeSkuColor returns null for every child → 0 decoded colours → the gate correctly
 * flags the collapse and then freezes the family's backend forever, since every retry decodes
 * identically). This does NOT touch the gate's own threshold/logic (backendOutputProblems is
 * unchanged, only exported for this test) — it proves that FIXING THE INPUT (colour resolved via
 * the catalog-first resolver instead of raw SKU-text parsing) is what stops it firing, per the PO
 * ruling ("the gate is correct; the input was starving it").
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create: vi.fn() } } } }))

import { backendOutputProblems, type PipelineChild, type PipelinePerChildKeywords } from './listingPipeline'
import { resolveChildColor } from './childColorResolver'

// The live B0DP5H8QBT SKU shape: opaque, Amazon-generated, no colour-bearing segment.
const OPAQUE_SKUS = ['1V-C6WM-US5T', '3A-MINF-4TRD', '4K-WJVI-T618', '5M-0T69-IFXD']
// Repeat the 4 opaque shapes 3x each to model the real 12-child family without inventing new ones.
const FAMILY_SKUS = [...OPAQUE_SKUS, ...OPAQUE_SKUS, ...OPAQUE_SKUS]

function buildChildren(storedColors: Record<string, string | null>): PipelineChild[] {
  return FAMILY_SKUS.map((sku, i) => {
    const asin = `ASIN${i}`
    const { color } = resolveChildColor({ asin, sku, title: null, storedColor: storedColors[sku] ?? null })
    return { sku, asin, color, size: 'M', title: null }
  })
}

// A realistic-length (>=190B) colour-BLIND core, shared by every child — isolates this test to the
// degrade gate's COLOUR-COLLAPSE check (backendOutputProblems's other check, the ≥190B floor, must
// stay clean here or it would push its own problem first and mask the one this test is about).
const CORE_WORDS = ['graphic', 'tee', 'funny', 'gift', 'novelty', 'shirt', 'birthday', 'present', 'family', 'matching', 'group', 'vacation', 'trip', 'weekend', 'friends', 'squad', 'crew', 'apparel', 'top', 'casual', 'fashion', 'clothing', 'unisex', 'adult', 'humor', 'saying', 'quote']
function paddedCore(minBytes: number): string {
  let out = ''
  let i = 0
  while (Buffer.byteLength(out, 'utf8') < minBytes) { out = out ? `${out} ${CORE_WORDS[i % CORE_WORDS.length]}` : CORE_WORDS[0]; i++ }
  return out
}
const CORE = paddedCore(200)

// A per-child backend string that genuinely differs BY COLOR (mirrors buildString's real per-color
// tail shape) when color is known, and collapses to the SAME shared core when it is not — modeling
// the pipeline's actual behaviour, not asserting it.
function buildPerChild(children: PipelineChild[]): PipelinePerChildKeywords[] {
  return children.map((c) => ({
    sku: c.sku,
    asin: c.asin,
    keywords: c.color ? `${CORE} ${c.color.toLowerCase()}` : CORE,
  }))
}

describe('degrade gate — B0DP5H8QBT-class family, colour source drives whether it fires', () => {
  it('BEFORE the fix (no stored catalog colour): 0 decoded colours, per-child strings collapse, gate FIRES', () => {
    const children = buildChildren({}) // nothing stored -> resolveChildColor -> decodeSkuColor -> null for all
    expect(children.every((c) => c.color === null)).toBe(true) // sanity: reproduces the live defect
    const perChild = buildPerChild(children)
    const distinctStrings = new Set(perChild.map((p) => p.keywords)).size
    expect(distinctStrings).toBe(1) // the collapse: EVERY child shares the identical string
    const problems = backendOutputProblems(perChild, children, /* apparel */ true)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toMatch(/0 decoded colors?, 12 undecoded/)
  })

  it('AFTER the fix: 12 children with distinct STORED catalog colours build distinct per-colour tails, gate does NOT fire', () => {
    const stored: Record<string, string> = {
      '1V-C6WM-US5T': 'Black',
      '3A-MINF-4TRD': 'Navy',
      '4K-WJVI-T618': 'Heather Grey',
      '5M-0T69-IFXD': 'Maroon',
    }
    const children = buildChildren(stored)
    expect(children.every((c) => c.color !== null)).toBe(true)
    expect(new Set(children.map((c) => c.color)).size).toBe(4) // 4 distinct colours across the 12
    const perChild = buildPerChild(children)
    const distinctStrings = new Set(perChild.map((p) => p.keywords)).size
    expect(distinctStrings).toBe(4) // per-colour tails actually differentiated — not a collapse
    const problems = backendOutputProblems(perChild, children, /* apparel */ true)
    expect(problems).toEqual([]) // the "0 decoded colors" degrade path is NOT taken
  })
})
