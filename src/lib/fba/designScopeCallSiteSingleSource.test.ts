/**
 * S1 (Round S, cross-design leak, 2026-09-24, live B0DSCDZC6K) — THE CLASS, PINNED.
 *
 * `designScope.ts`'s `buildForeignDesignTokens({ familyTitleText, ... })` exempts every token
 * present in `familyTitleText` from ever being "foreign" to a design (`designScope.ts:103`,
 * mode-independent — STRICT NAMES only closes the pool-frequency exemption one line below). That is
 * safe while the family title is clean. The moment it carries a SIBLING's name — exactly what
 * happened on B0DSCDZC6K after the August title defect — every caller that hands it a non-empty
 * `familyTitleText` silently RE-LICENSES that sibling's name for every other design. Five callers
 * did this; only the per-child TITLE ship door refused (`familyTitleText: ''`,
 * `listingPipeline.ts:10302-10307`: "an exemption sourced from the family TITLE would be circular —
 * the title is the thing on trial"). That lesson was applied to titles and to nothing else.
 *
 * THIS TEST enumerates EVERY `familyTitleText:` VALUE ASSIGNMENT in the source tree (a source scan,
 * same discipline `titleCapSingleSource.test.ts` already uses for the title cap) and requires each
 * one to EITHER be empty OR carry the `NON-EMPTY-FAMILY-TITLE-TEXT-OK` marker within a nearby
 * comment — a one-line justification naming why circularity does not apply there (or, honestly,
 * that it does and is a tracked, out-of-scope gap). An assignment that is neither FAILS this test.
 *
 * T8 (Round T) — WIDENED. The original pin scanned for the literal token
 * `buildForeignDesignTokens(` and required a `familyTitleText:` property within 60 lines after it.
 * `pin.probe.test.ts` (phase-t1 review) proved two bypasses against that shape with the SAME
 * mutation-fixture discipline this file already uses: (B) the callee imported under a renamed
 * binding, and (C) an INDIRECT caller — a wrapper function (`buildItemHighlightsPerDesign`,
 * `produceItemHighlightsPerDesign`) that itself takes a `familyTitleText` field and forwards it to
 * the one real `buildForeignDesignTokens(` call inside it. (C) is not hypothetical: it is the exact
 * shape that shipped the live leak (`listingPipeline.ts` and
 * `app/api/fba/regenerate-item-highlight/route.ts`, both fixed in Round T) — a caller that never
 * writes `buildForeignDesignTokens(` on its own line was invisible to the old pin. Anchoring the
 * scan on the `familyTitleText:` PROPERTY KEY itself, wherever it appears, needs no knowledge of the
 * callee's name or of how many layers of wrapper sit between a value and the resolver that finally
 * reads it — every wrapper that carries the value also carries the property key, and the interface
 * field DECLARATION (`familyTitleText: string`, no trailing comma) never matches the value-assignment
 * pattern (`familyTitleText: <expr>,`), so the type definition itself is never mistaken for a site.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')
const MARKER = 'NON-EMPTY-FAMILY-TITLE-TEXT-OK'
/** A VALUE assignment ("familyTitleText: <expr>," or "familyTitleText: <expr>}" when it is the
 *  object's LAST property) — never the bare interface field declaration ("familyTitleText: string",
 *  terminated by neither) and never a doc comment merely mentioning the name (comment lines are
 *  excluded below before this ever runs). Terminating on `,` OR `}` (T8 — the pin's own mutation
 *  fixture (E), "property order swapped", puts `familyTitleText` LAST with no trailing comma; a
 *  comma-only terminator silently finds zero sites there instead of failing closed). */
const PROP_RE = /familyTitleText:\s*([^,}]*?)[,}]/

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(full)) yield full
  }
}

export interface CallSite {
  file: string
  /** 1-indexed line of the `familyTitleText:` property assignment itself. */
  callLine: number
  familyTitleTextExpr: string
  empty: boolean
  justified: boolean
}

/** The scan + verdict logic, pulled out of the test body so it can be run BOTH against the real
 *  source tree and against a synthetic fixture (the mutation proof below) — a scanner that always
 *  finds zero offenders on the real tree is indistinguishable from a broken one without a case it
 *  MUST catch. Kept the name `scanCallSites` (T8 widened WHAT counts as a site, not the shape other
 *  code/tests hold it in). */
export function scanCallSites(files: { path: string; text: string }[]): CallSite[] {
  const sites: CallSite[] = []
  for (const { path, text } of files) {
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const isCommentLine = /^\s*(\*|\/\/)/.test(lines[i])
      if (isCommentLine) continue
      const m = lines[i].match(PROP_RE)
      if (!m) continue
      const exprLine = m[1].trim()
      const empty = exprLine === "''" || exprLine === '""'
      // The justification window: a bit above the assignment (doc comments precede the call/object
      // literal it sits inside) through the assignment line itself (an inline comment on/around it).
      const windowStart = Math.max(0, i - 25)
      const justified = !empty && lines.slice(windowStart, i + 1).some((l) => l.includes(MARKER))
      sites.push({ file: path, callLine: i + 1, familyTitleTextExpr: exprLine, empty, justified })
    }
  }
  return sites
}

describe('familyTitleText — every value assignment is empty OR justified (S1 enumeration pin, T8-widened)', () => {
  const files = [...walk(SRC)]
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
    .map((f) => ({ path: relative(process.cwd(), f), text: readFileSync(f, 'utf8') }))

  it('THE PIN: no assignment passes a non-empty familyTitleText without the justification marker', () => {
    const sites = scanCallSites(files)
    const offenders = sites.filter((s) => !s.empty && !s.justified)
    expect(
      offenders,
      'A caller is assigning a non-empty familyTitleText with no NON-EMPTY-FAMILY-TITLE-TEXT-OK ' +
      `justification nearby (S1, the cross-design-leak class):\n` +
      offenders.map((s) => `  ${s.file}:${s.callLine}  familyTitleText: ${s.familyTitleTextExpr}`).join('\n'),
    ).toEqual([])
  })

  it('sanity: the scanner actually found every known site (a scanner matching nothing is a false green)', () => {
    const sites = scanCallSites(files)
    // listingPipeline.ts x5 (the STRICT-NAMES IH composer's own call, the per-child ship door
    // (bullets/description/title now share the ONE scope — Round V deleted the U2 phrase-aware
    // twin, `perChildBaseScopePhrase`/`perChildDesignScopePhrase`), the title candidate filter,
    // the bullets/description pool scoper, and the per-design IH pipeline caller — T3 turned the
    // composer's own call AND the pipeline caller empty), route.ts x1 (the regenerate-item-
    // highlight route's caller — T3 turned it empty too), truthBandHarness.ts x2.
    expect(sites.length).toBe(8)
    const listingPipelineSites = sites.filter((s) => s.file.includes('listingPipeline.ts'))
    const harnessSites = sites.filter((s) => s.file.includes('truthBandHarness.ts'))
    const routeSites = sites.filter((s) => s.file.includes('regenerate-item-highlight') && s.file.includes('route.ts'))
    expect(listingPipelineSites.length).toBe(5)
    expect(harnessSites.length).toBe(2)
    expect(routeSites.length).toBe(1)
  })

  it('sanity: T3 closed 3 more sites at the source — the IH composer, its pipeline caller, and the route caller are now empty too', () => {
    const sites = scanCallSites(files)
    const emptySites = sites.filter((s) => s.empty)
    // truthBandHarness's two title-door simulations + listingPipeline's per-child ship door
    // (`perChildDesignScope`, one scope for title AND bullets/description since Round V deleted
    // the phrase-aware twin) + listingPipeline's STRICT-NAMES Item Highlight composer (T3) +
    // listingPipeline's per-design IH pipeline caller (T3) + the regenerate-item-highlight
    // route's caller (T3).
    expect(emptySites.length).toBe(6)
  })
})

describe('scanCallSites — mutation-proved against synthetic fixtures (not just the real tree)', () => {
  const wrap = (body: string): { path: string; text: string }[] => [{ path: 'fixture.ts', text: body }]

  it('flags a NEW caller that passes a non-empty familyTitleText with NO marker (the exact regression this pin exists to catch)', () => {
    const bad = `
      const foreignFor = buildForeignDesignTokens(
        designs,
        { familyTitleText: someContaminatedTitle, poolKeywords: [] },
      )
    `
    const sites = scanCallSites(wrap(bad))
    expect(sites).toHaveLength(1)
    expect(sites[0].empty).toBe(false)
    expect(sites[0].justified).toBe(false)
  })

  it('does NOT flag an empty familyTitleText', () => {
    const good = `
      const foreignFor = buildForeignDesignTokens(
        designs,
        { familyTitleText: '', poolKeywords: [] },
      )
    `
    const sites = scanCallSites(wrap(good))
    expect(sites[0].empty).toBe(true)
  })

  it('does NOT flag a non-empty familyTitleText that carries the justification marker', () => {
    const justified = `
      // NON-EMPTY-FAMILY-TITLE-TEXT-OK: pool-shaping only, backstopped by the ship door.
      const foreignFor = buildForeignDesignTokens(
        designs,
        { familyTitleText: someTitle, poolKeywords: [] },
      )
    `
    const sites = scanCallSites(wrap(justified))
    expect(sites[0].empty).toBe(false)
    expect(sites[0].justified).toBe(true)
  })

  it('does NOT mistake the interface FIELD DECLARATION for a value-assignment site', () => {
    const decl = `export interface DesignScopeOpts {\n  familyTitleText: string\n  poolKeywords: string[]\n}`
    expect(scanCallSites(wrap(decl))).toHaveLength(0)
  })

  it('T8 — catches bypass (B): the callee imported/called under a RENAMED binding (the old pin', () => {
    // required the literal text `buildForeignDesignTokens(` on the line before the property; a
    // renamed import/alias defeated it. This scanner never looks at the callee's name at all.
    const renamed = `
      import { buildForeignDesignTokens as buildScope } from './designScope'
      const foreignFor = buildScope(
        designs,
        { familyTitleText: someContaminatedTitle, poolKeywords: [] },
      )
    `
    const sites = scanCallSites(wrap(renamed))
    expect(sites).toHaveLength(1)
    expect(sites[0].empty).toBe(false)
    expect(sites[0].justified).toBe(false)
  })

  it('T8 — catches the "last property, no trailing comma" shape (pin.probe.test.ts fixture E)', () => {
    const swapped = `export const scope = buildForeignDesignTokens(designs, { poolKeywords: pool, familyTitleText: contaminated })`
    const sites = scanCallSites(wrap(swapped))
    expect(sites).toHaveLength(1)
    expect(sites[0].familyTitleTextExpr).toBe('contaminated')
    expect(sites[0].empty).toBe(false)
    expect(sites[0].justified).toBe(false)
  })

  it('T8 — catches bypass (C): an INDIRECT caller through a wrapper that never writes ' +
    'buildForeignDesignTokens( on its own line — the exact shape that shipped the live leak', () => {
    const indirect = `
      const built = await produceItemHighlightsPerDesign({
        groups, pool, apparelProduct, blankBrand,
        familyTitleText: \`\${input.canonicalTitle ?? ''} \${input.priorTitle ?? ''}\`,
        audienceLean,
      })
    `
    const sites = scanCallSites(wrap(indirect))
    expect(sites).toHaveLength(1)
    expect(sites[0].empty).toBe(false)
    expect(sites[0].justified).toBe(false)
  })
})
