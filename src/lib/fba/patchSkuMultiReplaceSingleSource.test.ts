/**
 * patchSkuMultiReplaceSingleSource.test.ts — the SOURCE-SCAN ENUMERATION TEST (fix round 2,
 * controller RULING item 3, phase-1-fix-round-2-findings.md: "a source-scan pin (the
 * genderLexiconSingleSource.test.ts pattern) that fails if a new op:'replace' op is constructed
 * outside the guarded seam").
 *
 * WHY THIS EXISTS. `patchSkuMulti` (pushExecutor.ts) is now the REJOIN GUARD — the one place an
 * `op:'replace'` whose `value` resolved empty gets refused before any network call (BLOCKING 1, fix
 * round 2). That guard only protects a caller if the caller actually ROUTES its ops through
 * `patchSkuMulti` (or one of the three older, already-guarded/self-contained direct-network
 * functions this file also calls straight to `fetch` — `patchSku`, `patchParentSkuWithBaseline`,
 * `patchSkuDetail`). A FUTURE function that builds its own `{op:'replace', ...}` literal and issues
 * its OWN `fetch(...)` PATCH (instead of calling `patchSkuMulti`) would silently reintroduce
 * exactly the class BLOCKING 1 (fix round 2) closed — the bulk path's own history (opFor,
 * specializePlanValue, the Phase-2 calibration loop all skirting the single path's guard) is the
 * proof this recurs. This is the runtime backstop, in the spirit of this repo's own
 * `genderLexiconSingleSource.test.ts` / `itemHighlightNetUnionCollision.test.ts`.
 *
 * SCANNER RULE. pushExecutor.ts is a sequence of TOP-LEVEL (column-0) `function`/`async function`
 * declarations — verified by construction (every function in this file is declared at column 0;
 * nothing is nested at the top level), so "everything between one top-level declaration and the
 * next" is exactly that function's own body, INCLUDING any nested arrow-function closures it
 * defines (no brace-matching needed — the next column-0 `function` keyword is an unambiguous
 * boundary). For every such function span:
 *   1. If the span contains NO `op:\s*'replace'` construction, it is not a candidate — skipped.
 *   2. If the function's OWN NAME is one of the four direct-network functions
 *      (`patchSku`, `patchParentSkuWithBaseline`, `patchSkuDetail`, `patchSkuMulti`) it is exempt —
 *      these four ARE the guarded/self-contained seam (three issue their own guarded `fetch`
 *      directly; `patchSkuMulti` IS the rejoin guard itself).
 *   3. Otherwise the span (comments stripped, since this codebase documents heavily) must contain a
 *      call to `patchSkuMulti(` — i.e., this function constructs raw ops but FUNNELS them through
 *      the guarded rejoin rather than issuing its own unguarded network call. Its absence is a
 *      violation.
 *
 * KNOWN, OUT-OF-SCOPE GAP (recorded, not fixed here — phase-1-report.md "Fix round 2" concerns):
 * `patchSku`/`patchParentSkuWithBaseline` (core content fields: title/bullets/description/keywords)
 * have NO emptiness guard of their own today — pre-existing, unrelated to Item Highlights, and
 * outside this ruling's scope (which named `patchSkuMulti`'s ~20 call sites specifically). They are
 * allowlisted here as KNOWN direct-network functions, not silently declared safe.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC_PATH = path.join(process.cwd(), 'src/lib/fba/pushExecutor.ts')

/** A real op CONSTRUCTION, not a TYPE declaration — both look like `op: 'replace'; path: string`
 *  (TS type literal, e.g. `PatchOp`'s own definition) vs `op: 'replace', path: \`/attributes/x\``
 *  (an actual object literal). The tell: a construction's `path:` is followed by a string/template
 *  literal opening character; a type's `path:` is followed by the bare word `string`. */
const REPLACE_CONSTRUCTION_RE = /op:\s*'replace'[^}]{0,80}?path:\s*[`'"]/

/** The four functions in pushExecutor.ts that issue their OWN network PATCH (three self-contained
 *  and separately guarded/documented; `patchSkuMulti` IS the rejoin guard this pin protects). */
const DIRECT_NETWORK_ALLOWLIST = new Set(['patchSku', 'patchParentSkuWithBaseline', 'patchSkuDetail', 'patchSkuMulti'])

/** Strip `//` line comments and `/* … *‍/` block comments — good enough for this scanner (matches
 *  this repo's own `itemHighlightNetUnionCollision.test.ts` precedent), never touches string/
 *  template contents that merely look like a comment. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

/**
 * Scans `src` (pushExecutor.ts's own text, or a synthetic snippet shaped like it) for every
 * top-level function span that constructs an `op:'replace'` literal, and returns one violation
 * string per span that neither is a direct-network allowlisted function NOR calls
 * `patchSkuMulti(` anywhere in its own body (nested closures included, since the span runs to the
 * next top-level declaration).
 */
export function findUnguardedReplaceConstructions(src: string): string[] {
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm
  const decls: { name: string; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = declRe.exec(src))) decls.push({ name: m[1], start: m.index })
  const violations: string[] = []
  for (let i = 0; i < decls.length; i++) {
    const { name, start } = decls[i]
    const end = i + 1 < decls.length ? decls[i + 1].start : src.length
    const span = src.slice(start, end)
    if (!REPLACE_CONSTRUCTION_RE.test(span)) continue   // this function never constructs a replace op — not a candidate (a bare `path: string` TYPE annotation, e.g. PatchOp's own definition, does not count)
    if (DIRECT_NETWORK_ALLOWLIST.has(name)) continue   // itself one of the four known network chokepoints
    const stripped = stripComments(span)
    if (!/patchSkuMulti\(/.test(stripped)) {
      violations.push(`${name}: constructs an op:'replace' but never calls patchSkuMulti(...) and is not one of the direct-network functions (${[...DIRECT_NETWORK_ALLOWLIST].join(', ')}) — a new unguarded PATCH path?`)
    }
  }
  return violations
}

describe("pushExecutor.ts: every op:'replace' construction funnels through the guarded seam (source-scan pin, fix round 2, controller RULING item 3)", () => {
  it('SCANNER SELF-TEST: flags a synthetic function that builds a replace op but never reaches patchSkuMulti or a direct-network function', () => {
    const bad = [
      "function sneakyNewBulkPush(sellerId, token, sku) {",
      "  const ops = [{ op: 'replace', path: '/attributes/x', value: [] }]",
      "  return fetch(url, { method: 'PATCH', body: JSON.stringify(ops) })",
      "}",
      "function nextFn() {}",
    ].join('\n')
    expect(findUnguardedReplaceConstructions(bad)).not.toEqual([])
  })

  it('SCANNER SELF-TEST: accepts a function that constructs a replace op and funnels it through patchSkuMulti (even via a nested closure)', () => {
    const good = [
      "function healSomething(sellerId, token, productType, sku) {",
      "  const ops = [{ op: 'replace', path: '/attributes/x', value: [item] }]",
      "  const run = () => patchSkuMulti(sellerId, token, productType, sku, ops, 'LIVE')",
      "  return run()",
      "}",
      "function nextFn() {}",
    ].join('\n')
    expect(findUnguardedReplaceConstructions(good)).toEqual([])
  })

  it('SCANNER SELF-TEST: accepts a direct-network allowlisted function constructing its own replace op', () => {
    const good = [
      "function patchSku(sellerId, token, productType, sku, attribute, value, mode) {",
      "  const patches = [{ op: 'replace', path: '/attributes/x', value: [] }]",
      "  return fetch(url, { method: 'PATCH' })",
      "}",
      "function nextFn() {}",
    ].join('\n')
    expect(findUnguardedReplaceConstructions(good)).toEqual([])
  })

  it("SCANNER SELF-TEST: a function with NO op:'replace' construction is never a candidate (no false positive on unrelated functions)", () => {
    const fine = [
      "function unrelatedHelper() {",
      "  return 1 + 1",
      "}",
      "function nextFn() {}",
    ].join('\n')
    expect(findUnguardedReplaceConstructions(fine)).toEqual([])
  })

  it('pushExecutor.ts has ZERO unguarded op:\'replace\' constructions today', () => {
    const src = fs.readFileSync(SRC_PATH, 'utf8')
    expect(findUnguardedReplaceConstructions(src)).toEqual([])
  })

  it('PROVEN TO GO RED on a real perturbation (executed, not claimed): renaming every real patchSkuMulti( call site (so the funnel is textually severed while the ops still construct replace literals) flags every non-allowlisted caller', () => {
    // In-memory string perturbation only — never written to disk, no revert needed. Faithfully
    // reproduces the class this pin exists to catch: a caller's ops still build 'replace' literals,
    // but the call that used to funnel them through patchSkuMulti is gone/renamed.
    const src = fs.readFileSync(SRC_PATH, 'utf8')
    const perturbed = src.replace(/patchSkuMulti\(/g, 'patchSkuMultiRENAMEDFORTEST(')
    const violations = findUnguardedReplaceConstructions(perturbed)
    expect(violations.length).toBeGreaterThan(0)
    // Every real non-allowlisted function known to construct a replace op and rely on patchSkuMulti
    // goes red together — proving the scan's sensitivity is not a one-off coincidence.
    for (const fn of ['healParentComposite', 'healChildTwinComposite', 'healCompositeCompleteWrite', 'negotiateParentRecordFix', 'executePush', 'executeBulkDetailsPush']) {
      expect(violations.some((v) => v.startsWith(`${fn}:`))).toBe(true)
    }
  })
})
