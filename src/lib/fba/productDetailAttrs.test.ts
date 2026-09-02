/**
 * mergeDetailRowsByPrecedence — THE CLASS TEST (defect class closed 2026-09-02, PR #654 follow-up).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Live symptom: family B0DP5H8QBT (12x Gildan 64000B YOUTH tees, blank_specs.age_class='kids')
 * shipped Age Range Description = "Big Kid" with value_source=null — the mega-audit's own guess
 * from the listing's existing copy — instead of the deterministic 'Kids' row PR #654 was supposed
 * to append. Root cause (listingPipeline.ts's `appendSpecFact`, pre-fix): it refused to add its
 * spec-stamped candidate whenever ANY row already existed for the field, so the audit's guess (which
 * always runs first) won by simply arriving first. Department escaped the same bug only because ITS
 * deterministic site overwrites the existing row in place — an accident of a different call shape,
 * never a stated rule.
 *
 * This file does NOT test one field. It drives the precedence rule over a LIST of field names —
 * including one no producer in this codebase has ever emitted — so a brand-new deterministic
 * producer for a brand-new field is covered by construction, not by a hand-written case someone has
 * to remember to add.
 */
import { describe, it, expect } from 'vitest'
import { mergeDetailRowsByPrecedence } from './productDetailAttrs'

interface Row {
  field_name: string
  recommended_value: string
  value_source?: 'spec' | 'audience' | 'ruling' | null
}

function row(field_name: string, recommended_value: string, value_source?: Row['value_source']): Row {
  return { field_name, recommended_value, value_source }
}

// Deliberately mixes real fields this repo already stamps (Age Range Description, Department) with
// one that NO current producer emits (Battery Type) — the class claim is that the LATTER is covered
// automatically, with zero new code, the moment some future producer starts stamping it 'spec'.
const FIELD_LIST = ['Age Range Description', 'Department', 'Fabric Type', 'Battery Type', 'Some Brand New Attribute']

describe('mergeDetailRowsByPrecedence — the class test', () => {
  it.each(FIELD_LIST)('%s: a spec-stamped row always wins over an unstamped (LLM guess) row, regardless of which arrives first', (field) => {
    const llmFirst = mergeDetailRowsByPrecedence([
      row(field, 'llm-guessed-value'),                       // unstamped, arrives first (mega-audit always runs first live)
      row(field, 'ground-truth-value', 'spec'),
    ])
    expect(llmFirst).toHaveLength(1)
    expect(llmFirst[0].value_source).toBe('spec')             // PROVE THE PROVENANCE, not just the string
    expect(llmFirst[0].recommended_value).toBe('ground-truth-value')

    const specFirst = mergeDetailRowsByPrecedence([
      row(field, 'ground-truth-value', 'spec'),
      row(field, 'llm-guessed-value'),
    ])
    expect(specFirst).toHaveLength(1)
    expect(specFirst[0].value_source).toBe('spec')
    expect(specFirst[0].recommended_value).toBe('ground-truth-value')
  })

  it.each(FIELD_LIST)('%s: a ruling-stamped row wins over an unstamped row', (field) => {
    const out = mergeDetailRowsByPrecedence([
      row(field, 'llm-guessed-value'),
      row(field, 'ruling-value', 'ruling'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].value_source).toBe('ruling')
    expect(out[0].recommended_value).toBe('ruling-value')
  })

  it.each(FIELD_LIST)('%s: an audience-stamped row wins over an unstamped row', (field) => {
    const out = mergeDetailRowsByPrecedence([
      row(field, 'llm-guessed-value'),
      row(field, 'audience-value', 'audience'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].value_source).toBe('audience')
    expect(out[0].recommended_value).toBe('audience-value')
  })

  it.each(FIELD_LIST)('%s: full precedence chain — spec beats ruling beats audience beats unstamped, independent of array order', (field) => {
    const out = mergeDetailRowsByPrecedence([
      row(field, 'audience-value', 'audience'),
      row(field, 'llm-guessed-value'),
      row(field, 'ruling-value', 'ruling'),
      row(field, 'spec-value', 'spec'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].value_source).toBe('spec')
    expect(out[0].recommended_value).toBe('spec-value')
  })

  it('THE NO-OP CONTROL: a field where every row is unstamped is left byte-identical — nothing to arbitrate, so nothing is dropped', () => {
    const input = [
      row('Age Range Description', 'Big Kid'),
      row('Age Range Description', 'Youth'),
    ]
    const out = mergeDetailRowsByPrecedence(input)
    // Both rows survive, unmodified, in original order — this function only resolves a conflict
    // where a STAMPED row exists; it must never invent a reason to drop a duplicate that has no
    // deterministic competitor (that would be a different, out-of-scope defect).
    expect(out).toEqual(input)
  })

  it('a single row for a field (the overwhelming majority case) is a pure no-op', () => {
    const input = [row('Material', '100% Cotton', 'spec'), row('Style', 'Vintage')]
    expect(mergeDetailRowsByPrecedence(input)).toEqual(input)
  })

  it('field-name matching is case/spacing-insensitive, like the rest of this module (normalizeFieldName)', () => {
    const out = mergeDetailRowsByPrecedence([
      row('age range description', 'Big Kid'),
      row('Age_Range-Description', 'Kids', 'spec'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].value_source).toBe('spec')
    expect(out[0].recommended_value).toBe('Kids')
  })

  it('unrelated fields are never cross-contaminated — only rows sharing a field_name compete', () => {
    const out = mergeDetailRowsByPrecedence([
      row('Department', 'Unisex Kids', 'spec'),
      row('Target Gender', 'Unisex', 'audience'),
      row('Age Range Description', 'Big Kid'),
      row('Age Range Description', 'Kids', 'spec'),
    ])
    expect(out).toHaveLength(3)
    expect(out.find((r) => r.field_name === 'Department')?.recommended_value).toBe('Unisex Kids')
    expect(out.find((r) => r.field_name === 'Target Gender')?.recommended_value).toBe('Unisex')
    const age = out.find((r) => r.field_name === 'Age Range Description')
    expect(age?.value_source).toBe('spec')
    expect(age?.recommended_value).toBe('Kids')
  })
})
