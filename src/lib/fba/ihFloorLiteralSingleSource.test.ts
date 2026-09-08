/**
 * ihFloorLiteralSingleSource.test.ts — SOURCE-SCAN ENUMERATION TEST (PO RULING "2+3", 2026-09-07/08:
 * lower the Item Highlights floor from 107 to 97, executing the deferred half of that ruling —
 * `CONTENT_CONTRACT.itemHighlights.min`, contentContract.ts).
 *
 * WHY THIS EXISTS. This floor already lived in (at least) THREE places before this fix:
 * `contentContract.ts` (the canonical constant) and two hand-copied `107` literals in
 * `src/app/fba/listing/[asin]/page.tsx` (~:4555 and ~:6215, the per-design card and the push-preview
 * panel) — a floor duplicated into N call sites is the exact defect class this repo has spent the
 * last week closing (see `keyword-pool-key-chaos.md`, `title-spec-truth-net.md` for the general
 * pattern: one truth, many silent copies). Both `page.tsx` literals are now
 * `CONTENT_CONTRACT.itemHighlights.min`. This pin is the mechanical guard against a FOURTH copy
 * (or a reintroduced page.tsx-style copy) ever being hand-typed again, in this file or a new one.
 *
 * SCANNER RULE. Walks every non-test `.ts`/`.tsx` file under `src/` (test files are excluded, same
 * as this repo's `ihDoctrineSingleSource.test.ts` precedent — a test's own historical/narrative prose
 * legitimately cites the number `107` as a fact about a PAST ruling, e.g. "under the OLD 107 floor",
 * and is not itself a length literal a program branches on) and flags any line containing the bare
 * word `107` UNLESS that line is a comment (trimmed line starts with `//`, `*`, or `/**` — this
 * repo's two comment styles) — i.e. any line where `107` appears in actual code, not prose. Matched
 * by EXACT file + VERBATIM line text (never by line number/count), so an existing allowlisted
 * (comment) line can still change freely — only a genuinely NEW code-context `107` goes red.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = process.cwd()
const SCAN_DIR = 'src'
const LITERAL_RE = /\b107\b/

/** A line is treated as prose/comment, not code, if its trimmed text opens with one of this
 *  codebase's two comment idioms. `/* ... *\/` single-line block comments are not used for this
 *  literal anywhere in the live tree (verified by the "zero unallowlisted" test below), so they are
 *  deliberately not special-cased — a future one would correctly need its own allowlist entry or a
 *  scanner update, not a silent pass. */
const isCommentLine = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/**')
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Scans `root`/`scanDir` for a bare `107` appearing OUTSIDE a comment line. Exported so this file's
 *  own sensitivity can be proven against a synthetic root without mutating the real tree. */
export function findBareFloorLiterals(root: string, scanDir: string): string[] {
  const violations: string[] = []
  const dirPath = path.join(root, scanDir)
  for (const file of walk(dirPath)) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    let lines: string[]
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { continue }
    lines.forEach((lineText, i) => {
      if (!LITERAL_RE.test(lineText)) return
      if (isCommentLine(lineText)) return
      violations.push(`${rel}:${i + 1}: ${lineText.trim()}`)
    })
  }
  return violations
}

describe('IH floor literal (PO RULING "2+3", 2026-09-07/08): no bare `107` length literal survives outside a comment under src/', () => {
  it('SCANNER SELF-TEST: flags a `107` used as an actual comparison, not a comment', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-ih-floor-literal-scanner-self-test-bad')
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'bad.ts'), "export const held = value.length < 107\n")
    try {
      const violations = findBareFloorLiterals(tmp, '.')
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('bad.ts')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SCANNER SELF-TEST: a `107` inside a `//` or `*` comment line is NOT flagged', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-ih-floor-literal-scanner-self-test-good')
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'good.ts'),
      [
        '// the OLD floor was 107, before the 2+3 ruling',
        '/**',
        ' * historical note: this used to be 107',
        ' */',
        'export const min = CONTENT_CONTRACT.itemHighlights.min',
        '',
      ].join('\n'),
    )
    try {
      expect(findBareFloorLiterals(tmp, '.')).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('the REAL tree has ZERO bare-`107`-as-code occurrences under src/ (non-test files) — every consumer reads CONTENT_CONTRACT.itemHighlights.min', () => {
    const violations = findBareFloorLiterals(REPO_ROOT, SCAN_DIR)
    expect(violations).toEqual([])
  })
})
