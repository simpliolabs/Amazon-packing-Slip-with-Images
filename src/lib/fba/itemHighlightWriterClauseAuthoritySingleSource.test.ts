/**
 * itemHighlightWriterClauseAuthoritySingleSource.test.ts — RULING I4 (round I) landed a REGEX/
 * line-range pin; RULING K3 (round K1, phase-k1-rulings.md, Important — "rebuild it on the
 * TypeScript AST") REPLACED its mechanism; RULING L3 (round L1, phase-l1-rulings.md, Important)
 * WIDENS it again — review K1-truth's IMPORTANT 1 demonstrated FOUR fresh full evasions against
 * K3's own rebuild, via the pin's own exported `scanClauseAuthorityViolations`.
 *
 * WHY THE REGEX VERSION FAILED (RULING K3's own history, unchanged): B (double-quoted comma),
 * C (a module constant), D (a `.has()` call + an unnamed state variable), F (a second walk nested
 * INSIDE an allowlisted function, inheriting its exemption via brace-counted ranges).
 *
 * WHY K3's AST REBUILD STILL FAILED (RULING L3). Two structural gaps, closed here:
 *   - `relation-open-state` fired only for `ts.isForOfStatement(node)` over the LITERAL `parts`
 *     identifier. `segmentClauses` itself (the authority) walks with `parts.forEach(...)`
 *     (:1075) — a plant using the SAME idiom (`.forEach`/`.map`/`.some`/`.every`/`.find`/
 *     `.reduce`/`.filter` over a receiver ending in a `.parts` property access, however deeply
 *     wrapped in `as`/parens/non-null) was INVISIBLE to the state marker (plants G, H, K, L, all
 *     `.forEach`; H is an indexed `for` loop, also unseen). Widened to recognise every one of
 *     these loop shapes the same way, over a receiver that RESOLVES (through `as`/parens/non-null
 *     unwrapping) to the identifier `parts` OR to `<anything>.parts` (`v.parts`, `raw.parts` — the
 *     review's own note: "`v.parts` is doubly invisible: `rootIdentifierName` resolves it to `v`,
 *     deliberately" — this marker no longer needs the ROOT to be `parts`, only the LAST property in
 *     the chain).
 *   - `comma-glue-test`/`glue-has-call` required a `.glue` `PropertyAccessExpression` literally.
 *     `const { glue } = part` (plant G, an Identifier bound by destructuring) and
 *     `parts[i]['glue']`/`parts[i]["glue"]` (plant H, an `ElementAccessExpression`) are neither.
 *     Widened: any top-level `{ glue }` / `{ glue: name }` object-destructuring binding anywhere in
 *     the module registers its bound name as a glue-reference for the REST of the scan (a real
 *     binding resolution, not a name pattern — the bound name can be anything when renamed, e.g.
 *     `{ glue: g }`, and is still tracked by what it was BOUND FROM, never by what it is called);
 *     an `ElementAccessExpression` whose (unwrapped) argument is the string literal `'glue'` in
 *     either quote style counts the same as a `.glue` access. A `switch (glueLikeExpr) { case ',' }`
 *     (plant I) and a comma constant declared `as const` (plant J) are ALSO now matched structurally
 *     (a `CaseClause` compared against `isCommaLiteralOrConstant`, and an `AsExpression`-wrapped
 *     initializer unwrapped before the literal-value check) — the K1-truth review found these two
 *     already caught (via the widened state marker's side effect, since both plants loop with
 *     `for…of parts`), but a marker set should still recognise the shape it is named for directly.
 *
 * PLANTS K AND L — the ones that matter most — are a SECOND clause walk written as `parts.forEach`
 * INSIDE an ALREADY-allowlisted function (`validateGrammar`/`judgeWriterArrangement`), reusing that
 * function's own EXISTING marker budget (RULING K3's function-attribution correctly names the
 * callback's outer function via its "callback argument is lexically transparent" rule — that part
 * was never the bug; the bug is that the ALLOWLIST exempted every occurrence of a marker inside a
 * name, not the SPECIFIC occurrences already vetted there). Per RULING L3's own second option
 * ("allowlist per (function, marker, shape) rather than per function"): `ALLOWLIST` now maps
 * function -> marker -> the EXACT set of already-vetted occurrence texts (captured once, from the
 * real file, by `dump-current-allowed.ts` under `.../scratchpad/writer/l1/` — never invented). A
 * NEW occurrence of an already-allowlisted (function, marker) pair, whose text does not match one
 * of those known-good strings, is now a violation. This has one honestly-documented limit: an
 * adversary who copies an EXISTING vetted line's variable names verbatim (plant K's injected
 * `part.glue === ','` happens to be byte-identical to `validateGrammar`'s own real occurrence,
 * because both use the loop variable name `part`) evades THAT one marker's shape check — but plant
 * K's `relation-open-state` occurrence (`secondRelationOpen = false`) uses ITS OWN state-variable
 * name, which is NOT in `validateGrammar`'s known-good `relation-open-state` text set, so it is
 * caught by that marker regardless. Every self-test below pins the ACTUAL marker set each plant
 * trips, not an idealized one, so this limit is visible rather than assumed away.
 *
 * THE INVERSE (RULING L3: "because a marker set will always have a next evasion, ALSO assert the
 * inverse"). `describe`'s last `it` re-runs every marker pass with NO shape filter at all — only
 * "not the authority function" — and collects the SET of distinct function names that produced ANY
 * hit, of ANY marker. That set must equal the CLOSED list of functions this file already knows touch
 * a clause boundary (`KNOWN_CLAUSE_TOUCHING_FUNCTIONS`). A walk in a genuinely NEW function fails
 * this even if none of the FOUR markers above happens to fit its exact idiom — the enumeration does
 * not depend on which marker fired, only on whether the function's NAME was already on the list.
 *
 * Function attribution (unchanged from K3): the real AST parent chain to the nearest enclosing
 * function-like node — never a brace-counted range — with a callback ARGUMENT treated as lexically
 * transparent (attributed to the function that PASSED it), exactly as `segmentClauses`'s own
 * `parts.forEach` at :1075 needs to keep resolving to `segmentClauses`, and `judgeWriterArrangement`'s
 * own `v.parts.forEach` at :1378 needs to keep resolving to `judgeWriterArrangement`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const AUTHORITY_FUNCTION = 'segmentClauses'
const MODULE_LEVEL = '<module-level>'
const PARTS_PARAM_NAME = 'parts'
const PARTS_ITERATION_METHODS: ReadonlySet<string> = new Set(['forEach', 'map', 'some', 'every', 'find', 'reduce', 'filter', 'entries'])

interface Violation { marker: string; functionName: string; line: number; text: string }

// RULING L3: per (function, marker) -> the EXACT set of already-vetted occurrence texts, captured
// from the real file (`dump-current-allowed.ts`, `.../scratchpad/writer/l1/`) — never invented, and
// never widened just to make a NEW occurrence pass; a genuinely new line at an allowlisted
// (function, marker) pair must be added here BY HAND, the same speed bump a brand-new function name
// already gets for free.
const ALLOWLIST: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  validateGrammar: {
    'comma-glue-test': new Set([
      "run[0].glue === ','",
      "part.glue === ','",
      "(prev as ArrangementGluePart).glue === ','",
      "(next as ArrangementGluePart).glue === ','",
    ]),
    'relation-open-state': new Set(['relationOpenGlue = null']),
    'glue-has-call': new Set(['RELATION_GLUE.has(part.glue)']),
  },
  judgeWriterArrangement: {
    'comma-glue-test': new Set(["p.glue === ','"]),
    'glue-has-call': new Set(['RELATION_GLUE.has(next.glue)']),
  },
  glueRole: {
    'glue-has-call': new Set(['LIST_GLUE.has(part.glue)', 'RELATION_GLUE.has(part.glue)']),
  },
  writerReadabilityVerdict: {
    'readability-clause-split-re': new Set(['READABILITY_CLAUSE_SPLIT_RE']),
  },
  writerReadabilityFidelitySentence: {
    'readability-clause-split-re': new Set(['READABILITY_CLAUSE_SPLIT_RE']),
  },
}
// RULING L3, the INVERSE assertion's own closed list — every function this file has ever vetted as
// touching a clause boundary, by name, independent of which marker fires.
const KNOWN_CLAUSE_TOUCHING_FUNCTIONS: ReadonlySet<string> = new Set([
  AUTHORITY_FUNCTION, ...Object.keys(ALLOWLIST),
])

function isGluePropertyAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'glue'
}
/** RULING L3 (plants G/H): a `glue`-like read is no longer only a `.glue` PROPERTY ACCESS. Also
 *  matches an `ElementAccessExpression` keyed by the string literal `'glue'`/`"glue"` (plant H:
 *  `parts[i]['glue']`), and a bare Identifier that this SAME scan already resolved (via
 *  `collectDestructuredGlueNames`, below) to a `{ glue }`/`{ glue: name }` destructuring binding
 *  (plant G: `const { glue } = part`). */
function isGlueLikeAccess(node: ts.Node, destructuredGlueNames: ReadonlySet<string>): boolean {
  if (isGluePropertyAccess(node)) return true
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrapExpr(node.argumentExpression)
    if (ts.isStringLiteralLike(arg) && arg.text === 'glue') return true
  }
  if (ts.isIdentifier(node) && destructuredGlueNames.has(node.text)) return true
  return false
}
/** Every `{ glue }` (shorthand) or `{ glue: name }` (renamed) object-destructuring binding anywhere
 *  in the module, keyed by the BOUND identifier name (never by the property name, which is always
 *  `glue` by construction — this is what makes it a real binding resolution rather than a second
 *  name pattern). Deliberately module-wide and not scope-checked: a false positive here only ever
 *  ADDS a candidate glue-reference (conservative in the safe direction for a security-style pin);
 *  it can never hide one. */
function collectDestructuredGlueNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const propName = node.propertyName
        ? (ts.isIdentifier(propName_(node)) || ts.isStringLiteralLike(propName_(node)) ? propName_(node).getText().replace(/^['"]|['"]$/g, '') : null)
        : node.name.text
      if (propName === 'glue') names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  function propName_(n: ts.BindingElement): ts.PropertyName { return n.propertyName! }
  visit(sf)
  return names
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
/** RULING L3 (plants K/L): is `node` the bare identifier `parts`, OR does it END in a `.parts`
 *  property access (`v.parts`, `(raw as { parts }).parts`) — the SAME "doubly invisible" shape the
 *  K1-truth review named. Deliberately the OPPOSITE scoping choice from `rootIdentifierName`
 *  (which looks at the ROOT): a loop authority is just as real when `parts` is reached through a
 *  wrapper object as when it is the bare parameter, so THIS check looks at the LAST link in the
 *  chain, not the first. */
function endsWithPartsProperty(node: ts.Expression): boolean {
  const n = unwrapExpr(node)
  if (ts.isIdentifier(n)) return n.text === PARTS_PARAM_NAME
  if (ts.isPropertyAccessExpression(n)) return n.name.text === PARTS_PARAM_NAME
  return false
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

/** The pin's own RAW scanner — every marker hit outside `segmentClauses`, with NO shape or
 *  function-name filter applied at all. Exported so the INVERSE test (below) can enumerate the
 *  set of function NAMES independently of whether any particular occurrence's TEXT is already
 *  vetted. `scanClauseAuthorityViolations` (the pin proper) is the shape-filtered view of this
 *  same list. */
export function scanClauseAuthorityRawHits(source: string): Violation[] {
  const sf = ts.createSourceFile('itemHighlightWriter.ts', source, ts.ScriptTarget.ES2020, true)
  const violations: Violation[] = []

  // Resolve top-level `const NAME = ','` (either quote style, and RULING L3 plant J: `as const`
  // unwrapped before the literal check) so a comparison against a MODULE CONSTANT (plant C, J) is
  // caught on the constant's real VALUE, never its name or its own declaration's modifiers.
  const commaConstants = new Set<string>()
  sf.statements.forEach((stmt) => {
    if (!ts.isVariableStatement(stmt)) return
    stmt.declarationList.declarations.forEach((d) => {
      if (!ts.isIdentifier(d.name) || !d.initializer) return
      let init: ts.Expression = d.initializer
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isStringLiteralLike(init) && init.text === ',') commaConstants.add(d.name.text)
    })
  })
  const isCommaLiteralOrConstant = (node: ts.Expression): boolean => {
    const n = unwrapExpr(node)
    if (ts.isStringLiteralLike(n)) return n.text === ','
    if (ts.isIdentifier(n)) return commaConstants.has(n.text)
    return false
  }
  const destructuredGlueNames = collectDestructuredGlueNames(sf)
  const isGlueLike = (node: ts.Node): boolean => isGlueLikeAccess(node, destructuredGlueNames)
  const record = (marker: string, node: ts.Node): void => {
    violations.push({ marker, functionName: getEnclosingFunctionName(node), line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, ' ').trim() })
  }

  const visit = (node: ts.Node): void => {
    // marker: comma-glue-test — a binary comparison, OR (RULING L3 plant I) a `switch` whose
    // discriminant is glue-like and which has at least one `case` matching the comma literal.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
        || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken
      if (isEq) {
        const [glueSide, otherSide] = isGlueLike(node.left) ? [node.left, node.right]
          : isGlueLike(node.right) ? [node.right, node.left] : [null, null]
        if (glueSide && otherSide && isCommaLiteralOrConstant(otherSide)) {
          if (getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) record('comma-glue-test', node)
        }
      }
    }
    if (ts.isSwitchStatement(node) && isGlueLike(unwrapExpr(node.expression))) {
      const hasCommaCase = node.caseBlock.clauses.some((c) => ts.isCaseClause(c) && isCommaLiteralOrConstant(c.expression))
      if (hasCommaCase && getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) record('comma-glue-test', node.expression)
    }
    // marker: glue-has-call — `<expr>.has(<something-glue-like>)`.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'has'
      && node.arguments.length === 1 && isGlueLike(unwrapExpr(node.arguments[0]))) {
      if (getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) record('glue-has-call', node)
    }
    // marker: relation-open-state — ANY loop over a receiver ending in `.parts` (RULING L3: a bare
    // `parts` identifier, `v.parts`, or `(x as {parts}).parts` — never only the literal ROOT
    // parameter) that (a) reads something glue-like SOMEWHERE in its body (never only `parts`
    // itself or `parts.length` — a loop that never inspects `.glue` at all is not a clause-boundary
    // walk by definition; this is what keeps `renderArrangement`'s unrelated "peek the next unit
    // for the a/an article" loop, which walks `parts.length` but never reads `.glue`, OFF this
    // marker) and (b) reassigns a variable declared OUTSIDE that loop (closure state that survives
    // across iterations) — a `for…of`/indexed `for`, or an array-iteration CALLBACK
    // (`.forEach`/`.map`/`.some`/`.every`/`.find`/`.reduce`/`.filter`/`.entries`), regardless of
    // what that state variable is NAMED.
    let loopBody: ts.Node | null = null
    if (ts.isForOfStatement(node) && endsWithPartsProperty(node.expression)) loopBody = node.statement
    if (ts.isForStatement(node) && node.condition) {
      const touchesPartsLength = (() => {
        let touched = false
        const scan = (n: ts.Node): void => {
          if (ts.isPropertyAccessExpression(n) && n.name.text === 'length' && endsWithPartsProperty(unwrapExpr(n.expression))) touched = true
          ts.forEachChild(n, scan)
        }
        scan(node.condition!)
        return touched
      })()
      if (touchesPartsLength) loopBody = node.statement
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && PARTS_ITERATION_METHODS.has(node.expression.name.text) && endsWithPartsProperty(unwrapExpr(node.expression.expression))) {
      const cb = node.arguments[0]
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) loopBody = cb.body
    }
    if (loopBody) {
      const loopReadsGlue = (() => {
        let found = false
        const scan = (n: ts.Node): void => {
          if (isGlueLike(n)) found = true
          ts.forEachChild(n, scan)
        }
        scan(loopBody!)
        return found
      })()
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
      if (loopReadsGlue && outerAssignTargets.length && getEnclosingFunctionName(node) !== AUTHORITY_FUNCTION) {
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

  return violations
}

/** The pin proper — RULING L3's shape filter: a hit at an already-allowlisted (function, marker)
 *  pair is exempt ONLY when its exact (whitespace-squished) text matches one of that pair's known-
 *  vetted occurrences; any OTHER text at the same (function, marker) pair — never seen before,
 *  however it got there — is a violation, exactly like a hit in a brand-new function would be. */
export function scanClauseAuthorityViolations(source: string): Violation[] {
  return scanClauseAuthorityRawHits(source).filter((v) => !(ALLOWLIST[v.functionName]?.[v.marker]?.has(v.text) ?? false))
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

  // RULING L3 — review K1-truth's IMPORTANT 1, the four fresh evasions against K3's OWN scanner,
  // reproduced here verbatim (same literal shapes the review's `q5-pin-attack.vtest.ts` planted)
  // and asserted RED. G and H are brand-new function names (already caught in principle by K3's
  // per-function allowlist; the point here is that the WIDENED markers now actually FIRE for them,
  // not merely that the function name is unknown). K and L reuse an ALREADY-allowlisted function
  // name — the shape/text allowlist (RULING L3) is what closes them, not the function-name check.

  it('SELF-TEST plant G (forEach + destructured `const { glue } = part`) is flagged — REVIEW K1-truth IMPORTANT 1, evaded the K3 pin', () => {
    const planted = source + "\n\nfunction plantG(parts: unknown[]): void {\n  let boundaryOpen = false\n  ;(parts as { glue?: string }[]).forEach((part) => {\n    const { glue } = part\n    if (glue === ',') { boundaryOpen = false }\n  })\n  void boundaryOpen\n}\n"
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantG')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant H (indexed `for` + bracket access `parts[i][\'glue\']`) is flagged — REVIEW K1-truth IMPORTANT 1, evaded the K3 pin', () => {
    const planted = source + "\n\nfunction plantH(parts: { glue?: string }[]): void {\n  let openH = false\n  for (let i = 0; i < parts.length; i++) {\n    if (parts[i]['glue'] === ',') { openH = false }\n  }\n  void openH\n}\n"
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantH')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant I (`switch (part.glue) { case \',\' }`) is flagged directly by the widened comma-glue-test marker, not only as a side effect of the state marker', () => {
    const planted = source + "\n\nfunction plantI(parts: unknown[]): void {\n  let openI = false\n  for (const part of parts as { glue?: string }[]) {\n    switch (part.glue) { case ',': openI = false; break }\n  }\n  void openI\n}\n"
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantI')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant J (comma constant declared `as const`) is flagged directly by the widened comma-glue-test marker', () => {
    const planted = "const PLANT_J_COMMA = ',' as const\n" + source + "\n\nfunction plantJ(parts: unknown[]): void {\n  let openJ = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === PLANT_J_COMMA) { openJ = false }\n  }\n  void openJ\n}\n"
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'plantJ')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('SELF-TEST plant K (a SECOND clause walk as a `parts.forEach` callback INSIDE the ALLOWLISTED validateGrammar) is flagged — REVIEW K1-truth IMPORTANT 1\'s own worked example, "plant F reopened in the repo\'s own idiom"', () => {
    const anchor = 'function validateGrammar(parts: readonly ArrangementPart[], byId: ReadonlyMap<string, AdmittedUnit>): string | null {'
    const inject = anchor + "\n  let secondRelationOpen = false\n  parts.forEach((part) => {\n    if (!('unit' in part) && part.glue === ',') { secondRelationOpen = false }\n    if (!('unit' in part) && RELATION_GLUE.has(part.glue)) { secondRelationOpen = true }\n  })\n  void secondRelationOpen"
    const planted = source.replace(anchor, inject)
    expect(planted).not.toBe(source) // the replace actually matched
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'validateGrammar')
    // `comma-glue-test` does NOT independently fire here: the planted `part.glue === ','` is
    // byte-identical to validateGrammar's OWN real occurrence (both use the loop variable name
    // `part`) — the documented, honest limit of a TEXT-shape allowlist (see the header comment).
    // `relation-open-state` still fires because `secondRelationOpen` is a variable name the real
    // file never uses, so its exact text is not in the known-good set.
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['relation-open-state']))
  })

  it('SELF-TEST plant L (a SECOND clause walk as a `parts.forEach` callback INSIDE the ALLOWLISTED judgeWriterArrangement, receiver `(raw as {parts}).parts`) is flagged as its OWN new occurrence, not absorbed by the real forEach\'s exemption', () => {
    const anchor = 'export function judgeWriterArrangement(raw: unknown, units: readonly AdmittedUnit[], ctx: JudgeWriterLineCtx): JudgeWriterLineResult {'
    const inject = anchor + "\n  let jwaRelOpen = false\n  ;(raw as { parts: { glue?: string }[] }).parts.forEach((part) => {\n    if (part.glue === ',') { jwaRelOpen = false }\n  })\n  void jwaRelOpen"
    const planted = source.replace(anchor, inject)
    expect(planted).not.toBe(source) // the replace actually matched
    const violations = scanClauseAuthorityViolations(planted)
    const hits = violations.filter((v) => v.functionName === 'judgeWriterArrangement')
    expect(new Set(hits.map((v) => v.marker)), JSON.stringify(violations)).toEqual(new Set(['comma-glue-test', 'relation-open-state']))
  })

  it('RULING L3 — THE INVERSE: the set of functions with ANY clause-boundary marker hit (unfiltered by shape) equals the closed, named allowlist — a new walk in a new function fails this even when no single marker was written with its idiom in mind', () => {
    // Every `record()` call already excludes AUTHORITY_FUNCTION by construction (segmentClauses IS
    // the authority, never a violation of itself), so the raw-hit set never contains it either —
    // the closed comparison set here is every OTHER function this file has ever vetted.
    const expectedNames = new Set(Object.keys(ALLOWLIST))
    const rawFunctionNames = new Set(scanClauseAuthorityRawHits(source).map((v) => v.functionName))
    expect(rawFunctionNames).toEqual(expectedNames)
    // and every name in that closed set is also one `KNOWN_CLAUSE_TOUCHING_FUNCTIONS` (the
    // authority plus this same set) recognises — the two lists are never allowed to drift apart.
    for (const name of expectedNames) expect(KNOWN_CLAUSE_TOUCHING_FUNCTIONS.has(name)).toBe(true)
  })

  it('RULING L3 — THE INVERSE, attacked: a brand-new function with a clause-boundary-shaped walk grows the raw-hit function set beyond the known allowlist, regardless of which marker fires', () => {
    const planted = source + "\n\nfunction plantInverse(parts: unknown[]): void {\n  let s = false\n  for (const part of parts as { glue?: string }[]) {\n    if (part.glue === ',') { s = false }\n  }\n  void s\n}\n"
    const rawFunctionNames = new Set(scanClauseAuthorityRawHits(planted).map((v) => v.functionName))
    expect(rawFunctionNames.has('plantInverse')).toBe(true)
    expect(KNOWN_CLAUSE_TOUCHING_FUNCTIONS.has('plantInverse')).toBe(false)
  })
})
