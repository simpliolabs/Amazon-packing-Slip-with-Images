/**
 * designScopeCallSiteEnumeration.test.ts — `.superpowers/sdd/2026-09-24-cross-design-leak/
 * phase-x1-rulings.md`, RULING X4 (fence the class).
 *
 * X1-X3 fixed the class at every per-design caller KNOWN today. This file makes a NEW caller of
 * `buildForeignDesignTokens` fail the build unless it passes `familyTitleText: ''` AND
 * `strictNames: true` (the ship door's own treatment) — or carries an explicit justification
 * comment naming why the family-title/pool-frequency circularity cannot apply there (e.g. the
 * title/description/ship harness call sites in `truthBandHarness.ts`, which already pass both and
 * need no marker; a future non-per-design caller that genuinely differs would use the marker).
 *
 * `scanCallSites` is exported so a second test can run known-bad SHAPES through the SAME scanner
 * the real one uses (a pin whose scanner isn't exercised by an adversarial shape is decorative).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface ScannedCallSite {
  file: string
  callLine: number
  /** true when the call site's own text has neither `familyTitleText:` nor `poolKeywords:` — i.e.
   *  this scanner could not find an options-object window at all (fails CLOSED: not empty). */
  empty: boolean
  /** true when BOTH `familyTitleText: ''` and `strictNames: true` are present in the window, OR a
   *  `SCOPE-JUSTIFIED:` marker comment sits within 3 lines above the call. */
  justified: boolean
  window: string
}

const CALL_RE = /buildForeignDesignTokens\(/g
// Generous: real call sites here carry multi-paragraph "why" comments between the call and its
// options object (this repo's own convention) — a tight window would make the scanner fail CLOSED
// on a well-commented compliant caller, which is as useless a pin as failing open on a bad one.
const WINDOW_CHARS = 2000
const JUSTIFY_MARKER = 'SCOPE-JUSTIFIED:'

/** Scan `files` (each `{ path, text }`) for every direct `buildForeignDesignTokens(` call and
 *  classify it. A call is "empty" only for the function's OWN declaration line (no options window
 *  applies) — every other call must be either compliant or explicitly justified, or it is an
 *  offender. KNOWN LIMITATION (documented, not silently claimed closed): this is a textual scan,
 *  not an AST — it does not follow a renamed import of `buildForeignDesignTokens`, an indirect
 *  wrapper that forwards a contaminated `familyTitleText` into it, or an options object built more
 *  than a few lines above the call. It DOES catch the case X4 requires (a direct call whose own
 *  inline options are missing either argument) regardless of argument order. */
export function scanCallSites(files: { path: string; text: string }[]): ScannedCallSite[] {
  const out: ScannedCallSite[] = []
  for (const { path, text } of files) {
    let m: RegExpExecArray | null
    const re = new RegExp(CALL_RE)
    while ((m = re.exec(text))) {
      const idx = m.index
      const callLine = text.slice(0, idx).split('\n').length
      // Skip the function's own declaration/export in designScope.ts — not a call site.
      const lineText = text.slice(text.lastIndexOf('\n', idx) + 1, text.indexOf('\n', idx) === -1 ? text.length : text.indexOf('\n', idx))
      if (/^export function buildForeignDesignTokens/.test(lineText.trim())) continue
      const window = text.slice(idx, Math.min(text.length, idx + WINDOW_CHARS))
      const hasFamilyEmpty = /familyTitleText:\s*''/.test(window)
      const hasStrict = /strictNames:\s*true/.test(window)
      const beforeLines = text.slice(0, idx).split('\n')
      const justifiedByMarker = beforeLines.slice(Math.max(0, beforeLines.length - 4)).some((l) => l.includes(JUSTIFY_MARKER))
      const empty = !/familyTitleText\s*:/.test(window) && !/poolKeywords\s*:/.test(window)
      out.push({
        file: path, callLine, empty,
        justified: empty ? false : (hasFamilyEmpty && hasStrict) || justifiedByMarker,
        window,
      })
    }
  }
  return out
}

const SRC = join(process.cwd(), 'src')
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(full)) yield full
  }
}
const realFiles = [...walk(SRC)]
  .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
  .map((f) => ({ path: relative(process.cwd(), f), text: readFileSync(f, 'utf8') }))

const offenders = (extra: { path: string; text: string }[] = []) =>
  scanCallSites([...realFiles, ...extra]).filter((s) => !s.empty && !s.justified)

describe('X4 — every buildForeignDesignTokens call site is BOTH-args-compliant or explicitly justified', () => {
  it('BASELINE: zero offenders on the shipped tree', () => {
    const off = offenders()
    expect(off.map((o) => `${o.file}:${o.callLine}`), JSON.stringify(off, null, 2)).toEqual([])
  })

  it('sanity: the scanner actually finds the known call sites (a pin that finds nothing proves nothing)', () => {
    const sites = scanCallSites(realFiles)
    // listingPipeline.ts: IH composer, ship door, title candidate filter, bullets/desc/backend
    // scoper = 4. truthBandHarness.ts: 2 more (both already `'' , strictNames: true`).
    expect(sites.filter((s) => !s.empty).length).toBeGreaterThanOrEqual(6)
  })

  it('THE PIN: a planted caller with a contaminated familyTitleText and no strictNames fails', () => {
    const planted = {
      path: 'src/lib/fba/plantedCaller.ts',
      text: [
        "import { buildForeignDesignTokens } from './designScope'",
        'export const scope = buildForeignDesignTokens(',
        '  designs,',
        "  { familyTitleText: `${input.canonicalTitle ?? ''} ${input.priorTitle ?? ''}`, poolKeywords: pool },",
        ')',
      ].join('\n'),
    }
    const off = offenders([planted])
    expect(off.some((o) => o.file === planted.path)).toBe(true)
  })

  it('THE PIN, property order swapped: `strictNames: true, poolKeywords: pool, familyTitleText: contaminated` still fails (no ORDER dependency)', () => {
    const planted = {
      path: 'src/lib/fba/plantedSwapped.ts',
      text: [
        "import { buildForeignDesignTokens } from './designScope'",
        'export const scope = buildForeignDesignTokens(designs, { strictNames: true, poolKeywords: pool, familyTitleText: contaminatedTitle })',
      ].join('\n'),
    }
    const off = offenders([planted])
    expect(off.some((o) => o.file === planted.path)).toBe(true)
  })

  it('a compliant new caller (both args, no marker needed) passes', () => {
    const planted = {
      path: 'src/lib/fba/plantedCompliant.ts',
      text: [
        "import { buildForeignDesignTokens } from './designScope'",
        'export const scope = buildForeignDesignTokens(',
        '  designs,',
        "  { familyTitleText: '', poolKeywords: pool.map((k) => k.keyword), strictNames: true },",
        ')',
      ].join('\n'),
    }
    const off = offenders([planted])
    expect(off.some((o) => o.file === planted.path)).toBe(false)
  })

  it('an explicit SCOPE-JUSTIFIED marker exempts a caller that genuinely is not per-design (documented escape hatch, not silent)', () => {
    const planted = {
      path: 'src/lib/fba/plantedJustified.ts',
      text: [
        '// SCOPE-JUSTIFIED: this is a diagnostics-only dry-run harness, never a shipped composition site.',
        "import { buildForeignDesignTokens } from './designScope'",
        'export const scope = buildForeignDesignTokens(designs, { familyTitleText: contaminatedTitle, poolKeywords: pool })',
      ].join('\n'),
    }
    const off = offenders([planted])
    expect(off.some((o) => o.file === planted.path)).toBe(false)
  })
})
