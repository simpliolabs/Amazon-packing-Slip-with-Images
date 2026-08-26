/**
 * Precedence pins for resolveDesignAudienceLean (PO ruling 2026-08-26, per-design audience —
 * extending the garment per-design ruling to audience). Pure module, zero DB imports — no Supabase
 * env guard needed (contrast kidsAudienceCtxParity.test.ts / gatePerChildMultiDesign.integration.test.ts,
 * which null NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY because they transitively import
 * blankSpecs.ts's lazy Supabase client Proxy; this file imports nothing that does).
 */
import { describe, it, expect } from 'vitest'
import { resolveDesignAudienceLean } from './audienceAssignment'

describe('resolveDesignAudienceLean — precedence', () => {
  it('an ASSIGNED design uses its OWN audience, not the family value', () => {
    const out = resolveDesignAudienceLean(
      'MOTHERHUSTLER',
      { MOTHERHUSTLER: 'female' },
      'lean_male',
    )
    expect(out).toEqual({ lean: 'female', source: 'design-assignment' })
  })

  it('an UNASSIGNED design in a family that has OTHER assignments falls back to the family value', () => {
    const out = resolveDesignAudienceLean(
      'DONTQUIT',
      { MOTHERHUSTLER: 'female', BUSINESSBTCH: 'female' },
      'lean_male',
    )
    expect(out).toEqual({ lean: 'lean_male', source: 'family-default' })
  })

  it('the family value alone still works when NO assignments exist at all (the no-op-until-assigned property)', () => {
    const outUndefined = resolveDesignAudienceLean('MOTHERHUSTLER', undefined, 'lean_male')
    const outNull = resolveDesignAudienceLean('MOTHERHUSTLER', null, 'lean_male')
    const outEmptyMap = resolveDesignAudienceLean('MOTHERHUSTLER', {}, 'lean_male')
    expect(outUndefined).toEqual({ lean: 'lean_male', source: 'family-default' })
    expect(outNull).toEqual({ lean: 'lean_male', source: 'family-default' })
    expect(outEmptyMap).toEqual({ lean: 'lean_male', source: 'family-default' })
  })

  it('no family value and no assignment resolves to null, not a guess', () => {
    const out = resolveDesignAudienceLean('DONTQUIT', {}, null)
    expect(out).toEqual({ lean: null, source: 'family-default' })
  })

  it('every seller-facing enum value is honored when assigned', () => {
    for (const v of ['male', 'female', 'lean_male', 'lean_female', 'unisex'] as const) {
      expect(resolveDesignAudienceLean('K', { K: v }, 'unisex')).toEqual({ lean: v, source: 'design-assignment' })
    }
  })

  it('a malformed/garbage map entry (bad data, not a PO statement) falls through to the family value', () => {
    const out = resolveDesignAudienceLean('K', { K: 'nonbinary-typo' }, 'lean_female')
    expect(out).toEqual({ lean: 'lean_female', source: 'family-default' })
  })

  it('empty/whitespace designKey falls straight through to the family value (no crash, no false match)', () => {
    expect(resolveDesignAudienceLean('', { '': 'female' }, 'lean_male')).toEqual({ lean: 'lean_male', source: 'family-default' })
    expect(resolveDesignAudienceLean('   ', { '': 'female' }, 'lean_male')).toEqual({ lean: 'lean_male', source: 'family-default' })
    expect(resolveDesignAudienceLean(null, { K: 'female' }, 'lean_male')).toEqual({ lean: 'lean_male', source: 'family-default' })
    expect(resolveDesignAudienceLean(undefined, { K: 'female' }, 'lean_male')).toEqual({ lean: 'lean_male', source: 'family-default' })
  })

  it('designKey is matched EXACT, not case-folded (mirrors every other designKey consumer in this repo)', () => {
    const out = resolveDesignAudienceLean('motherhustler', { MOTHERHUSTLER: 'female' }, 'lean_male')
    expect(out).toEqual({ lean: 'lean_male', source: 'family-default' })
  })

  it('the live B0DSCDZC6K scenario: two female-coded designs assigned, four neutral designs inherit', () => {
    const byDesign = { MOTHERHUSTLER: 'female', BUSINESSBTCH: 'female' }
    const family = 'lean_male'
    expect(resolveDesignAudienceLean('MOTHERHUSTLER', byDesign, family)).toEqual({ lean: 'female', source: 'design-assignment' })
    expect(resolveDesignAudienceLean('BUSINESSBTCH', byDesign, family)).toEqual({ lean: 'female', source: 'design-assignment' })
    for (const neutral of ['DONTQUIT', 'HUSTLEDEFINITON', 'BILLIONARECOMINGSOON', 'ENTREPRENEURDEFINITION']) {
      expect(resolveDesignAudienceLean(neutral, byDesign, family)).toEqual({ lean: 'lean_male', source: 'family-default' })
    }
  })
})
