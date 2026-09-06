/**
 * THE CLASS THIS TEST CLOSES: a code comment became a load-bearing product constraint that nobody
 * re-derived for months.
 *
 * `TITLE_BAND_HI = 75` was documented as "Amazon's, externally enforced (Amazon rewrites a longer
 * title; error 100476)" and as a "2026-07-27 policy" under which "Amazon auto-rewrites item_name
 * over 75". Both claims were FALSE. Amazon's live product-type schema for SWEATSHIRT gives
 * item_name `maxLength: 200` — with a 78-character worked example — and category best-sellers ship
 * 88-111 characters unrewritten (B0C6TV2Z2Z 111, B0B8Z2K3NR 110 WITH a variation twister,
 * B0D968BB8S 88; DOM-verified 2026-09-05).
 *
 * What 75 actually is: Amazon error 100476, verbatim, is "Provide an Item Name that is 75
 * characters or less TO USE ITEM HIGHLIGHTS" — a PRECONDITION FOR A DIFFERENT FIELD. Reading it as
 * a title cap cost ~13-36 characters of the highest-attention text on every listing in the
 * catalogue, in the category where winners write LONGEST.
 *
 * WHY A TEST AND NOT A COMMENT. Fixing the comments repairs the reported instance; it does nothing
 * to stop the next person re-deriving the same wrong belief from an Amazon error message and
 * writing it back down. This test FAILS when a NEW instance is added — which is the enumeration
 * property the standing directive requires, not an assertion about today's known sites.
 *
 * HOW TO SATISFY IT if you are hitting this legitimately: state the constraint truthfully. 75 is
 * OUR ceiling and it buys Item Highlights; Amazon's is `AMAZON_TITLE_MAX`. To re-derive Amazon's
 * real limit for any attribute instead of trusting any comment (including this one):
 *   GET /api/fba/listing-optimizer/push-content
 *       ?parent_asin=<parent>&debug=1&field=details&detail_field=Item%20Name
 * and read `rawSubschema`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { AMAZON_TITLE_MAX, ITEM_HIGHLIGHTS_TITLE_PRECONDITION, CONTENT_CONTRACT } from './contentContract'

const SRC = join(process.cwd(), 'src')

/** Claims that Amazon itself caps/rewrites item_name below 200. Every one of these is false. */
const FALSE_CLAIMS: { re: RegExp; why: string }[] = [
  { re: /Amazon\s+(?:will\s+)?auto[-\s]?rewrites?\b/i, why: 'Amazon does not auto-rewrite over-75 item_names; best-sellers ship 88-111 unrewritten' },
  { re: /Amazon'?s?\s+(?:new\s+)?(?:75|seventy-five)[-\s]?char(?:acter)?\s+(?:hard\s+)?(?:cap|limit)/i, why: "75 is not Amazon's cap — Amazon's is 200" },
  { re: /Amazon'?s?\s+new\s+title\s+limit/i, why: 'there is no such Amazon title limit at 75' },
  { re: /75\s*[-—]\s*Amazon'?s,?\s+externally\s+enforced/i, why: '75 is ours, not externally enforced' },
]

/**
 * A line is EXEMPT when it is documenting the falsehood rather than asserting it. Corrective
 * comments necessarily quote the old wording, and this test must not forbid explaining the bug.
 * Deliberately narrow: a bare "false" is not enough, the line must carry a correction marker.
 */
const CORRECTION_MARKERS = /\bCORRECTED\b|\bFALSE\b|\bused to (?:read|say|assert)\b|\bTHAT WAS FALSE\b|\bTHAT IS FALSE\b|\bmisread\b/i

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(full)) yield full
  }
}

describe('Amazon item_name limit — the truth, enforced', () => {
  it('AMAZON_TITLE_MAX is 200, from the live product-type schema', () => {
    expect(AMAZON_TITLE_MAX).toBe(200)
  })

  it('our 75 is named as the Item Highlights precondition, not as Amazon\'s cap', () => {
    expect(ITEM_HIGHLIGHTS_TITLE_PRECONDITION).toBe(75)
    // The working ceiling may be raised deliberately (title-ceiling spec Phase 4). What must never
    // happen is it drifting ABOVE Amazon's real limit, or being justified as Amazon's own rule.
    expect(CONTENT_CONTRACT.title.hardCap).toBeLessThanOrEqual(AMAZON_TITLE_MAX)
  })

  it('no source file asserts that Amazon caps or rewrites item_name below 200', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      // This file necessarily contains the patterns it forbids.
      if (file.endsWith('amazonTitleLimitTruth.test.ts')) continue
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        if (CORRECTION_MARKERS.test(line)) return
        for (const { re, why } of FALSE_CLAIMS) {
          if (re.test(line)) {
            offenders.push(`${relative(process.cwd(), file)}:${i + 1}\n    ${line.trim().slice(0, 160)}\n    WHY THIS IS WRONG: ${why}`)
            break
          }
        }
      })
    }
    expect(
      offenders,
      `Amazon does NOT cap item_name at 75 — its live schema says maxLength 200, and error 100476 ` +
      `reads "Provide an Item Name that is 75 characters or less TO USE ITEM HIGHLIGHTS", which is a ` +
      `precondition for a different field. Say that instead:\n\n${offenders.join('\n\n')}\n`,
    ).toEqual([])
  })
})
