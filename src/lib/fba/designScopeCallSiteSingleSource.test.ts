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
 * THIS TEST enumerates EVERY call to `buildForeignDesignTokens` in the source tree (a source scan,
 * same discipline `titleCapSingleSource.test.ts` already uses for the title cap) and requires each
 * one to EITHER pass an empty `familyTitleText` OR carry the `NON-EMPTY-FAMILY-TITLE-TEXT-OK` marker
 * within a nearby comment — a one-line justification naming why circularity does not apply there
 * (or, honestly, that it does and is a tracked, out-of-scope gap). A caller that is neither FAILS
 * this test. That is the pin: a NEW call site that copies the pattern without adding the marker
 * — exactly how this defect class would recur — fails here before it ships.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')
const MARKER = 'NON-EMPTY-FAMILY-TITLE-TEXT-OK'
const CALL_RE = /buildForeignDesignTokens\s*\(/
const DECL_RE = /function\s+buildForeignDesignTokens\s*\(/

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
  /** 1-indexed line of the `buildForeignDesignTokens(` token itself. */
  callLine: number
  /** The `familyTitleText: <expr>` line, or '' if it could not be found within the window. */
  familyTitleTextExpr: string
  empty: boolean
  justified: boolean
}

/** The scan + verdict logic, pulled out of the test body so it can be run BOTH against the real
 *  source tree and against a synthetic fixture (the mutation proof below) — a scanner that always
 *  finds zero offenders on the real tree is indistinguishable from a broken one without a case it
 *  MUST catch. */
export function scanCallSites(files: { path: string; text: string }[]): CallSite[] {
  const sites: CallSite[] = []
  for (const { path, text } of files) {
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const isCommentLine = /^\s*(\*|\/\/)/.test(lines[i])
      if (isCommentLine || !CALL_RE.test(lines[i]) || DECL_RE.test(lines[i])) continue
      // The familyTitleText property sits within the call's argument object — every real call site
      // (and every one this test writes) puts it on its own line, somewhere after the call (a long
      // doc comment can sit between the two, so the window is generous).
      let exprLine = ''
      let exprLineIdx = i
      for (let j = i; j < Math.min(lines.length, i + 60); j++) {
        const m = lines[j].match(/familyTitleText:\s*(.*?),\s*poolKeywords/)
        if (m) { exprLine = m[1].trim(); exprLineIdx = j; break }
      }
      const empty = exprLine === "''" || exprLine === '""'
      // The justification window: from a bit above the call (doc comments precede the `const x =`
      // line) through the familyTitleText line itself (an inline comment on/around the property).
      const windowStart = Math.max(0, i - 25)
      const justified = !empty && lines.slice(windowStart, exprLineIdx + 1).some((l) => l.includes(MARKER))
      sites.push({ file: path, callLine: i + 1, familyTitleTextExpr: exprLine, empty, justified })
    }
  }
  return sites
}

describe('buildForeignDesignTokens — every call site is empty OR justified (S1 enumeration pin)', () => {
  const files = [...walk(SRC)]
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
    .map((f) => ({ path: relative(process.cwd(), f), text: readFileSync(f, 'utf8') }))

  it('THE PIN: no call site passes a non-empty familyTitleText without the justification marker', () => {
    const sites = scanCallSites(files)
    const offenders = sites.filter((s) => !s.empty && !s.justified)
    expect(
      offenders,
      'A caller of buildForeignDesignTokens is passing a non-empty familyTitleText with no ' +
      `NON-EMPTY-FAMILY-TITLE-TEXT-OK justification nearby (S1, the cross-design-leak class):\n` +
      offenders.map((s) => `  ${s.file}:${s.callLine}  familyTitleText: ${s.familyTitleTextExpr}`).join('\n'),
    ).toEqual([])
  })

  it('sanity: the scanner actually found every known call site (a scanner matching nothing is a false green)', () => {
    const sites = scanCallSites(files)
    // designScope.ts (declaration only, excluded), listingPipeline.ts x4, truthBandHarness.ts x2.
    expect(sites.length).toBe(6)
    const listingPipelineSites = sites.filter((s) => s.file.includes('listingPipeline.ts'))
    const harnessSites = sites.filter((s) => s.file.includes('truthBandHarness.ts'))
    expect(listingPipelineSites.length).toBe(4)
    expect(harnessSites.length).toBe(2)
  })

  it('sanity: the SHIP-DOOR call sites (title, and now bullets/descriptions via the same scope object) are the empty ones', () => {
    const sites = scanCallSites(files)
    const emptySites = sites.filter((s) => s.empty)
    // truthBandHarness's two title-door simulations + listingPipeline's one real per-child title
    // door (`perChildDesignScope`, reused verbatim by S2 for bullets/descriptions — NOT a second
    // call site) + T3 (Round T, cross-design leak): the Item Highlight per-design composer's own
    // call now ALSO passes '' unconditionally (closing the circularity S1 left "honest, not
    // closed") — 4 empty in listingPipeline.ts, not 3.
    expect(emptySites.length).toBe(4)
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

  it('does NOT mistake the function DECLARATION for a call site', () => {
    const decl = `export function buildForeignDesignTokens(designs: DesignVocab[], opts: DesignScopeOpts): (key: string) => Set<string> {`
    expect(scanCallSites(wrap(decl))).toHaveLength(0)
  })
})
