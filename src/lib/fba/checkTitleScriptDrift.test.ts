/**
 * The standalone diagnostic at scripts/check-title.mjs carries its own copy of the door's title
 * waste vocabulary so it can run with no build. A copy that drifts is worse than no checker at all —
 * it would report a title clean that the door still rewrites. This is the tripwire.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTitleWasteVocabulary } from './titleBand'

describe('scripts/check-title.mjs must not drift from the door', () => {
  const src = readFileSync(join(process.cwd(), 'scripts', 'check-title.mjs'), 'utf8')
  const m = src.match(/const WASTE_RE = (\/.+?\/i)\s*$/m)   // \s*$ — the file is CRLF on Windows

  it('declares a waste regex this test can find', () => {
    expect(m, 'WASTE_RE literal not found — the tripwire cannot verify what it cannot parse').toBeTruthy()
  })

  it('agrees with isTitleWasteVocabulary on every probe', () => {
    // eslint-disable-next-line no-eval
    const scriptRe: RegExp = eval(m![1])
    const probes = [
      'THE CEO Tee Unisex Shirt', 'THE CEO Classic Fit Shirt', 'THE CEO CLASSIC  FIT Tee',
      'THE CEO Classic Car Shirt',          // "classic" alone is NOT waste — a real design name
      'THE CEO Fit Check Tee', 'THE CEO Tee Shirt | USA Mexico Canada Football Tee',
    ]
    for (const p of probes) {
      expect(scriptRe.test(p), `disagreement on "${p}"`).toBe(isTitleWasteVocabulary(p))
    }
  })
})
