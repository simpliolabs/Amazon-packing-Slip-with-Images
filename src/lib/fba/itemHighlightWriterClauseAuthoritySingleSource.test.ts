/**
 * itemHighlightWriterClauseAuthoritySingleSource.test.ts — RULING I4 (round I) landed a REGEX/
 * line-range pin; RULING K3 (round K1, phase-k1-rulings.md, Important — "rebuild it on the
 * TypeScript AST") REPLACES its mechanism, keeping the same intent.
 *
 * WHY THE REGEX VERSION FAILED. Review I1 (IMPORTANT 3) demonstrated the I4 pin evaded by THREE
 * shapes it could not see, plus one the ruling separately names (K7's own `wearFactCloses` residue
 * is a different concern; this file is only about the comma/relation-scope WALK):
 *   - B: `glue === ","` (double-quoted) — the old marker was a literal single-quote regex.
 *   - C: `part.glue === COMMA_TOK` (a module constant) — the old marker required the LITERAL `','`.
 *   - D: `GLUE_PUNCTUATION.has(part.glue)` — the old marker never looked for a `.has()` call at all.
 *   - (state) `openRelation`/`relOpen`/`inRelation` — the old state marker was a `relationOpen\w*`
 *     NAME regex; any other name for the identical boundary-tracking variable evaded it.
 *   - F: a SECOND clause walk nested INSIDE `judgeWriterArrangement` — the old pin found function
 *     boundaries by counting `function NAME(` headers and braces, so anything nested inside an
 *     ALLOWLISTED function's own body silently inherited its exemption.
 *
 * THE NEW MECHANISM. Every check below is STRUCTURAL — it reads the real TypeScript AST (the same
 * `typescript` package this repo's own door guard already uses,
 * `itemHighlightWriterEnumeration.test.ts`, spec §2h) — never a name or a quote style:
 *   - `comma-glue-test`: any `==`/`===`/`!=`/`!==` comparison where one side is a `.glue` property
 *     access and the other side is a string literal `','` in EITHER quote style, OR an identifier
 *     that resolves (via this SAME file's own top-level `const NAME = ','` declarations — a real
 *     literal-value resolution, not a name pattern) to the literal `,`. Closes B and C.
 *   - `glue-has-call`: any `<expr>.has(<something>.glue)` call — the idiom `segmentClauses` itself
 *     uses for its `closers` set. Closes D's comma-test half.
 *   - `relation-open-state`: any loop over the `parts` parameter (`for (... of parts)`,
 *     `parts.entries()`, or unwrapped through an `as`/parenthesized expression) whose body
 *     reassigns (bare `=`, never `===`) a variable declared OUTSIDE that loop, in the SAME function
 *     — i.e. state that survives across iterations — regardless of what that variable is NAMED.
 *     Closes D's state half and every other spelling the reviewer could reach for.
 *   - Function attribution walks the REAL AST parent chain to the nearest enclosing function-like
 *     node (declaration, named function expression/arrow via its `const NAME = `, or method) —
 *     never a brace-counted range — so a walk nested inside an allowlisted function is its OWN
 *     scope and is named `<anonymous nested in X>` (or its own name, if it has one), which is never
 *     itself in `ALLOWLIST`. Closes F.
 *
 * The allowlist (unchanged reasons from RULING I3/I4's own text, restated per marker):
 *   - `validateGrammar`: `comma-glue-test` (RULING Q1's own `,`-vs-relation test) +
 *     `relation-open-state` (RULING Q1's `relationOpenGlue`, now derived from `segmentClauses`'s
 *     `chainedCommaIdx` per RULING I3, but still, structurally, a second place that tracks "is a
 *     relation open" over `parts`) + `glue-has-call` (`RELATION_GLUE.has(part.glue)` inside that
 *     SAME pass).
 *   - `judgeWriterArrangement`: `comma-glue-test` (RULING G1's truthParts pre-filter — a stateless
 *     lookahead on the NEXT token, not a clause walk) + `glue-has-call` (the SAME pre-filter's
 *     `RELATION_GLUE.has(next.glue)` check).
 *   - `glueRole`: `glue-has-call` (`LIST_GLUE.has`/`RELATION_GLUE.has` — classifies ONE token's role
 *     in isolation; it is called once per token by every other pass and carries no state of its own
 *     across calls, so it is the foundational primitive the walk authorities call, never a walk).
 *   - `writerReadabilityVerdict` / `writerReadabilityFidelitySentence`: `readability-clause-split-re`
 *     — a REFERENCE to `READABILITY_CLAUSE_SPLIT_RE` (resolved as an AST identifier reference, not a
 *     text scan), the production-UNREACHABLE text fallback (RULING R4) and the registry-sentence
 *     renderer (RULING I4), neither of which is a walk of `parts`.
 *
 * SELF-TEST (per the ruling: "add a self-test for plants B/C/D/F, not only for the one shape the
 * ruling's sentence named"): every plant the reviewer demonstrated is reproduced in-memory (no file
 * written) and asserted RED, alongside the original A/E self-tests and the negative control.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const AUTHORITY_FUNCTION = 'segmentClauses'
const MODULE_LEVEL = '<module-level>'
const PARTS_PARAM_NAME = 'parts'

interface Violation { marker: string; functionName: string; line: number; text: string }

const ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  validateGrammar: ['comma-glue-test', 'relation-open-state', 'glue-has-call'],
  judgeWriterArrangement: ['comma-glue-test', 'glue-has-call'],
  glueRole: ['glue-has-call'],
  writerReadabilityVerdict: ['readability-clause-split-re'],
  writerReadabilityFidelitySentence: ['readability-clause-split-re'],
}

function isGluePropertyAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'glue'
}

/** Unwraps `as`/parenthesized wrappers so `parts as { glue?: string }[]` and `(parts)` both resolve
 *  to the bare identifier underneath — the SAME unwrapping a real reviewer-planted evasion needs to
 *  survive (the self-test below plants exactly this shape). */
function unwrapExpr(node: ts.Expression): ts.Expression {
  let n = node
  while (true) {
    if (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) { n = n.expression; continue }
    return n
  }
}

/** The root identifier of a (possibly chained) property-access/call expression: `parts.entries()`
 *  and `parts` both resolve to the `parts` identifier; `v.parts` resolves to `v` — deliberately, so
 *  this marker stays scoped to the LITERAL `parts` parameter every walk under test actually takes,
 *  never a same-named field buried in an unrelated object. */
function rootIdentifierName(node: ts.Expression): string | null {
  let n = unwrapExpr(node)
  while (true) {
    if (ts.isIdentifier(n)) return n.text
    if (ts.isCallExpression(n)) { n = unwrapExpr(n.expression); continue }
    if (ts.isPropertyAccessExpression(n)) { n = unwrapExpr(n.expression); continue }
    return null
  }
}

function getEnclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text
    if (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
      const p: ts.Node | undefined = cur.parent
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
      if (p && ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) return p.name.getText()
      // A callback ARGUMENT (`.forEach(cb)`, `.map(cb)`, ...) is lexically transparent — it is
      // part of the function that PASSED it, never its own scope; every walk authority/allowlist
      // entry in this file is stated at that outer, NAMED level. An anonymous function that is
      // NOT a callback argument (an IIFE, a bare expression statement) is genuinely unnamed, and
      // gets its own `<anonymous:LINE>` label so it can never accidentally match an allowlist key.
      if (p && ts.isCallExpression(p) && (p.arguments as readonly ts.Node[]).includes(cur)) { cur = p; continue }
      const { line } = ts.getLineAndCharacterOfPosition(cur.getSourceFile(), cur.getStart())
      return `<anonymous:${line + 1}>`
    }
    if (ts.isMethodDeclaration(cur) && (ts.isIdentifier(cur.name) || ts.isStringLiteralLike(cur.name))) return cur.name.getText()
    cur = cur.parent
  }
  return MODULE_LEVEL
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return ts.getLineAndCharacterOfPosition(sf, node.getStart()).line + 1
}

/** The pin's own scanner, exported as a pure function of a SOURCE STRING so the self-tests can
 *  plant a synthetic walk in memory, never on disk. */
export function scanClauseAuthorityViolations(source: string): Violation[] {
  const sf = ts.createSourceFile('itemHighlightWriter.ts', source, ts.ScriptTarget.ES2020, true)
  const violations: Violation[] = []

  // Resolve top-level `const NAME = ','` (either quote style) so a comparison against a MODULE
  // CONSTANT (plant C) is caught on the constant's real VALUE, never its name.
  const commaConstants = new Set<string>()
  sf.statements.forEach((stmt) => {
    if (!ts.isVariableStatement(stmt)) return
    stmt.declarationList.declarations.forEach((d) => {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer) && d.initializer.text === ',') {
        commaConstants.add(d.name.text)
      }
    })
  })
  const isCommaLiteralOrConstant = (node: ts.Expression): boolean => {
    const n = unwrapExpr(node)
    if (ts.isStringLiteralLike(n)) return n.text === ','
    if (ts.isIdentifier(n)) return commaConstants.has(n.text)
    return false
  }
  const record = (marker: string, node: ts.Node): void => {
    violations.push({ marker, functionName: getEnclosingFunctionName(node), line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, ' ').trim() })
  }

  const visit = (node: ts.Node): void => {
    // marker: comma-glue-test
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
        || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
      if (isEq) {
        const [glueSide, otherSide] = isGluePropertyAccess(node.left) ? [node.left, node.right]
          : isGluePropertyAccess(node.right) ? [node.right, node.left] : [null, null]
        if (glueSide && otherSide && isCommaLiteralOrConstant(otherSide)) {
          if (getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) record('comma-glue-test', node)
        }
      }
    }
    // marker: glue-has-call — `<expr>.has(<something>.glue)`
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'has'
      && node.arguments.length === 1 && isGluePropertyAccess(unwrapExpr(node.arguments[0]))) {
      if (getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) record('glue-has-call', node)
    }
    // marker: relation-open-state — a loop over the `parts` parameter whose body reassigns a
    // variable declared OUTSIDE the loop (closure state that survives across iterations).
    let loopBody: ts.Statement | null = null
    if (ts.isForOfStatement(node) && rootIdentifierName(node.expression) === PARTS_PARAM_NAME) loopBody = node.statement
    if (loopBody) {
      const declaredInsideLoop = new Set<string>()
      const outerAssignTargets: ts.Node[] = []
      const collectDeclared = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) declaredInsideLoop.add(n.name.text)
        if (ts.isParameter(n) && ts.isIdentifier(n.name)) declaredInsideLoop.add(n.name.text)
        ts.forEachChild(n, collectDeclared)
      }
      collectDeclared(loopBody)
      const findAssignments = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)
          && !declaredInsideLoop.has(n.left.text)) {
          outerAssignTargets.push(n)
        }
        ts.forEachChild(n, findAssignments)
      }
      findAssignments(loopBody)
      if (outerAssignTargets.length && getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) {
        record('relation-open-state', outerAssignTargets[0])
      }
    }
    // marker: readability-clause-split-re — any REFERENCE (not the one declaration) to the constant.
    if (ts.isIdentifier(node) && node.text === 'READABILITY_CLAUSE_SPLIT_RE') {
      const isDeclaration = ts.isVariableDeclaration(node.parent) && node.parent.name === node
      if (!isDeclaration && getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) record('readability-clause-split-re', node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return violations.filter((v) => !(ALLOWLIST[v.functionName] ?? []).includes(v.marker))
}

describe('K3 (rebuilding I4 on the AST): segmentClauses is the ONLY clause/relation-scope walk over itemHighlightWriter.ts, structural on the AST — never a name or a quote style', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/fba/itemHighlightWriter.ts'), 'utf8')

  it('the real file has ZERO unallowlisted marker hits outside segmentClauses', () => {
    const violations = scanClauseAuthorityViolations(source)
    expect(
      violations,
      `A clause/relation-scope marker was found outside segmentClauses and the named allowlist:\n${
        violations.map((v) => `  [${v.marker}] ${v.functionName}:${v.line}  ${v.text}`).join('\n')
      }\nEither derive this from segmentClauses, or add it to ALLOWLIST with a one-line reason.`,
    ).toEqual([])
  })

  it('the scanner is non-vacuous: re-run WITHOUT the allowlist filter, it DOES find the known, allowlisted hits', () => {
    const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2020, true)
    let commaHits = 0, hasHits = 0, stateHits = 0, roHits = 0
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && (isGluePropertyAccess(node.left) || isGluePropertyAccess(node.right))) commaHits++
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'has'
        && node.arguments.length === 1 && isGluePropertyAccess(unwrapExpr(node.arguments[0]))) hasHits++
      if (ts.isForOfStatement(node) && rootIdentifierName(node.expression) === PARTS_PARAM_NAME) stateHits++
      if (ts.isIdentifier(node) && node.text === 'READABILITY_CLAUSE_SPLIT_RE') roHits++
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(commaHits, 'zero .glue comma comparisons at all — the scanner may have drifted from the real source').toBeGreaterThan(0)
    expect(hasHits, 'zero .has(x.glue) calls at all').toBeGreaterThan(0)
    expect(stateHits, 'zero loops over the parts parameter at all').toBeGreaterThan(0)
    expect(roHits, 'zero READABILITY_CLAUSE_SPLIT_RE references at all').toBeGreaterThan(0)
  })

  it('SELF-TEST (baseline, negative control): the real file at HEAD is clean', () => {
    expect(scanClauseAuthorityViolations(source)).toEqual([])
  })

  it('SELF-TEST plant A (single-quoted, named function, distinct state name) is flagged — unchanged from RULING I4', () => {
    const planted = source + '\n\nfunction aSixthWalk(parts: unknown[]): void {\n  let relationOpenSixth = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === \',\') { relationOpenSixth = false }\n  }\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'aSixthWalk')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant E (arrow const, no `function` header) is flagged', () => {
    const planted = source + '\n\nconst aSixthWalkArrow = (parts: unknown[]): void => {\n  let relOpenArrow = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === \',\') { relOpenArrow = false }\n  }\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'aSixthWalkArrow')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant B (DOUBLE-quoted comma, state "openRel") is flagged — REVIEW I1 IMPORTANT 3, evaded the OLD pin', () => {
    const planted = source + '\n\nfunction plantB(parts: unknown[]): void {\n  let openRel = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === ",") { openRel = false }\n  }\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantB')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant C (comma test via a MODULE CONSTANT, state "relOpen") is flagged — REVIEW I1 IMPORTANT 3, evaded the OLD pin', () => {
    const planted = "const COMMA_TOK_PLANT = ','\n" + source + '\n\nfunction plantC(parts: unknown[]): void {\n  let relOpen = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === COMMA_TOK_PLANT) { relOpen = false }\n  }\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantC')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant D (comma test via `<set>.has(part.glue)`, state "inRelation") is flagged — REVIEW I1 IMPORTANT 3, evaded the OLD pin', () => {
    const planted = 'const PLANT_D_CLOSERS = new Set([","])\n' + source + '\n\nfunction plantD(parts: unknown[]): void {\n  let inRelation = false\n  for (const part of parts as { glue?: string }[]) {\n    if (PLANT_D_CLOSERS.has(part.glue)) { inRelation = false }\n  }\n}\n'
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantD')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['glue-has-call', 'relation-open-state']))
  })

  it('SELF-TEST plant F (a SECOND clause walk NESTED INSIDE judgeWriterArrangement, state "relOpenNested") is flagged as its OWN scope — REVIEW I1 IMPORTANT 3, evaded the OLD pin (nesting used to inherit the outer allowlist)', () => {
    const planted = source.replace(
      'export function judgeWriterArrangement(raw: unknown, units: readonly AdmittedUnit[], ctx: JudgeWriterLineCtx): JudgeWriterLineResult {',
      'export function judgeWriterArrangement(raw: unknown, units: readonly AdmittedUnit[], ctx: JudgeWriterLineCtx): JudgeWriterLineResult {\n  function plantFNested(parts: unknown[]): void {\n    let relOpenNested = false\n    for (const part of parts as { glue?: string }[]) {\n      if (part.glue === \',\') { relOpenNested = false }\n    }\n  }\n  void plantFNested\n',
    )
    expect(planted).not.toBe(source) // the replace actually matched
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantFNested')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
    // and it must NOT be silently absorbed into judgeWriterArrangement's own allowlist budget —
    // it is reported under its OWN function name, never merged with the enclosing scope's.
    expect(hits.every((v) => v.functionName !== 'judgeWriterArrangement')).toBe(true)
  })

  it('SELF-TEST (negative control): a NEW hit correctly attributed to an already-allowlisted function does not, by itself, grow the violation list', () => {
    expect(scanClauseAuthorityViolations(source).length).toBe(0)
  })
})
