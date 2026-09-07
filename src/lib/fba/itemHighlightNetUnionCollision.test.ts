/**
 * itemHighlightNetUnionCollision.test.ts — SOURCE-SCAN ENUMERATION TEST (fix round 1, controller
 * RULING item 4, phase-1-fix-round-findings.md: "Pin the collision itself: a test asserting that no
 * production caller of the net treats its output as a plain string ... proven to go RED when a
 * caller is reverted to the old shape").
 *
 * WHY THIS EXISTS. `capItemHighlightRepeats` used to return a plain `string`, and `''` carried two
 * facts at once ("no value" AND "refused") — the sentinel collision BLOCKING 1/2 closed
 * (phase-1-review.md). It now returns `IhNetResult` (`{ok:true, value} | {ok:false, reason}`), and
 * TypeScript's discriminated-union narrowing already refuses most misuse at compile time — but a
 * caller that bypasses the type system (an `as any`/`as string` cast, a dynamic property read, or a
 * FUTURE signature regression back to `string`) would not be caught by `tsc`. This is the runtime
 * backstop, in the spirit of this repo's own `genderLexiconSingleSource.test.ts`: it reads every
 * non-test `.ts`/`.tsx` file under `src/`, finds every `capItemHighlightRepeats(` CALL (never its own
 * declaration), and requires the ONE sanctioned shape every real caller in this codebase already
 * uses: `const/let <name> = capItemHighlightRepeats(...)` followed by a check on `<name>.ok` before
 * any value is read. Anything else — chaining a string method straight off the call, assigning without
 * ever checking `.ok`, reassigning an outer variable — is flagged.
 *
 * The scanner (`findUnionCollisions`) is exported so this file can prove its OWN sensitivity against
 * synthetic snippets (the "proven to go RED" requirement) without needing to mutate the real tree —
 * and the manual proof of that mutation, run once against the REAL file and reverted, is recorded in
 * phase-1-report.md's "Fix round 1" section (`git diff` shown there, RED then restored to GREEN).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC_ROOT = path.join(process.cwd(), 'src')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...listTsFiles(full)); continue }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/** Strips `//` line comments (never touches string/template contents that merely LOOK like a
 *  comment — good enough for this scanner, which only needs to skip past this codebase's heavy
 *  doc-comment blocks between an assignment and its `.ok` check, never to fully parse TS). */
function stripLineComments(s: string): string {
  return s.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

/**
 * Scans one file's source for `capItemHighlightRepeats(` CALL sites (its own `function`
 * declaration is excluded — that is the definition, not a caller) and returns one violation string
 * per call that does not match the sanctioned shape: immediately the right-hand side of a fresh
 * `const`/`let` declaration, with `<name>.ok` checked somewhere in the following code — comments
 * stripped first, since this codebase documents heavily and a doc-comment block routinely sits
 * between the assignment and the check (a raw character-count window would either false-positive on
 * a well-documented caller or, widened enough to tolerate that, stop being a meaningful bound at all).
 */
export function findUnionCollisions(src: string, label: string): string[] {
  const violations: string[] = []
  const marker = 'capItemHighlightRepeats('
  let from = 0
  for (;;) {
    const callIdx = src.indexOf(marker, from)
    if (callIdx === -1) break
    from = callIdx + marker.length
    const beforeWord = src.slice(Math.max(0, callIdx - 24), callIdx)
    if (/function\s*$/.test(beforeWord)) continue // the declaration itself, not a call
    const before = src.slice(Math.max(0, callIdx - 160), callIdx)
    const assign = before.match(/(?:const|let)\s+(\w+)\s*=\s*$/)
    if (!assign) {
      violations.push(`${label}@${callIdx}: capItemHighlightRepeats( is not the RHS of a fresh const/let assignment — found: ${JSON.stringify(src.slice(Math.max(0, callIdx - 50), callIdx + 60))}`)
      continue
    }
    const varName = assign[1]
    // Balanced-paren scan for THIS call's own closing paren, so the `.ok` search starts AFTER the
    // call (not inside its arguments, which could themselves contain unrelated `.ok` text).
    let depth = 1
    let i = callIdx + marker.length
    while (depth > 0 && i < src.length) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
      i++
    }
    const after = stripLineComments(src.slice(i, i + 900))
    if (!new RegExp(`\\b${varName}\\.ok\\b`).test(after)) {
      violations.push(`${label}@${callIdx}: assigned to "${varName}" but "${varName}.ok" is never checked in the following code (comments stripped) — found: ${JSON.stringify(after.slice(0, 80))}`)
    }
  }
  return violations
}

describe('capItemHighlightRepeats UNION COLLISION scan (fix round 1, controller RULING item 4)', () => {
  it('SCANNER SELF-TEST: catches the anti-pattern this pin exists to stop — chaining a string method straight off the call, never assigned, never checked', () => {
    const bad = `const x = capItemHighlightRepeats(value).trim()`
    expect(findUnionCollisions(bad, 'synthetic')).not.toEqual([])
  })

  it('SCANNER SELF-TEST: catches an assignment that never checks .ok before the value is read', () => {
    const bad = `const r = capItemHighlightRepeats(value)\nreturn r.value`
    expect(findUnionCollisions(bad, 'synthetic')).not.toEqual([])
  })

  it('SCANNER SELF-TEST: catches a reassignment to an outer variable (not a fresh const/let)', () => {
    const bad = `let out\nout = capItemHighlightRepeats(value)\nreturn out.ok ? out.value : ''`
    expect(findUnionCollisions(bad, 'synthetic')).not.toEqual([])
  })

  it('SCANNER SELF-TEST: accepts the sanctioned shape — assign fresh, then check .ok before reading a value', () => {
    const good = `const r = capItemHighlightRepeats(value)\nif (!r.ok) return []\nconst v = r.value`
    expect(findUnionCollisions(good, 'synthetic')).toEqual([])
  })

  it("SCANNER SELF-TEST: does not mistake the function's own declaration for a call", () => {
    const decl = `export function capItemHighlightRepeats(value: string): IhNetResult {\n  return { ok: true, value }\n}`
    expect(findUnionCollisions(decl, 'synthetic')).toEqual([])
  })

  it('every production (non-test) caller under src/ uses the sanctioned shape today — zero collisions', () => {
    const violations: string[] = []
    for (const file of listTsFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8')
      if (!src.includes('capItemHighlightRepeats(')) continue
      violations.push(...findUnionCollisions(src, path.relative(SRC_ROOT, file)))
    }
    expect(violations).toEqual([])
  })
})
