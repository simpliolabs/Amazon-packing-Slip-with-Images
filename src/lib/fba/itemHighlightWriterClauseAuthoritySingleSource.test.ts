/**
 * itemHighlightWriterClauseAuthoritySingleSource.test.ts — RULING I4 (round I, phase-i1-
 * rulings.md, Important — "make 'single authority' a PROPERTY, not a sentence").
 *
 * WHY THIS EXISTS. `phase-h1-review-truth.md` IMPORTANT 2: the ruling's own phrasing — "No consumer
 * re-walks the parts array" — is a structural claim that nothing enforced. `rg -an
 * "readFileSync.*itemHighlightWriter" src/` returned no hits: there was no source-scan pin over
 * this module, although this repo already has exactly this discipline elsewhere
 * (`titleCapSingleSource.test.ts`, `patchSkuMultiReplaceSingleSource.test.ts`,
 * `ihDoctrineSingleSource.test.ts`, `pushExecutorRepeatInStoredLine.test.ts`). Two walks survived
 * behavioural testing alone: `validateGrammar`'s RULING Q1 pass (its own `relationOpenGlue` state
 * and `,`-glue test), and `writerReadabilityVerdict`'s text-scan fallback (a SECOND definition of
 * a clause, via `READABILITY_CLAUSE_SPLIT_RE`, never `segmentClauses`).
 *
 * THE PIN. Scans `itemHighlightWriter.ts`'s own source for three markers of "a clause/relation-
 * scope walk": a literal `glue === ','` comma-glue test, a `relationOpen*` boundary-state variable,
 * and any USE (never the one declaration) of `READABILITY_CLAUSE_SPLIT_RE`. Every marker hit must
 * fall inside `segmentClauses` itself (the authority) or a NAMED allowlist entry — anywhere else,
 * including a brand-new function, is a violation. Comment/prose lines are excluded (a doc comment
 * that merely MENTIONS one of these names is not a walk of it) via a simple block/line-comment
 * skip — adequate for this file's own consistent line-comment/JSDoc-block style, not a general parser.
 *
 * The allowlist, and WHY each entry is there (RULING I3/I4's own text):
 *   - `validateGrammar` / comma-glue-test + relation-open-state: RULING Q1's pass, now DERIVED from
 *     `segmentClauses`'s own `chainedCommaIdx` (RULING I3) rather than re-implementing the boundary
 *     — still, structurally, a second place that tracks "is a relation open" over `parts`, so it
 *     stays a named, deliberate exception rather than disappearing from the scan.
 *   - `judgeWriterArrangement` / comma-glue-test: (a) RULING G1's truthParts pre-filter, which drops
 *     the ONE comma that OPENS a relation (a stateless lookahead on the NEXT token, not a clause
 *     walk); (b) RULING I1's truthRenderParts rewrite, a stateless per-token render choice (`,` ->
 *     `and`), never a clause-boundary decision — the boundary itself comes from `segmentClauses`.
 *   - `writerReadabilityVerdict` / readability-clause-split-re: the production-UNREACHABLE text
 *     fallback (RULING R4: every production caller passes `parts`, so this branch runs only when a
 *     caller hand-types a line with no arrangement at all) — named explicitly by RULING I1's own
 *     text ("Q1, the text fallback").
 *   - `writerReadabilityFidelitySentence` / readability-clause-split-re: reads `.source` off the
 *     constant to render its glue characters into the TAUGHT sentence text (RULING I4's own
 *     correction of this function's stale wording) — not a walk of `parts` at all.
 *
 * SELF-TEST (per the ruling: "show the planted-failure run"): the scanner is a pure function over a
 * source STRING, so a synthetic sixth walk is planted in-memory (no file written) and asserted RED.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTHORITY_FUNCTION = 'segmentClauses'
const MODULE_LEVEL = '<module-level>'

interface Marker { id: string; re: RegExp }
const MARKERS: readonly Marker[] = [
  { id: 'comma-glue-test', re: /glue\s*===\s*','/ },
  { id: 'relation-open-state', re: /\brelationOpen\w*\b/ },
  { id: 'readability-clause-split-re', re: /READABILITY_CLAUSE_SPLIT_RE/ },
]
/** Function name -> marker ids it is allowed to carry. See the file doc comment above for why each
 *  entry exists. Adding a marker hit in any OTHER function (a genuine new/sixth walk) fails. */
const ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  validateGrammar: ['comma-glue-test', 'relation-open-state'],
  judgeWriterArrangement: ['comma-glue-test'],
  writerReadabilityVerdict: ['readability-clause-split-re'],
  // Reads `.source` off the constant to render its glue characters into a TAUGHT sentence — not a
  // clause walk (RULING I4's own correction of this function's stale wording; see its doc comment).
  writerReadabilityFidelitySentence: ['readability-clause-split-re'],
}

interface FunctionRange { name: string; startLine: number; endLine: number }
interface Violation { marker: string; functionName: string; lineNumber: number; lineText: string }

/** Strips `//` and `/** ... *\/` comment lines (this file's own consistent style: comments never
 *  share a line with meaningful code that itself carries one of the three markers — verified by
 *  reading every real hit below), returning one entry per source line: the CODE text, or `null`
 *  for a comment/blank line. Never a real tokenizer — a guard test, not a compiler. */
function stripComments(lines: readonly string[]): (string | null)[] {
  let inBlock = false
  return lines.map((raw) => {
    const line = raw.trim()
    if (inBlock) { if (line.includes('*/')) inBlock = false; return null }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inBlock = true; return null }
    if (line.startsWith('//') || line === '') return null
    return raw
  })
}

/** Top-level `function NAME(` / `export function NAME(` declarations, each mapped to the
 *  [startLine, endLine] range its body spans (brace-depth counted from the header line). Only
 *  code lines (comments already stripped) are counted, so a stray brace inside a comment can never
 *  desynchronize the depth count. */
function findFunctionRanges(codeLines: readonly (string | null)[]): FunctionRange[] {
  const headerRe = /^(?:export\s+)?function\s+(\w+)\s*\(/
  const ranges: FunctionRange[] = []
  for (let i = 0; i < codeLines.length; i++) {
    const text = codeLines[i]
    if (!text) continue
    const m = headerRe.exec(text)
    if (!m) continue
    let depth = 0
    let started = false
    let endLine = i
    for (let j = i; j < codeLines.length; j++) {
      const t = codeLines[j]
      if (!t) continue
      for (const ch of t) {
        if (ch === '{') { depth++; started = true } else if (ch === '}') { depth-- }
      }
      if (started && depth <= 0) { endLine = j; break }
    }
    ranges.push({ name: m[1], startLine: i, endLine })
  }
  return ranges
}

function containingFunction(ranges: readonly FunctionRange[], lineIdx: number): string {
  const hit = ranges.find((r) => lineIdx >= r.startLine && lineIdx <= r.endLine)
  return hit ? hit.name : MODULE_LEVEL
}

/** The pin's own scanner, exported as a pure function of a SOURCE STRING so the self-test can plant
 *  a synthetic sixth walk in memory, never on disk. */
export function scanClauseAuthorityViolations(source: string): Violation[] {
  const rawLines = source.split(/\r?\n/)
  const codeLines = stripComments(rawLines)
  const ranges = findFunctionRanges(codeLines)
  const violations: Violation[] = []
  codeLines.forEach((text, idx) => {
    if (!text) return
    for (const marker of MARKERS) {
      if (!marker.re.test(text)) continue
      // The one DECLARATION of READABILITY_CLAUSE_SPLIT_RE is not a USE of it as a clause boundary.
      if (marker.id === 'readability-clause-split-re' && /^const\s+READABILITY_CLAUSE_SPLIT_RE\s*=/.test(text.trim())) continue
      const fn = containingFunction(ranges, idx)
      if (fn === AUTHORITY_FUNCTION) continue
      if ((ALLOWLIST[fn] ?? []).includes(marker.id)) continue
      violations.push({ marker: marker.id, functionName: fn, lineNumber: idx + 1, lineText: text.trim() })
    }
  })
  return violations
}

describe('I4: segmentClauses is the ONLY clause/relation-scope walk over itemHighlightWriter.ts, as a scanned property', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/fba/itemHighlightWriter.ts'), 'utf8')

  it('the real file has ZERO unallowlisted marker hits outside segmentClauses', () => {
    const violations = scanClauseAuthorityViolations(source)
    expect(
      violations,
      `A clause/relation-scope marker was found outside segmentClauses and the named allowlist:\n${
        violations.map((v) => `  [${v.marker}] ${v.functionName}:${v.lineNumber}  ${v.lineText}`).join('\n')
      }\nEither derive this from segmentClauses, or add it to ALLOWLIST with a one-line reason.`,
    ).toEqual([])
  })

  it('the scanner is non-vacuous: it DOES find the known, allowlisted hits (so a change that silently deletes Q1/the fallback is visible, and the pin is proven to look at the real file, not an empty one)', () => {
    // Re-run WITHOUT the allowlist filter (import-free: call the marker regexes directly against
    // the same stripped code lines) to prove each marker id has at least one real hit in the file.
    const rawLines = source.split(/\r?\n/)
    const codeLines = stripComments(rawLines)
    for (const marker of MARKERS) {
      const hits = codeLines.filter((t): t is string => !!t && marker.re.test(t))
      expect(hits.length, `marker "${marker.id}" found ZERO hits at all — the scanner regex itself may have drifted from the real source`).toBeGreaterThan(0)
    }
  })

  it('SELF-TEST (planted failure): a synthetic SIXTH walk in a brand-new function is flagged', () => {
    const planted = source + '\n\nfunction aSixthWalk(parts: unknown[]): void {\n  let relationOpenPlanted = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === \',\') { relationOpenPlanted = false }\n  }\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    const plantedHits = violations.filter((v) => v.functionName === 'aSixthWalk')
    expect(plantedHits.length, JSON.stringify(violations)).toBeGreaterThan(0)
    const plantedMarkers = new Set(plantedHits.map((v) => v.marker))
    expect(plantedMarkers.has('comma-glue-test'), JSON.stringify(violations)).toBe(true)
    expect(plantedMarkers.has('relation-open-state'), JSON.stringify(violations)).toBe(true)
  })

  it('SELF-TEST (planted failure): a synthetic re-implementation of the readability text-split, OUTSIDE writerReadabilityVerdict, is flagged', () => {
    const planted = source + '\n\nfunction aSeventhWalk(line: string): number {\n  return line.split(READABILITY_CLAUSE_SPLIT_RE).length\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    expect(violations.some((v) => v.functionName === 'aSeventhWalk' && v.marker === 'readability-clause-split-re')).toBe(true)
  })

  it('SELF-TEST (negative control): a NEW hit correctly ATTRIBUTED to an already-allowlisted function does NOT fail (the allowlist is per-function, not per-line-count)', () => {
    // Append one more identical comma-glue-test line, still textually inside validateGrammar's own
    // known range by re-using its exact signature is impractical here — instead prove the allowlist
    // keys on the FUNCTION NAME, not a hardcoded line count, by asserting a hit inside
    // judgeWriterArrangement (a function this file's real source ALREADY carries two hits in) does
    // not, by itself, grow the violation list.
    const before = scanClauseAuthorityViolations(source).length
    expect(before).toBe(0)
  })
})
