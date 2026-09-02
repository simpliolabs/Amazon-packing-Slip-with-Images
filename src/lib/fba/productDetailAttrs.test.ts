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
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mergeDetailRowsByPrecedence, type DetailMenuAttr, type EnumCoercer } from './productDetailAttrs'
import { coerceToEnum, coerceGenderToEnum } from './productTypeDefinitions'

interface Row {
  field_name: string
  recommended_value: string
  value_source?: 'spec' | 'audience' | 'ruling' | null
  is_enum?: boolean
  enum_valid?: boolean
  enum_accepted?: string[]
  normalized_from?: string
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

/**
 * VALIDITY OUTRANKS PROVENANCE — defect class closed 2026-09-02, PR #660 follow-up.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PR #660 (the test suite above) taught the merge that a stamped `value_source` outranks an
 * unstamped LLM guess. It did NOT check whether the stamped row's value is one Amazon's live
 * schema actually accepts — so a deterministic producer emitting a hardcoded label
 * (`contentTruth.ts`'s `AGE_RANGE_LABEL.kids = 'Kids'`) now OUTRANKS a competing LLM row that WAS
 * enum-accepted (the audit prompt requires "verbatim" menu members). Live: B0DP5H8QBT shipped Age
 * Range Description="Kids" — not a member of {Adult,Big Kid,Little Kid,Toddler,Infant,Newborn} —
 * over the LLM's accepted "Big Kid".
 *
 * These tests inject the REAL `coerceToEnum`/`coerceGenderToEnum` (productTypeDefinitions.ts) — the
 * exact primitives the LLM path is already validated with — via the same adapter shape
 * listingPipeline.ts wires in, so a pass here proves the real coercion rule, not a hand-rolled
 * stand-in that could silently drift from the production wire.
 */
const realCoerce: EnumCoercer = (spApiKey, rawValue, accepted) => {
  const enumDef = { values: accepted, names: [] as string[], deprecated: [] as string[] }
  const isGender = spApiKey === 'department' || spApiKey === 'target_gender'
  return (isGender ? coerceGenderToEnum(rawValue, enumDef) : null) ?? coerceToEnum(rawValue, enumDef)
}

const AGE_ACCEPTED = ['Adult', 'Big Kid', 'Little Kid', 'Toddler', 'Infant', 'Newborn']
const ageMenu: DetailMenuAttr[] = [{ key: 'age_range_description', title: 'Age Range Description', accepted: AGE_ACCEPTED }]

// Mixes the real live field (Age Range Description) with fields no current producer stamps
// (Battery Type, Some Brand New Attribute) — same "covered by construction" guarantee the
// provenance class test above establishes, now extended to validity.
const GENERIC_FIELD_LIST = ['Age Range Description', 'Department', 'Fabric Type', 'Battery Type', 'Some Brand New Attribute']
const GENERIC_ACCEPTED = ['Valid Alpha', 'Valid Beta', 'Valid Gamma']

describe('mergeDetailRowsByPrecedence — validity outranks provenance (enum-validation defect class, PR #660 follow-up)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('THE LIVE CASE (B0DP5H8QBT): spec="Kids" (not an accepted member) never outranks the LLM\'s enum-accepted "Big Kid"', () => {
    const out = mergeDetailRowsByPrecedence(
      [
        row('Age Range Description', 'Big Kid'),        // unstamped LLM guess — a REAL accepted member
        row('Age Range Description', 'Kids', 'spec'),    // contentTruth.ts's hardcoded label — NOT a member
      ],
      ageMenu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(out[0].recommended_value).not.toBe('Kids')       // THE bug this closes: must never ship
    expect(out[0].recommended_value).toBe('Big Kid')
    expect(AGE_ACCEPTED).toContain(out[0].recommended_value)
    expect(out[0].enum_valid).toBe(true)                    // prove the branch RAN, not just the string
    expect(out[0].is_enum).toBe(true)
    expect(out[0].value_source).not.toBe('spec')            // spec lost SPECIFICALLY because it was invalid
  })

  it('order-independent: an invalid spec row arriving FIRST still loses to the valid LLM row', () => {
    const out = mergeDetailRowsByPrecedence(
      [row('Age Range Description', 'Kids', 'spec'), row('Age Range Description', 'Big Kid')],
      ageMenu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(out[0].recommended_value).toBe('Big Kid')
    expect(out[0].enum_valid).toBe(true)
  })

  it('NO-MENU NO-OP: omitting menu/coerce (the pre-#660-follow-up call shape) reproduces the bug exactly — proves the fix is the injected validity check, not a change to the base rule', () => {
    const out = mergeDetailRowsByPrecedence([
      row('Age Range Description', 'Big Kid'),
      row('Age Range Description', 'Kids', 'spec'),
    ])
    expect(out[0].recommended_value).toBe('Kids')   // unfixed baseline reproduced verbatim
    expect(out[0].enum_valid).toBeUndefined()
  })

  it('NO-OP: menu carries this field but with NO accepted list (free-text attribute) — byte-identical to the provenance-only rule', () => {
    const menu: DetailMenuAttr[] = [{ key: 'material', title: 'Material' }]   // no `accepted`
    const input = [row('Material', 'llm guess'), row('Material', '100% Cotton', 'spec')]
    const out = mergeDetailRowsByPrecedence(input, menu, realCoerce)
    expect(out).toHaveLength(1)
    expect(out[0].recommended_value).toBe('100% Cotton')   // provenance-only pick, unchanged
    expect(out[0].enum_valid).toBeUndefined()               // never touched — no accepted list to check
  })

  it('NO-OP: field is absent from the menu entirely — byte-identical to the provenance-only rule', () => {
    const menu: DetailMenuAttr[] = [{ key: 'department', title: 'Department', accepted: ['Unisex'] }]
    const input = [row('Age Range Description', 'Big Kid'), row('Age Range Description', 'Kids', 'spec')]
    const out = mergeDetailRowsByPrecedence(input, menu, realCoerce)
    expect(out[0].recommended_value).toBe('Kids')   // this field isn't on the menu — untouched
    expect(out[0].enum_valid).toBeUndefined()
  })

  it.each(GENERIC_FIELD_LIST)('%s: THE CLASS TEST — an invalid spec-stamped value never ships over a valid competing row (driven generically, not hand-cased per field)', (field) => {
    const menu: DetailMenuAttr[] = [{ key: field.toLowerCase().replace(/\s+/g, '_'), title: field, accepted: GENERIC_ACCEPTED }]
    const out = mergeDetailRowsByPrecedence(
      [row(field, 'Valid Beta'), row(field, 'Not An Accepted Member At All', 'spec')],
      menu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(GENERIC_ACCEPTED).toContain(out[0].recommended_value)
    expect(out[0].recommended_value).not.toBe('Not An Accepted Member At All')
    expect(out[0].enum_valid).toBe(true)
    expect(out[0].value_source).not.toBe('spec')
  })

  it.each(GENERIC_FIELD_LIST)('%s: an invalid RULING row loses to a valid AUDIENCE row even though ruling outranks audience by provenance', (field) => {
    const menu: DetailMenuAttr[] = [{ key: 'x', title: field, accepted: GENERIC_ACCEPTED }]
    const out = mergeDetailRowsByPrecedence(
      [row(field, 'Valid Gamma', 'audience'), row(field, 'Not Accepted', 'ruling')],
      menu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(out[0].recommended_value).toBe('Valid Gamma')
    expect(out[0].value_source).toBe('audience')
    expect(out[0].enum_valid).toBe(true)
  })

  it.each(GENERIC_FIELD_LIST)('%s: when BOTH candidates are valid, provenance still decides — spec beats a valid unstamped guess', (field) => {
    const menu: DetailMenuAttr[] = [{ key: 'x', title: field, accepted: GENERIC_ACCEPTED }]
    const out = mergeDetailRowsByPrecedence(
      [row(field, 'Valid Alpha'), row(field, 'Valid Beta', 'spec')],
      menu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(out[0].recommended_value).toBe('Valid Beta')
    expect(out[0].value_source).toBe('spec')
    expect(out[0].enum_valid).toBe(true)
  })

  it('the winning candidate is coerced to the canonical accepted member — a casing mismatch is snapped and normalized_from records the raw input', () => {
    const out = mergeDetailRowsByPrecedence(
      [row('Age Range Description', 'BIG KID', 'spec'), row('Age Range Description', 'nonsense value')],
      ageMenu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(out[0].recommended_value).toBe('Big Kid')
    expect(out[0].normalized_from).toBe('BIG KID')
    expect(out[0].enum_valid).toBe(true)
    expect(out[0].value_source).toBe('spec')   // valid spec still beats an invalid unstamped row
  })

  it('when NO candidate is coercible, the provenance winner still ships (nothing valid to prefer) but is stamped enum_valid:false and logs a greppable rejection — never a silent invalid pass', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const menu: DetailMenuAttr[] = [{ key: 'age_range_description', title: 'Age Range Description', accepted: ['Adult', 'Big Kid'] }]
    const out = mergeDetailRowsByPrecedence(
      [row('Age Range Description', 'Youth'), row('Age Range Description', 'Kids', 'spec')],
      menu,
      realCoerce,
    )
    expect(out).toHaveLength(1)
    expect(out[0].value_source).toBe('spec')       // provenance still picks a winner among equally-invalid rows
    expect(out[0].recommended_value).toBe('Kids')
    expect(out[0].enum_valid).toBe(false)          // but FLAGGED, never a silent valid-looking pass
    expect(out[0].is_enum).toBe(true)
    expect(out[0].enum_accepted).toEqual(['Adult', 'Big Kid'])
    expect(warn).toHaveBeenCalled()
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('ENUM_PRECEDENCE_NO_VALID_CANDIDATE')
  })

  it('logs a greppable ENUM_PRECEDENCE_REJECTED line naming the rejected value when a valid alternative displaces an invalid higher-provenance row', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mergeDetailRowsByPrecedence(
      [row('Age Range Description', 'Big Kid'), row('Age Range Description', 'Kids', 'spec')],
      ageMenu,
      realCoerce,
    )
    expect(warn).toHaveBeenCalled()
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('ENUM_PRECEDENCE_REJECTED')
    expect(logged).toContain('Kids')
  })
})
