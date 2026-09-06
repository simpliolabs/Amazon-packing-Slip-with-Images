/**
 * ONE title cap, and it MOVES WITH THE CONTRACT.
 *
 * THE CLASS: `capTitle75` lived inside `listingPipeline.ts`, a module with database leaves. Pure
 * consumers could not import it, so they copied it. `truthBandHarness.ts` carried `capTitle75Like`
 * — a twin that, by its own docstring, ran "MINUS the inclusive-audience-tail special-casing this
 * fixture never needs" and hardcoded its own 75. The acceptance harness for the truth+band door was
 * therefore measuring a different cap than the pipeline shipped.
 *
 * Why that is not merely untidy: the working ceiling is scheduled to move (title-ceiling spec
 * Phase 4). A stale copy would truncate to the OLD ceiling while the harness reported GREEN on a
 * change it had just reverted — [[test-proves-the-mock-not-the-wire]] (#652), which is exactly how
 * a severed wire passed CI here before.
 *
 * Deleting the twin does not close the class; as long as a second implementation is easy to write,
 * the next one arrives. These tests fail when one does.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { capTitle, capTitle75, capTitleReport } from './titleCap'
import { CONTENT_CONTRACT } from './contentContract'

const SRC = join(process.cwd(), 'src')

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(full)) yield full
  }
}

describe('title cap — single source of truth', () => {
  it('no file other than titleCap.ts DECLARES a title-cap function', () => {
    // Matches a declaration, not a call: `function capTitleX(`, `const capTitleX = (`, and the
    // twin-naming pattern (`…Like`) that the deleted copy used.
    const DECL = /(?:function\s+capTitle\w*\s*\(|(?:const|let|var)\s+capTitle\w*\s*[:=]\s*(?:\(|function))/
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const base = basename(file)
      if (base === 'titleCap.ts' || base === 'titleCapSingleSource.test.ts') continue
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (DECL.test(line)) offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
    }
    expect(
      offenders,
      'The title cap has ONE implementation, in the pure module src/lib/fba/titleCap.ts — import it ' +
      'instead of re-declaring it. A copy silently truncates to a stale ceiling and makes the ' +
      `acceptance harness green on a reverted change:\n${offenders.join('\n')}\n`,
    ).toEqual([])
  })

  it('the cap FOLLOWS the contract — it does not hardcode 75', () => {
    // The regression that Phase 4 depends on. A 90-char title must survive a 100 cap; any surviving
    // hardcoded 75 anywhere in this path makes this fail.
    const ninety = 'THE CEO Motivational Entrepreneur Sweatshirt Long Sleeve Crewneck Pullover Top for Women!!'
    expect(ninety.length).toBeGreaterThan(75)
    expect(ninety.length).toBeLessThanOrEqual(100)

    const at100 = capTitleReport(ninety, 100)
    expect(at100.cut, 'a 90-char title must NOT be cut by a 100 cap').toBe(false)
    expect(at100.title).toBe(ninety)

    const at75 = capTitleReport(ninety, 75)
    expect(at75.cut, 'the same title MUST be cut by a 75 cap').toBe(true)
    expect(at75.toLen).toBeLessThanOrEqual(75)
  })

  it('capTitle75 is an alias for the contract cap, not a literal 75', () => {
    const long = 'THE CEO Billionare Coming Soon Sweatshirt Long Sleeve Pullover Crewneck Graphic Top for Women'
    expect(capTitle75(long)).toBe(capTitle(long, CONTENT_CONTRACT.title.hardCap))
  })

  it('reports WHETHER it cut — a silent truncation is indistinguishable from a gate that never ran', () => {
    const short = 'THE CEO Don’t Quit Sweatshirt'
    const r = capTitleReport(short)
    expect(r.cut).toBe(false)
    expect(r.fromLen).toBe(r.toLen)
    expect(r.cap).toBe(CONTENT_CONTRACT.title.hardCap)
  })
})
