/**
 * ihPadAimVsFloorPin.test.ts — SOURCE-SCAN PIN (controller correction to PR #677, 2026-09-08).
 *
 * THE DEFECT #677 SHIPPED. `CONTENT_CONTRACT.itemHighlights.min` dropped 107 -> 97 (PO RULING
 * "2+3"). While min was 107 and `fillTarget` was 110 the two were only 3 apart, so the pad loop's
 * stop condition — `if (lineLen() >= MIN) break` (itemHighlightComposer.ts) — and the fill-aim
 * `AIM` (fillTarget - RESERVE, same file) were practically interchangeable. At 97 they are 13
 * apart, and the conflation became visible: the pad loop now stops as soon as a line is merely
 * LEGAL (>= the accept floor) instead of walking on toward the fill target, so every padded line
 * in production got ~10 characters shorter — on the acceptance seam fixture, 4 of 6 designs lost
 * their trailing "Classic Fit" (itemHighlightPushSeam.test.ts).
 *
 * THE RULING (verbatim from the correction brief). "The pad AIMS at the fill target and ACCEPTS
 * at the floor": the pad loop's stop condition must reach for `AIM` — reserve-adjusted exactly as
 * the POOL loop's own stop condition already does a few lines above it — never settle for `MIN`
 * the instant the line is merely LEGAL. `MIN` keeps its single OTHER job: deciding whether the
 * FINISHED line SHIPS or the design HOLDS (the entry-gate and post-loop floor checks, which are
 * correctly allowed to keep reading MIN — this pin scopes ONLY the loop's own `break`, never the
 * entry gate or the post-loop ship/hold decision, so it cannot be satisfied by mis-scoping either
 * of those instead).
 *
 * THE DEFECT CLASS THIS PIN BLOCKS is specifically "the break reads `MIN` ALONE, with no `AIM` at
 * all" — the exact #677 shape. It does NOT block `Math.max(AIM, MIN)`, which the fix legitimately
 * needs: when RESERVE is large (a long reserved brand phrase — see `needBrand`/`brandPick` above
 * in the same function), `AIM = fillTarget - RESERVE` can fall BELOW `MIN` (proven live by the
 * "brand at most once" fixture: RESERVE 21 -> AIM 89 < MIN 97). A bare-`AIM` break would then quit
 * the pad loop before ever reaching the floor — worse than #677's bug, and a direct violation of
 * "an under-min line never ships" for a line the loop could have legally reached. So the break MAY
 * reference both identifiers, but MUST reference `AIM` — a break gated on `MIN`/`.min` with no
 * `AIM` anywhere in the same condition is exactly the regression this pin exists to catch.
 *
 * WHY A COMMENT ISN'T ENOUGH. #677 already carried extensive prose about MIN vs fillTarget and the
 * conflation still shipped — a human/LLM editor can misread "the floor" and reach for the nearer
 * `MIN` identifier when touching this loop again. This pin makes that mechanically impossible to
 * reintroduce silently: it extracts the pad loop's own balanced-brace body from the real source
 * file and fails if ANY `break` statement inside it is gated on `MIN`/`.min` WITHOUT `AIM` also
 * present in that same statement.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = process.cwd()
const COMPOSER_FILE = path.join(REPO_ROOT, 'src/lib/fba/itemHighlightComposer.ts')
/** The pad loop's own anchor — unique in the file (the pool loop iterates `candidates`, not
 *  `factFillers`), so this cannot accidentally match the pool loop's stop condition instead. */
const LOOP_ANCHOR = 'for (const f of factFillers) {'

/**
 * Extracts the pad loop's balanced-brace body, starting at `LOOP_ANCHOR` (inclusive) through its
 * matching closing brace (inclusive). Returns null if the anchor is missing — a rename or removal
 * of the loop must fail this pin LOUD, never pass it silently by finding nothing to scan.
 */
export function extractPadLoopSource(fileText: string): string | null {
  const start = fileText.indexOf(LOOP_ANCHOR)
  if (start === -1) return null
  let depth = 0
  let end = -1
  for (let i = start; i < fileText.length; i++) {
    const ch = fileText[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end === -1) return null
  return fileText.slice(start, end)
}

/**
 * Within the pad loop's body, every `break` statement's guarding condition must reference `AIM` —
 * a break gated on `MIN`/a `.min` constant property with NO `AIM` anywhere in that same condition
 * is the #677 defect shape (settling for "merely legal" instead of reaching for the fill target).
 * `Math.max(AIM, MIN)` — both identifiers together — is NOT flagged: that combination is the
 * correct fix (AIM alone can fall below MIN when RESERVE is large, which must never make the loop
 * quit before the floor — see the file header). Returns the offending lines verbatim (empty = clean).
 */
export function findFloorGatedBreaks(loopBody: string): string[] {
  const offenders: string[] = []
  for (const line of loopBody.split(/\r?\n/)) {
    if (!/\bbreak\b/.test(line)) continue
    const readsFloor = /\bMIN\b/.test(line) || /\.min\b/.test(line)
    const readsAim = /\bAIM\b/.test(line)
    if (readsFloor && !readsAim) offenders.push(line.trim())
  }
  return offenders
}

describe('IH pad loop: the stop condition reaches for the fill target AIM, never settles for bare accept-floor MIN alone (controller correction to #677, 2026-09-08)', () => {
  it('SCANNER SELF-TEST: flags a break statement gated on MIN ALONE (the #677 shape — no AIM anywhere in the condition)', () => {
    const bad = 'for (const f of factFillers) {\n  if (lineLen() >= MIN) break\n  picked.push(f)\n}\n'
    const body = extractPadLoopSource(bad)
    expect(body).not.toBeNull()
    expect(findFloorGatedBreaks(body!)).toEqual(['if (lineLen() >= MIN) break'])
  })

  it('SCANNER SELF-TEST: flags a break statement gated on the `.min` constant property ALONE too', () => {
    const bad = 'for (const f of factFillers) {\n  if (lineLen() >= CONTENT_CONTRACT.itemHighlights.min) break\n}\n'
    const body = extractPadLoopSource(bad)
    expect(body).not.toBeNull()
    expect(findFloorGatedBreaks(body!)).toEqual(['if (lineLen() >= CONTENT_CONTRACT.itemHighlights.min) break'])
  })

  it('SCANNER SELF-TEST: does NOT flag a break statement gated on AIM alone', () => {
    const good = 'for (const f of factFillers) {\n  if (lineLen() >= AIM) break\n  picked.push(f)\n}\n'
    const body = extractPadLoopSource(good)
    expect(body).not.toBeNull()
    expect(findFloorGatedBreaks(body!)).toEqual([])
  })

  it('SCANNER SELF-TEST: does NOT flag `Math.max(AIM, MIN)` — AIM present alongside MIN is the correct fix, not the regression (RESERVE can push AIM below MIN; the loop must never quit before the floor)', () => {
    const good = 'for (const f of factFillers) {\n  if (lineLen() >= Math.max(AIM, MIN)) break\n}\n'
    const body = extractPadLoopSource(good)
    expect(body).not.toBeNull()
    expect(findFloorGatedBreaks(body!)).toEqual([])
  })

  it('SCANNER SELF-TEST: a `break` OUTSIDE the pad loop (e.g. the entry gate or a sibling loop) is invisible to the scan — this pin scopes ONLY the pad loop body', () => {
    const source = [
      'if (lineLen() < MIN) break // some other loop entirely, not factFillers',
      'for (const f of factFillers) {',
      '  if (lineLen() >= Math.max(AIM, MIN)) break',
      '}',
    ].join('\n')
    const body = extractPadLoopSource(source)
    expect(body).not.toBeNull()
    expect(body).not.toContain('some other loop entirely')
    expect(findFloorGatedBreaks(body!)).toEqual([])
  })

  it('the REAL pad loop in itemHighlightComposer.ts reaches for AIM (never gated on MIN alone)', () => {
    const source = fs.readFileSync(COMPOSER_FILE, 'utf8')
    const body = extractPadLoopSource(source)
    expect(body, 'pad loop anchor `for (const f of factFillers) {` not found — loop renamed/removed?').not.toBeNull()
    expect(findFloorGatedBreaks(body!)).toEqual([])
    expect(body).toContain('AIM')
    expect(body).toMatch(/lineLen\(\) >= .*AIM/)
  })
})
