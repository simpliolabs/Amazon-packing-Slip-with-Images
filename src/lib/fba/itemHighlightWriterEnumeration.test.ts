/**
 * itemHighlightWriterEnumeration.test.ts — SOURCE-SCAN ENUMERATION TEST (writer spec Part 2, B4:
 * "An enumeration test must FAIL if any production file calls the sync builders except through the
 * wrappers").
 *
 * WHY THIS EXISTS. `buildItemHighlights`/`buildItemHighlightsPerDesign` (listingPipeline.ts) stay
 * SYNC and byte-identical (B4) — the writer sits in front of them via the async
 * `produceItemHighlights`/`produceItemHighlightsPerDesign` wrappers. `tsc` cannot enforce "call the
 * wrapper, not the sync builder" — both are ordinary exported functions with compatible call
 * shapes, so a new call site that imports the sync builder directly compiles fine and silently
 * bypasses the writer (the exact path-divergence class `fba-generation-invariants` names). This is
 * the runtime backstop, in the spirit of this repo's own `itemHighlightNetUnionCollision.test.ts`:
 * it reads every non-test `.ts`/`.tsx` file under `src/`, finds every bare CALL (never a `function`
 * declaration) to either sync builder, and requires every one of them to sit inside
 * `listingPipeline.ts` at one of exactly three sanctioned call sites: the ONE legitimate internal
 * call inside `buildItemHighlightsPerDesign` itself (it composes each design through the
 * single-design sync builder — that is intentional reuse, not a bypass), and the ONE call each
 * inside `produceItemHighlights`/`produceItemHighlightsPerDesign` (the wrappers' own job is to call
 * the sync builder they wrap). Any bare call anywhere else — a new pipeline branch, a new route, a
 * revert of one of the two switched production call sites — fails this test.
 *
 * The scanner is exported so this file can prove its OWN sensitivity against synthetic snippets
 * (the same "proven to go RED" discipline `itemHighlightNetUnionCollision.test.ts` uses) without
 * mutating the real tree.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const SRC_ROOT = path.join(process.cwd(), 'src')
const LISTING_PIPELINE_REL = 'src/lib/fba/listingPipeline.ts'

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

function stripLineComments(s: string): string {
  return s.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

const BUILDER_NAMES = ['buildItemHighlights', 'buildItemHighlightsPerDesign'] as const
/** The three sanctioned wrapper/internal-reuse function bodies (listingPipeline.ts only) a bare
 *  sync-builder call may legally sit inside. */
const SANCTIONED_ENCLOSING_FNS = ['buildItemHighlightsPerDesign', 'produceItemHighlights', 'produceItemHighlightsPerDesign'] as const

/** Every `export (async )?function <name>(` declaration's start offset in `source`, by name — the
 *  LAST one wins if a name somehow appears twice (defensive; this codebase never does). */
function functionDeclOffsets(source: string): Map<string, number> {
  const out = new Map<string, number>()
  const RE = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = RE.exec(source))) out.set(m[1], m.index)
  return out
}

/** Every TOP-LEVEL `export function`/`export async function` declaration's start offset, sorted —
 *  used to find which declared function's body a given call-site offset falls inside (the next
 *  declaration after it, or end-of-file, bounds the enclosing function's body — good enough for this
 *  file's flat, non-nested top-level function shape; this scanner never needs to parse braces). */
function sortedDeclOffsets(source: string): number[] {
  const offsets: number[] = []
  const RE = /export\s+(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/g
  let m: RegExpExecArray | null
  while ((m = RE.exec(source))) offsets.push(m.index)
  return offsets.sort((a, b) => a - b)
}

/**
 * Scans one file's source for bare CALLS to `buildItemHighlights(`/`buildItemHighlightsPerDesign(`
 * (word-boundary matched, so the two names never collide — "buildItemHighlightsPerDesign(" never
 * matches the `buildItemHighlights\(` pattern because "PerDesign" sits between the name and the
 * paren). Excludes each name's OWN `export function` declaration. Returns one violation string per
 * call that is NOT inside `listingPipeline.ts` at one of the three sanctioned enclosing functions.
 */
export function findSyncBuilderBypassCalls(relPath: string, source: string): string[] {
  const stripped = stripLineComments(source)
  const violations: string[] = []
  const declOffsets = functionDeclOffsets(stripped)
  const allDeclOffsets = relPath === LISTING_PIPELINE_REL ? sortedDeclOffsets(stripped) : []
  for (const name of BUILDER_NAMES) {
    const CALL_RE = new RegExp(`\\b${name}\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = CALL_RE.exec(stripped))) {
      const idx = m.index
      // A declaration's own call-shaped text is `export function <name>(` — `idx` is the offset of
      // the NAME itself (the match starts at `<name>(`), so the text immediately preceding `idx`
      // (NOT including the name) ends in the bare `function` keyword for a declaration, and in
      // something else (an operator, an identifier, `await `, `=`, `(`, …) for a real call.
      const before = stripped.slice(Math.max(0, idx - 60), idx)
      if (/function\s*$/.test(before)) continue
      if (relPath !== LISTING_PIPELINE_REL) {
        violations.push(`${relPath}: bare ${name}(...) call outside listingPipeline.ts (must go through the produce* wrapper)`)
        continue
      }
      // Inside listingPipeline.ts: find the nearest preceding top-level function declaration and
      // require it to be one of the three sanctioned ones.
      let enclosingDeclStart = -1
      for (const off of allDeclOffsets) { if (off <= idx) enclosingDeclStart = off; else break }
      const enclosingName = [...declOffsets.entries()].find(([, off]) => off === enclosingDeclStart)?.[0] ?? null
      if (!enclosingName || !(SANCTIONED_ENCLOSING_FNS as readonly string[]).includes(enclosingName)) {
        violations.push(`${relPath}@${idx}: bare ${name}(...) call outside the three sanctioned functions (found inside ${enclosingName ?? 'unknown'})`)
      }
    }
  }
  return violations
}

// ─── FIX ROUND B2 (RULING W6): IMPORTS, not only call spellings ──────────────────────────────────
//
// I4 (phase-b-review.md) proved the CALL-scanner above catches only a BARE-NAME call. It stays green
// on an ALIASED import (`import { buildItemHighlights as composeIh } from '...'` then `composeIh(...)`)
// and on a LOWER-LAYER producer combined with the tail (`composeItemHighlightDetailed` +
// `runIhTail` in a brand-new route, never touching `buildItemHighlights` at all). This scanner reads
// IMPORT statements instead: any production file importing `buildItemHighlights`,
// `buildItemHighlightsPerDesign`, `composeItemHighlightDetailed`, `composeItemHighlight`, or
// `runIhTail` OUTSIDE that name's home module is a violation, regardless of the alias it imports it
// under or whether it is ever called by its original name again.

const RESTRICTED_IMPORT_NAMES = ['buildItemHighlights', 'buildItemHighlightsPerDesign', 'composeItemHighlightDetailed', 'composeItemHighlight', 'runIhTail'] as const
const ITEM_HIGHLIGHT_COMPOSER_REL = 'src/lib/fba/itemHighlightComposer.ts'
const HOME_FILE_OF: Readonly<Record<string, string>> = {
  buildItemHighlights: LISTING_PIPELINE_REL,
  buildItemHighlightsPerDesign: LISTING_PIPELINE_REL,
  runIhTail: LISTING_PIPELINE_REL,
  composeItemHighlightDetailed: ITEM_HIGHLIGHT_COMPOSER_REL,
  composeItemHighlight: ITEM_HIGHLIGHT_COMPOSER_REL,
}

/**
 * Scans one file's source for `import { ... } from '...'` statements and flags any specifier whose
 * ORIGINAL (pre-`as`) name is one of `RESTRICTED_IMPORT_NAMES`, unless `relPath` IS that name's home
 * module. A `type`-only specifier (`type Foo`, or a whole `import type { ... }`) is SKIPPED — it
 * carries no runtime binding and cannot be called, so it is not a bypass risk (the real tree's
 * regen route imports `type buildItemHighlightsPerDesign` purely for a parameter's shape).
 */
export function findSyncBuilderBypassImports(relPath: string, source: string): string[] {
  const stripped = stripLineComments(source)
  const violations: string[] = []
  const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(stripped))) {
    if (m[1]) continue // `import type { ... }` — the whole statement is type-only
    for (const rawSpec of m[2].split(',')) {
      const spec = rawSpec.trim()
      if (!spec || /^type\s/.test(spec)) continue // `{ type Foo }` — no runtime binding
      const original = spec.split(/\s+as\s+/)[0].trim()
      if (!(RESTRICTED_IMPORT_NAMES as readonly string[]).includes(original)) continue
      const home = HOME_FILE_OF[original]
      // listingPipeline.ts is the ONE sanctioned consumer of every one of these five names — it
      // declares three of them itself (buildItemHighlights/buildItemHighlightsPerDesign/runIhTail)
      // and is the composer's own sanctioned caller for the other two
      // (composeItemHighlightDetailed/composeItemHighlight, imported at its top so
      // `buildItemHighlights` can call it) — exempt in addition to the literal home file.
      if (relPath === home || relPath === LISTING_PIPELINE_REL) continue
      const alias = spec.includes(' as ') ? spec.split(/\s+as\s+/)[1].trim() : null
      violations.push(`${relPath}: imports '${original}'${alias ? ` (as ${alias})` : ''} — outside its home module (${home}); route through the produce* wrapper instead`)
    }
  }
  return violations
}

// ─── FIX ROUND B3 (RULING G7, closing review B2's I4 residual gap): NAMESPACE imports, RE-EXPORTS,
// and DYNAMIC imports of a restricted name ──────────────────────────────────────────────────────
//
// Review B2 §7 measured the import-scanner above (W6) still goes GREEN on two shapes that reach a
// restricted name without ever writing its bare identifier as an `import { ... }` specifier:
//   lower-namespace: `import * as pipeline from '.../listingPipeline'` then `pipeline.runIhTail(...)`
//     — the restricted name is a PROPERTY access, never an import specifier.
//   barrel:          `export { buildItemHighlights as buildIh } from '.../listingPipeline'` in a
//     helper file, then a THIRD file `import { buildIh } from './helper'` — the restricted name is
//     written once, at the RE-EXPORT site, and every downstream import spells only the alias.
// Tightening the W6 scanner rule-by-rule for each new shape is the treadmill this round's own spec
// amendment (§2c) exists to end for the GRAMMAR; the same discipline applies here — read the
// STRUCTURE (a namespace import's alias + property access; an `export ... from` clause's own
// specifier list) instead of chasing spellings.

/** True/module-tag when `spec` (an import/export specifier string) targets one of the two
 *  restricted-name HOME modules, by path substring — deliberately loose (matches any relative
 *  depth: `./listingPipeline`, `../../lib/fba/listingPipeline`, `@/lib/fba/listingPipeline`) because
 *  the violation is in what the specifier NAMES, not in how many `../` segments reach it. */
function specifierTargetsRestrictedHome(spec: string): 'pipeline' | 'composer' | null {
  if (/listingPipeline/.test(spec)) return 'pipeline'
  if (/itemHighlightComposer/.test(spec)) return 'composer'
  return null
}

/**
 * Scans for `import * as <alias> from '<spec>'` where `<spec>` targets a restricted home module,
 * followed anywhere in the SAME file by a property-access CALL `<alias>.<restrictedName>(`. Exempt
 * exactly like `findSyncBuilderBypassImports`: the name's own home file, and `listingPipeline.ts`
 * (the sanctioned consumer of the composer's two names).
 */
export function findNamespaceBypassCalls(relPath: string, source: string): string[] {
  const stripped = stripLineComments(source)
  const violations: string[] = []
  const NS_RE = /import\s+\*\s+as\s+([A-Za-z0-9_]+)\s+from\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = NS_RE.exec(stripped))) {
    const alias = m[1]
    if (!specifierTargetsRestrictedHome(m[2])) continue
    for (const name of RESTRICTED_IMPORT_NAMES) {
      const home = HOME_FILE_OF[name]
      if (relPath === home || relPath === LISTING_PIPELINE_REL) continue
      if (new RegExp(`\\b${alias}\\.${name}\\(`).test(stripped)) {
        violations.push(`${relPath}: namespace-imports '${m[2]}' as ${alias} and calls .${name}(...) — outside its home module (${home}); route through the produce* wrapper instead`)
      }
    }
  }
  return violations
}

/**
 * Scans for `export * from '<spec>'` (leaks EVERY name, restricted ones included) and
 * `export { <name>[ as <alias>] } from '<spec>'` where `<name>` is restricted — the barrel shape
 * (I4): the restricted identifier is written once, here, even though every downstream file that
 * imports the alias never spells it again.
 */
export function findReExportBypass(relPath: string, source: string): string[] {
  const stripped = stripLineComments(source)
  const violations: string[] = []
  const STAR_RE = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = STAR_RE.exec(stripped))) {
    if (specifierTargetsRestrictedHome(m[1])) {
      violations.push(`${relPath}: 'export * from ${JSON.stringify(m[1])}' re-exports EVERY name, including its restricted ones`)
    }
  }
  const NAMED_RE = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  while ((m = NAMED_RE.exec(stripped))) {
    if (m[1]) continue // `export type { ... } from` — no runtime binding
    const [, , specs, spec] = m
    for (const rawSpec of specs.split(',')) {
      const s = rawSpec.trim()
      if (!s || /^type\s/.test(s)) continue
      const original = s.split(/\s+as\s+/)[0].trim()
      if (!(RESTRICTED_IMPORT_NAMES as readonly string[]).includes(original)) continue
      const home = HOME_FILE_OF[original]
      if (relPath === home || relPath === LISTING_PIPELINE_REL) continue
      const alias = s.includes(' as ') ? s.split(/\s+as\s+/)[1].trim() : null
      violations.push(`${relPath}: re-exports '${original}'${alias ? ` (as ${alias})` : ''} from '${spec}' — outside its home module (${home})`)
    }
  }
  return violations
}

/**
 * Scans for a dynamic `import('<spec>')` that reaches a RESTRICTED name — either destructured
 * directly (`const { buildItemHighlights } = await import('...')`), bound to an identifier that is
 * later property-accessed (`const pipeline = await import('...'); pipeline.runIhTail(...)`), or
 * called inline (`(await import('...')).runIhTail(...)`). Deliberately NARROWER than "any dynamic
 * import of the module" — this codebase already dynamically imports `listingPipeline.ts` for an
 * UNRESTRICTED export (`APPAREL_PRODUCT_TYPES`, syncKeywordIntelligence.ts), which is not a bypass;
 * the violation is reaching a restricted NAME, exactly like the namespace/re-export scanners above,
 * not merely dynamically importing the module that happens to contain one. */
export function findDynamicImportBypass(relPath: string, source: string): string[] {
  const stripped = stripLineComments(source)
  const violations: string[] = []
  const isRestrictedHere = (spec: string): { home: string } | null => {
    const target = specifierTargetsRestrictedHome(spec)
    if (!target) return null
    const home = target === 'pipeline' ? LISTING_PIPELINE_REL : ITEM_HIGHLIGHT_COMPOSER_REL
    if (relPath === home || relPath === LISTING_PIPELINE_REL) return null
    return { home }
  }
  const DECL_RE = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z0-9_]+)\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = DECL_RE.exec(stripped))) {
    const [, binding, spec] = m
    const hit = isRestrictedHere(spec)
    if (!hit) continue
    if (binding.startsWith('{')) {
      for (const rawSpec of binding.slice(1, -1).split(',')) {
        const original = rawSpec.trim().split(':')[0].trim()
        if (original && (RESTRICTED_IMPORT_NAMES as readonly string[]).includes(original)) {
          violations.push(`${relPath}: dynamic import('${spec}') destructures restricted name '${original}' — outside its home module (${hit.home})`)
        }
      }
    } else {
      for (const name of RESTRICTED_IMPORT_NAMES) {
        if (new RegExp(`\\b${binding}\\.${name}\\(`).test(stripped)) {
          violations.push(`${relPath}: dynamic import('${spec}') as ${binding}, calling .${name}(...) — outside its home module (${hit.home})`)
        }
      }
    }
  }
  const INLINE_RE = /\(\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g
  while ((m = INLINE_RE.exec(stripped))) {
    const [, spec, name] = m
    if (!(RESTRICTED_IMPORT_NAMES as readonly string[]).includes(name)) continue
    const hit = isRestrictedHere(spec)
    if (!hit) continue
    violations.push(`${relPath}: dynamic import('${spec}') inline-calls .${name}(...) — outside its home module (${hit.home})`)
  }
  return violations
}

// RULING W4 (fix round B7b, wire required): "build the TypeScript Program ONCE and share it" — done
// (`makeSharedHost`'s parse/read caches, plus `oldProgram` reuse in `findEnumerationViolations`,
// eliminate the OLD `fs.cpSync` of ~398 files and its matching `fs.rmSync` on every one of ~40 shape
// tests, and nothing is ever written to disk any more). It does NOT bring any individual test under
// the repo's 5000ms default alone: measured directly (`ts.createProgram` with an EMPTY host, no
// caching or reuse at all, over this repo's ~257-398 root files) costs ~3.3s just to parse+bind,
// before any type lookup runs — TypeScript's own per-file binding cost at this codebase's size, not
// an inefficiency this round's caching failed to remove. `oldProgram`-based reuse (measured the same
// way, second `createProgram` call, IDENTICAL rootNames) shaved only ~0.5s off that — TypeScript's
// incremental-reuse heuristics do not appear to substantially reuse bind/check state across separate
// `Program` instances in this configuration even when nothing changed, let alone when a root file is
// added or a home file's text is overlaid, which every shape test here does. Per the ruling's own
// fallback ("if an explicit timeout remains necessary, justify it in the test and the report"): this
// file sets its OWN default via `vi.setConfig` instead of the repo's 5000ms, with headroom over the
// ~5-6.5s measured per shape test. `beforeAll` also warms the shared caches ONCE (vitest's default
// `hookTimeout` is 10_000ms) so the FIRST test does not additionally pay a cold-cache tax the rest of
// the file no longer has to.
const ENUMERATION_TEST_TIMEOUT_MS = 20_000
// Called at MODULE TOP LEVEL, synchronously, BEFORE any `describe`/`it` below registers — `vi.setConfig`
// from inside a `beforeAll` callback runs too late to change the timeout `it()` already captured at
// registration time (measured: it had no effect on the failures below when it lived there).
vi.setConfig({ testTimeout: ENUMERATION_TEST_TIMEOUT_MS })
beforeAll(() => {
  findEnumerationViolations(realTreeInputs())
}, 20_000)

describe('Item Highlights writer (B4/G7): namespace imports, re-exports, and dynamic imports of a restricted name', () => {
  it('sensitivity (G7 shape 1, "lower-namespace") — a namespace import combined with a property-access call is flagged on BOTH', () => {
    const fakeFile = 'src/app/api/fba/some-namespace-route/route.ts'
    const fakeSource = `
      import * as composer from '@/lib/fba/itemHighlightComposer'
      import * as pipeline from '@/lib/fba/listingPipeline'
      export async function POST() {
        const res = composer.composeItemHighlightDetailed([], [], {} as never)
        return pipeline.runIhTail(res.line ?? '', {} as never)
      }
    `
    const violations = findNamespaceBypassCalls(fakeFile, fakeSource)
    expect(violations).toEqual([
      expect.stringContaining("calls .composeItemHighlightDetailed(...)"),
      expect.stringContaining("calls .runIhTail(...)"),
    ])
  })

  it('sensitivity (G7 shape 2, "barrel") — a re-export of a restricted name under an alias is flagged at the RE-EXPORT site', () => {
    const fakeFile = 'src/lib/fba/someHelperBarrel.ts'
    const fakeSource = `export { buildItemHighlights as buildIh } from '@/lib/fba/listingPipeline'`
    expect(findReExportBypass(fakeFile, fakeSource)).toEqual([
      expect.stringContaining("re-exports 'buildItemHighlights' (as buildIh)"),
    ])
  })

  it('sensitivity — "export * from" the pipeline module is flagged outright', () => {
    const fakeFile = 'src/lib/fba/someHelperBarrel.ts'
    expect(findReExportBypass(fakeFile, `export * from '@/lib/fba/listingPipeline'`)).toEqual([
      expect.stringContaining("re-exports EVERY name"),
    ])
  })

  it('sensitivity — a dynamic import of the composer module is flagged', () => {
    const fakeFile = 'src/app/api/fba/some-dynamic-route/route.ts'
    const fakeSource = `
      export async function POST() {
        const composer = await import('@/lib/fba/itemHighlightComposer')
        return composer.composeItemHighlight([], {} as never)
      }
    `
    expect(findDynamicImportBypass(fakeFile, fakeSource)).toEqual([
      expect.stringContaining("dynamic import('@/lib/fba/itemHighlightComposer')"),
    ])
  })

  it('a `type`-only re-export of a restricted name carries no runtime binding and is NOT flagged', () => {
    const fakeSource = `export type { buildItemHighlightsPerDesign } from '@/lib/fba/listingPipeline'`
    expect(findReExportBypass('src/lib/fba/someTypesOnly.ts', fakeSource)).toEqual([])
  })

  it('the REAL tree: zero production file namespace-imports+calls, re-exports, or dynamic-imports a restricted name outside its home module', () => {
    const nsViolations: string[] = []
    const reExportViolations: string[] = []
    const dynViolations: string[] = []
    for (const abs of listTsFiles(SRC_ROOT)) {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/')
      const source = fs.readFileSync(abs, 'utf8')
      nsViolations.push(...findNamespaceBypassCalls(rel, source))
      reExportViolations.push(...findReExportBypass(rel, source))
      dynViolations.push(...findDynamicImportBypass(rel, source))
    }
    expect(nsViolations).toEqual([])
    expect(reExportViolations).toEqual([])
    expect(dynViolations).toEqual([])
  })
})

// RULING V1 (fix round B8b, controller review B7/wire B1): "W1 is still a spelling scan." The three
// rules that used to live here (`findNamespaceImportOfHome`, `findHomeModuleNamespaceReExport`,
// `findDynamicImportSyntaxViolations`) were regular expressions over source text, and the B7/wire
// review's z0-z15 probes proved the class, not just an individual follower, escapes them: an alias
// charset gap (`$lp`), missing whitespace, a comment INSIDE the declaration, a `//`-comment string
// truncating the rest of the line, a specifier-text home-check that never resolves a path alias or a
// package.json "imports" subpath, and a scan scope of `src/` only (a file outside `src/` was never
// even opened). Rules 1-3 are rebuilt below on the TypeScript AST and the COMPILER'S OWN module
// resolution (`ts.resolveModuleName`, via the shared host — the same one K8 already builds a
// `ts.Program` with) — never on source text — and folded directly into `findEnumerationViolations`
// (see the K8 section below), so the module boundary and the reference check share ONE program build
// and ONE walk instead of paying for a second `ts.createProgram`. K8's reference check is kept
// unchanged as the second line, per the ruling.

/** Rule 1 (namespace import) and rule 3b (a literal dynamic import/require OF a home module): files
 *  permitted to reach a restricted home module's WHOLE namespace today — production code only; every
 *  `*.test.*` file is excluded from the program's root set already, so no test file needs an entry
 *  here. Kept explicit and minimal (a reviewed diff adds a name), never a wildcard or a directory
 *  prefix. Verified empty today (see "the REAL tree" test below) — no production file
 *  namespace-imports either home module. */
const NAMESPACE_IMPORT_ALLOWLIST: readonly string[] = []
/** Rule 3b's home-module half: the ONE existing production dynamic import of a whole home module —
 *  `syncKeywordIntelligence.ts:249` reads `APPAREL_PRODUCT_TYPES` (an UNRESTRICTED export) off
 *  `listingPipeline.ts` via a literal `await import(...)`. `findDynamicImportBypass` (above) already
 *  proves it never reaches a RESTRICTED name; this rule is stricter still — it refuses ANY literal
 *  dynamic import/require of a home module outside an allowlist, regardless of what is destructured,
 *  because the import briefly materializes the WHOLE namespace object, and nothing but review stops a
 *  later edit from widening the destructure to a restricted name. This one legitimate use is named
 *  here, by file path, so any new one is a reviewed diff. */
const DYNAMIC_HOME_IMPORT_ALLOWLIST: readonly string[] = ['src/lib/sync/syncKeywordIntelligence.ts']
/** Rule 3a: a dynamic `import()`/`require()` whose specifier is not a string literal AT ALL (or not a
 *  direct literal call at all — see the `require`/`module.require`/`createRequire` VALUE-USE rule) is
 *  refused anywhere in the program, home module or not — its target cannot be statically verified.
 *  Empty today (verified below); kept as an explicit allowlist per the ruling's own wording, not
 *  because a legitimate use exists yet. */
const NON_LITERAL_DYNAMIC_IMPORT_ALLOWLIST: readonly string[] = []

describe('RULING V1 (fix round B8b, wire Blocking): the module boundary is refused via the compiler\'s AST and module resolution, never source text', () => {
  // Every shape below is asserted only via `findEnumerationViolations` (the SAME function K8 uses,
  // now doing both jobs in one program/one walk) through `scratchCopy` — never a standalone regex
  // function taking raw text, because the whole POINT of this round is that there is no such
  // function left to call directly: resolution requires a real `ts.Program`.

  // z0 (control) + the z1-z8/z12/z13 spelling-defeat shapes the OLD regex scanners were shown to
  // miss (z0's own the-REAL-tree run is proven RED against a scratch copy separately below, and
  // pasted into the report per the round's "reproduce first" instruction).
  const SPELLING_DEFEAT_SHAPES: Record<string, string> = {
    'z0-control': `import * as lp from '@/lib/fba/listingPipeline'\nlet m: any\nexport async function POST() { m = lp; return m['buildItemHighlights']({} as never) }`,
    'z1-dollar-alias': `import * as $lp from '@/lib/fba/listingPipeline'\nlet m: any\nexport async function POST() { m = $lp; return m['buildItemHighlights']({} as never) }`,
    'z2-nospace': `import*as lp from'@/lib/fba/listingPipeline'\nexport async function POST() { return (lp as never)['buildItemHighlights']({} as never) }`,
    'z3-comment-inside-decl': `import * /* ns */ as lp from '@/lib/fba/listingPipeline'\nexport async function POST() { return (lp as never)['buildItemHighlights']({} as never) }`,
    'z4-url-same-line': `const U = 'https://example.com/x' // a same-line comment used to truncate a REGEX scanner, irrelevant to a real parser\nimport * as lp from '@/lib/fba/listingPipeline'\nexport async function POST() { return (lp as never)['buildItemHighlights']({} as never) }`,
    'z6b-tsignore-plus-default': `// @ts-ignore\nimport def, * as lp from '@/lib/fba/listingPipeline'\nexport default function GET() { return (lp as never)['buildItemHighlights']({} as never) }`,
    'z7-starcomment-barrel': `export * /* everything */ from '@/lib/fba/listingPipeline'\n`,
    'z8-dollar-namespaceexport': `export * as $lpBarrel from '@/lib/fba/listingPipeline'\n`,
    'z12-require-as-value': `export function POST() { const r = require; return r('@/lib/fba/listingPipeline') }`,
    'z13-template-specifier': 'export async function POST() { return import(`@/lib/fba/listingPipeline`) }',
    'z15-string-namespaceexport': `export * as "lp string name" from '@/lib/fba/listingPipeline'\n`,
  }
  for (const [name, content] of Object.entries(SPELLING_DEFEAT_SHAPES)) {
    it(`sensitivity ("${name}") — flagged by AST/resolution regardless of the spelling trick the OLD regex missed`, () => {
      const isBarrel = name.startsWith('z7') || name.startsWith('z8') || name.startsWith('z15')
      const relPath = isBarrel ? `lib/fba/v1Barrel-${name}.ts` : `app/api/fba/probe-v1-${name}/route.ts`
      const { inputs, cleanup } = scratchCopy({ extra: { relPath, content } })
      try {
        const { violations } = findEnumerationViolations(inputs)
        expect(violations.length, `"${name}" must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
      } finally { cleanup() }
    })
  }

  // z9/z9b: a home-module barrel living OUTSIDE `src/` entirely — the OLD scan scope
  // (`listTsFilesFlat(SRC_ROOT)`/`rootNames`) never opened it. `findEnumerationViolations` now walks
  // `program.getSourceFiles()` (every file the COMPILER resolved into the program, home-module or
  // not, inside `src/` or not), so a file the compiler reaches via an ordinary relative import from
  // an in-`src/` route is scanned even though nothing added it as a root by hand.
  it('sensitivity ("z9", outside src/) — a barrel doing `export * from home` OUTSIDE src/, reached ONLY by resolving an in-src route\'s relative import (never added as its own root), is flagged', () => {
    // `notRoot: true` on the barrel is the actual claim under test: this file is NEVER listed in
    // `rootNames` — the only way `findEnumerationViolations` ever sees it is by the compiler
    // resolving the route's own import and pulling it into `program.getSourceFiles()`. Mutation-
    // proved: reverting the scan to `rootNames`-only (which the route.ts root still lists) leaves
    // this file OUT of the scan and the shape escapes — see the round's report.
    const { inputs, cleanup } = scratchCopy({
      extra: [
        { relPath: '../ihx/v1OutsideBarrel.ts', content: `export * from '../src/lib/fba/listingPipeline'\n`, notRoot: true },
        { relPath: 'app/api/fba/probe-v1-z9/route.ts', content: `import * as outside from '../../../../../ihx/v1OutsideBarrel'\nexport async function POST() { return (outside as never)['buildItemHighlights']({} as never) }` },
      ],
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `"z9" must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
    } finally { cleanup() }
  })
  it('sensitivity ("z9b", outside src/, FULLY TYPED, no `any` and no cast, reached ONLY by resolution) — a named re-export of a restricted name from a file outside src/ is flagged at the re-export site', () => {
    const { inputs, cleanup } = scratchCopy({
      extra: [
        { relPath: '../ihx/v1OutsideAlias.ts', content: `export { buildItemHighlights as bih } from '../src/lib/fba/listingPipeline'\n`, notRoot: true },
        { relPath: 'app/api/fba/probe-v1-z9b/route.ts', content: `import { bih } from '../../../../../ihx/v1OutsideAlias'\nexport async function POST() { return bih({} as never) }` },
      ],
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('buildItemHighlights')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })

  // z10: a package.json "imports" subpath alias (`#ihp`) that resolves — via the COMPILER's own
  // resolution, never a specifier-text pattern — to a home module. The specifier text `#ihp` shares
  // not one character with either home module's path, so this shape is the clearest possible proof
  // that the check is resolution-based, not spelling-based.
  it('sensitivity ("z10", package.json "imports" alias) — a `#ihp` subpath import resolving to a home module is flagged, though its specifier text names nothing restricted', () => {
    const { inputs, cleanup } = scratchCopy({
      packageJson: { name: 'v1-scratch', private: true, imports: { '#ihp': './src/lib/fba/listingPipeline.ts' } },
      extra: { relPath: 'app/api/fba/probe-v1-z10/route.ts', content: `import * as lp from '#ihp'\nlet m: any\nexport async function POST() { m = lp; return m['buildItemHighlights']({} as never) }` },
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `"z10" must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
      expect(violations.some((v) => v.includes('#ihp')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })

  // Two shapes the OLD regex-based named-import/re-export scanners (`findSyncBuilderBypassImports`,
  // `findReExportBypass`) were ALSO vulnerable to in principle: a block comment sitting INSIDE the
  // braces, between the restricted name and its alias — `stripLineComments` only strips `//` line
  // comments, so `/* x */` text survives into the specifier-splitting regex and breaks the exact-text
  // match. Both shapes ARE flagged correctly (asserted below) — but MUTATION-TESTED (not assumed):
  // disabling the new named-import/re-export DECLARATION branch alone (`if (nb &&
  // ts.isNamedImports(nb))` / the re-export `if (RESTRICTED_NAMES.includes(originalText) ...)`
  // check) leaves BOTH shapes GREEN, because K8's own identifier walk already visits the import/
  // re-export specifier's `propertyName` token (text `buildItemHighlights`/`runIhTail`) as an
  // ordinary Identifier reference and resolves it via `resolvesToTarget`, independent of the LOCAL
  // alias and unaffected by a comment between tokens (AST parsing ignores comments regardless of
  // which scanner reads it). A directly-spelled import/re-export specifier of a restricted name
  // therefore has NO shape where the new declaration-level rule is independently load-bearing: ES
  // module syntax requires the propertyName token to exist, and K8 already resolves it under any
  // local name. The declaration rule is still correct and still implements the ruling's "under any
  // local name" wording via the compiler's symbol resolution rather than text — it is DEFENSE IN
  // DEPTH alongside K8, not a shape K8 misses. (Restated in the round's report, not hidden.)
  it('sensitivity ("named import, comment inside braces") — flagged (via K8; the new declaration rule is redundant here, see comment above)', () => {
    const content = `import { /* keep */ buildItemHighlights as composeIh } from '@/lib/fba/listingPipeline'\nexport async function POST() { return composeIh({} as never) }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'app/api/fba/probe-v1-namedcomment/route.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('buildItemHighlights')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })
  it('sensitivity ("named re-export, comment inside braces") — flagged (via K8; the new declaration rule is redundant here, see comment above)', () => {
    const content = `export { /* keep */ runIhTail as tail } from '@/lib/fba/listingPipeline'\n`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/v1ReexportComment.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('runIhTail')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })

  // ImportEqualsDeclaration (`import X = require('<home>')`): named explicitly by the ruling as a
  // form to resolve. `import ... = require(...)` is a TS1202 DIAGNOSTIC error under this repo's own
  // `module: esnext` (the semantic checker refuses the construct), but the PARSER still produces a
  // real ImportEqualsDeclaration node in the program either way (a diagnostic is not a parse
  // failure, and this scanner never consults diagnostics) — verified empirically (z14 in the
  // round's report goes RED through the full `findEnumerationViolations` pipeline, not just a
  // synthetic unit check).
  it('sensitivity ("z14", import-equals require of home) — flagged through the full pipeline despite the construct\'s own TS1202 diagnostic elsewhere', () => {
    const content = `import lp = require('@/lib/fba/listingPipeline')\nlet m: any\nexport async function POST() { m = lp; return m['buildItemHighlights']({} as never) }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'app/api/fba/probe-v1-z14/route.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `"z14" must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // Non-literal dynamic import/require, and require/module.require/createRequire used as a VALUE
  // rather than a direct literal call — refused ANYWHERE in the program regardless of target, since
  // the target cannot be statically bounded.
  it('sensitivity ("non-literal dynamic import") — a variable specifier is flagged even when it targets nothing restricted', () => {
    const content = `export async function loadIt(modulePath: string) { return import(modulePath) }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/v1NonLiteralImport.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('NON-LITERAL')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })
  it('sensitivity ("require used as a value") — `const r = require` then `r(...)` is flagged even though the literal call site itself is never home-targeted first', () => {
    const content = `export function loadIt() { const r = require; return r('lodash') }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/v1RequireValue.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes("value use of 'require'")), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })
  it('sensitivity ("module.require used as a value")', () => {
    const content = `export function loadIt() { const r = module.require; return r('lodash') }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/v1ModuleRequireValue.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes("'module.require'")), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })
  it('sensitivity ("createRequire") — any reference is flagged; its indirection cannot be statically bounded', () => {
    const content = `import { createRequire } from 'node:module'\nexport function loadIt() { const req = createRequire(import.meta.url); return req('lodash') }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/v1CreateRequire.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('createRequire')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })
  it('a PLAIN literal require/import of an UNRELATED module is NOT flagged (the value-use and non-literal rules do not over-refuse ordinary code)', () => {
    const content = `export function loadIt() { return require('lodash') }\nexport async function loadIt2() { return import('lodash') }`
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/v1PlainRequire.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations, JSON.stringify(violations)).toEqual([])
    } finally { cleanup() }
  })

  it('the allowlist mechanism itself does not over-refuse: removing syncKeywordIntelligence.ts from the allowlist DOES flag its own real dynamic import of APPAREL_PRODUCT_TYPES', () => {
    // Proves the allowlist is doing the exempting rather than an accidental non-match: the REAL
    // tree's own "the REAL tree" test (below, K8 section) already asserts `[]` WITH the allowlist in
    // place — this copies that one file's real content to a NEW path outside the allowlist and
    // confirms the SAME dynamic import is now flagged.
    const realSource = fs.readFileSync(path.join(SRC_ROOT, 'lib/sync/syncKeywordIntelligence.ts'), 'utf8')
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/sync/v1NotAllowlisted.ts', content: realSource } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('v1NotAllowlisted') && v.includes('listingPipeline')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })
})

describe('Item Highlights writer (B4/W6): sync builders/composer/tail are called ONLY through the async wrappers', () => {
  it('sensitivity (W6/I4 shape 1) — an ALIASED import of buildItemHighlights in a new route is flagged even though the call site never spells the real name', () => {
    const fakeFile = 'src/app/api/fba/some-aliased-route/route.ts'
    const fakeSource = `
      import { buildItemHighlights as composeIh } from '@/lib/fba/listingPipeline'
      export async function POST() {
        return composeIh({ finalTitle: '', pool: [], apparelProduct: true, blankBrand: null, netTitles: null })
      }
    `
    expect(findSyncBuilderBypassImports(fakeFile, fakeSource)).toEqual([
      `${fakeFile}: imports 'buildItemHighlights' (as composeIh) — outside its home module (${LISTING_PIPELINE_REL}); route through the produce* wrapper instead`,
    ])
  })

  it('sensitivity (W6/I4 shape 2) — a LOWER-LAYER producer combined with the tail, in a new route, is flagged on BOTH imports', () => {
    const fakeFile = 'src/app/api/fba/some-lower-layer-route/route.ts'
    const fakeSource = `
      import { composeItemHighlightDetailed } from '@/lib/fba/itemHighlightComposer'
      import { runIhTail } from '@/lib/fba/listingPipeline'
      export async function POST() {
        const res = composeItemHighlightDetailed([], [], {} as never)
        return runIhTail(res.line ?? '', {} as never)
      }
    `
    const violations = findSyncBuilderBypassImports(fakeFile, fakeSource)
    expect(violations).toEqual([
      expect.stringContaining(`imports 'composeItemHighlightDetailed'`),
      expect.stringContaining(`imports 'runIhTail'`),
    ])
  })

  it('a `type`-only import of a restricted name (the real regen route\'s own shape) is NOT flagged', () => {
    const fakeSource = `import { produceItemHighlightsPerDesign, type buildItemHighlightsPerDesign } from '@/lib/fba/listingPipeline'`
    expect(findSyncBuilderBypassImports('src/app/api/fba/regenerate-item-highlight/route.ts', fakeSource)).toEqual([])
  })

  it('the REAL tree: zero production file imports a restricted name outside its home module', () => {
    const allViolations: string[] = []
    for (const abs of listTsFiles(SRC_ROOT)) {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/')
      const source = fs.readFileSync(abs, 'utf8')
      allViolations.push(...findSyncBuilderBypassImports(rel, source))
    }
    expect(allViolations).toEqual([])
  })
})

describe('Item Highlights writer (B4): sync builders are called ONLY through the async wrappers', () => {
  it('sensitivity — the scanner flags a bare call in a synthetic non-pipeline file (proven to go RED)', () => {
    const fakeFile = 'src/app/api/fba/some-new-route/route.ts'
    const fakeSource = `
      import { buildItemHighlights } from '@/lib/fba/listingPipeline'
      export async function POST() {
        const built = buildItemHighlights({ finalTitle: '', pool: [], apparelProduct: true, blankBrand: null, netTitles: null })
        return built
      }
    `
    expect(findSyncBuilderBypassCalls(fakeFile, fakeSource)).toEqual([
      `${fakeFile}: bare buildItemHighlights(...) call outside listingPipeline.ts (must go through the produce* wrapper)`,
    ])
  })

  it('sensitivity — a bare call inside a NEW, unsanctioned function in listingPipeline.ts itself is also flagged', () => {
    const fakeSource = `
      export function buildItemHighlights(input) { return { value: '', hold: null } }
      export function buildItemHighlightsPerDesign(input) {
        const r = buildItemHighlights({})
        return r
      }
      export async function produceItemHighlights(input) {
        const built = buildItemHighlights(input)
        return built
      }
      export async function produceItemHighlightsPerDesign(input) {
        const built = buildItemHighlightsPerDesign(input)
        return built
      }
      export function someBrandNewBranch(input) {
        // a future edit that forgets the writer wrapper
        const built = buildItemHighlights(input)
        return built
      }
    `
    const violations = findSyncBuilderBypassCalls(LISTING_PIPELINE_REL, fakeSource)
    expect(violations).toEqual([
      expect.stringContaining('someBrandNewBranch'),
    ])
  })

  it('the REAL tree: every bare buildItemHighlights(...)/buildItemHighlightsPerDesign(...) call sits inside listingPipeline.ts at one of the three sanctioned functions', () => {
    const allViolations: string[] = []
    for (const abs of listTsFiles(SRC_ROOT)) {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/')
      const source = fs.readFileSync(abs, 'utf8')
      allViolations.push(...findSyncBuilderBypassCalls(rel, source))
    }
    expect(allViolations).toEqual([])
  })

  it('the REAL listingPipeline.ts has EXACTLY the three sanctioned call sites — no more, no fewer (a revert of either switched production call site changes this count)', () => {
    const source = stripLineComments(fs.readFileSync(path.join(SRC_ROOT, 'lib/fba/listingPipeline.ts'), 'utf8'))
    const bareCalls = (name: string): number => {
      const RE = new RegExp(`\\b${name}\\(`, 'g')
      let n = 0
      let m: RegExpExecArray | null
      while ((m = RE.exec(source))) {
        const before = source.slice(Math.max(0, m.index - 60), m.index)
        if (!/function\s*$/.test(before)) n++
      }
      return n
    }
    // buildItemHighlights( is called bare twice: once inside buildItemHighlightsPerDesign (per-design
    // fan-out reuse) and once inside produceItemHighlights (the wrapper calling what it wraps).
    expect(bareCalls('buildItemHighlights')).toBe(2)
    // buildItemHighlightsPerDesign( is called bare once: inside produceItemHighlightsPerDesign.
    expect(bareCalls('buildItemHighlightsPerDesign')).toBe(1)
  })

  it('the REAL production call sites (pipeline + regen route) now await the wrappers, by name', () => {
    const pipeline = fs.readFileSync(path.join(SRC_ROOT, 'lib/fba/listingPipeline.ts'), 'utf8')
    expect(pipeline).toMatch(/await produceItemHighlightsPerDesign\(\{/)
    expect(pipeline).toMatch(/await produceItemHighlights\(\{/)
    const route = fs.readFileSync(path.join(SRC_ROOT, 'app/api/fba/regenerate-item-highlight/route.ts'), 'utf8')
    expect(route).toMatch(/await produceItemHighlightsPerDesign\(\{/)
    expect(route).toMatch(/await produceItemHighlights\(\{/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════
// RULING K8 (fix round B4, wire B1): "The enumeration test detects REFERENCES, not spellings."
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Review B3's wire lens (phase-b3-review-wire.md §2) proved the spelling-based scanners above miss
// 8 compiling bypass shapes — namespace destructuring/bracket access, a `.then`/`require` dynamic
// import, and four shapes INSIDE listingPipeline.ts/itemHighlightComposer.ts itself (a new branch
// or alias that reaches a restricted name with no builder/wrapper call spelled anywhere). The cure
// (per the ruling) is the TypeScript compiler's own symbol resolution: build a `ts.Program` over
// `src/`, take the declaration SYMBOL of each of the five restricted names, and require every
// REFERENCE to that symbol (however it is spelled — an alias, a destructure, a namespace property,
// a bracket-string access, a dynamic import) to sit inside a sanctioned enclosing function. This
// keeps the scanners above (they still run, per the ruling's "keep the existing import scanner") —
// K8 adds a second, independent net that reasons about REFERENCES instead of TEXT.

/** The five names the ruling names, and each one's HOME file (declaration site). */
const RESTRICTED_NAMES = ['buildItemHighlights', 'buildItemHighlightsPerDesign', 'composeItemHighlightDetailed', 'composeItemHighlight', 'runIhTail'] as const
type RestrictedName = typeof RESTRICTED_NAMES[number]

/** Every function name whose BODY may legitimately reference a restricted name: the three
 *  produce-prefixed wrappers (spec's own "the produce* wrappers, or the builders' own internals"),
 *  PLUS `buildItemHighlights` itself (it calls `composeItemHighlightDetailed`/`runIhTail` — the
 *  canonical composer/tail call site) and `composeItemHighlight` (the composer's own thin wrapper
 *  around `composeItemHighlightDetailed`). Every OTHER function, or module top level (an import
 *  binding is not itself a reference — see `isImportBindingDecl` below — but an ALIAS assignment,
 *  a re-export, or a call outside these six is), is unsanctioned. */
const SANCTIONED_ENCLOSING_FN_NAMES = new Set<string>([
  'buildItemHighlights', 'buildItemHighlightsPerDesign', 'produceItemHighlights', 'produceItemHighlightsPerDesign', 'composeItemHighlight',
])

interface EnumerationProgramInputs {
  rootNames: string[]
  options: ts.CompilerOptions
  /** Absolute path to `listingPipeline.ts` and `itemHighlightComposer.ts` WITHIN this program's own
   *  root (a scratch copy has its own absolute paths, distinct from the real tree's). */
  listingPipelineAbs: string
  composerAbs: string
  /** RULING W4 (fix round B7b, wire required): an OVERLAY of absolute-path -> full source text,
   *  served by the shared `CompilerHost` (see `makeSharedHost` below) INSTEAD OF the real file on
   *  disk — a path already in the real tree with different text here is the home-append mutation
   *  shapes; a path not in the real tree is a brand-new synthetic file (the outside-file shapes).
   *  Never written to disk. Omitted/empty for the real tree (no overlay). */
  overlay?: ReadonlyMap<string, string>
}

const BASE_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2017,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowJs: true,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
}

// RULING P8 (fix round B5, wire Blocking 1, W1): scan every extension the BUILD actually compiles —
// `tsconfig.json` sets `allowJs: true` and `"**/*.mts"` in `include`, and Next's App Router routes
// as plain `route.js` — so a `.ts`/`.tsx`-only scan left `route.js` (N10) and a `.mts` helper (N11)
// production-reachable and unscanned. `.jsx`/`.cjs`/`.cts` complete the set the compiler recognizes.
const COMPILED_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
const COMPILED_TEST_RE = /\.test\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
function listTsFilesFlat(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...listTsFilesFlat(full)); continue }
    if (!COMPILED_EXT_RE.test(entry.name)) continue
    if (COMPILED_TEST_RE.test(entry.name)) continue
    out.push(full)
  }
  return out
}

// ─── RULING W4 (fix round B7b, wire required): "build the TypeScript Program ONCE and share it" ──
//
// Review B6/wire's own m1 measured WHY the standalone file takes 121.84s and 8 of its tests time out
// under the repo's default 5000ms per-test timeout: `scratchCopy` (below, historically) called
// `fs.cpSync(SRC_ROOT, copyRoot, { recursive: true })` — copying every one of `src/`'s ~398 files to
// a FRESH temp directory — and then `ts.createProgram` parsed, bound and type-checked that whole
// copy FROM SCRATCH, for EVERY ONE of ~40 shape tests. At most one or two files ever differ from the
// real tree in any single test (a brand-new synthetic route, or a few appended lines inside a home
// file) — a full directory copy plus a from-scratch program is the same information as an OVERLAY of
// those one or two files on top of the real tree's own (unchanging) file set, at a fraction of the
// cost. `makeSharedHost` builds ONE `ts.CompilerHost` whose `readFile`/`getSourceFile` serve the real
// tree's ~398 files from a MODULE-LEVEL cache (populated lazily, ONCE, the first time each file is
// asked for, and kept for the rest of this test FILE's run — vitest runs a file's own tests
// sequentially, never concurrently, so a plain `Map` needs no locking) and serve any OVERLAID path
// from that one call's own `overlay` map instead — never touching disk for the overlay content, and
// never re-parsing an unchanged real file twice. No temp directory is created and nothing is ever
// written inside (or outside) the repo for a shape test any more.
const REAL_OPTIONS: ts.CompilerOptions = { ...BASE_COMPILER_OPTIONS, baseUrl: process.cwd(), paths: { '@/*': ['./src/*'] } }
let cachedRealRootNames: string[] | null = null
/** The real tree's root file list, computed once and returned as a fresh array each call so a
 *  caller may safely append extra (synthetic) paths without mutating the shared cache. */
function getRealRootNamesCached(): string[] {
  if (!cachedRealRootNames) cachedRealRootNames = listTsFilesFlat(SRC_ROOT)
  return [...cachedRealRootNames]
}
/** Passed as `oldProgram` to every `ts.createProgram` call below (see `findEnumerationViolations`) —
 *  TypeScript's own incremental-reuse path, keyed off this stable reference, is what actually skips
 *  re-binding/re-checking ~398 unchanged files; updated only after a call with NO overlay (a mutated
 *  program must never become the reuse baseline for a later, unrelated call). */
let sharedBaseProgram: ts.Program | null = null
const parsedSourceFileCache = new Map<string, ts.SourceFile>()
const readFileTextCache = new Map<string, string>()
/** TypeScript calls a `CompilerHost`'s `fileExists`/`readFile`/`getSourceFile` with its OWN
 *  internally-normalized path string — always forward-slashed, regardless of platform — which is
 *  NOT the same string `path.join` produces on Windows (backslashed). An overlay `Map` keyed by the
 *  `path.join` form therefore never matches what the host is actually asked for: every lookup misses,
 *  the miss falls through to the REAL disk (where a synthetic/mutated file does not exist), and the
 *  file silently disappears from the program with zero violations reported for ANY shape — this was
 *  caught here only by mutation-proving the "exportStarAs-anyBracket" pin (M0 control) after this
 *  overlay mechanism was first written, not by inspection; see the W4 section of the round's report.
 *  Normalizing BOTH the overlay's keys (`scratchCopy`, below) and every incoming `fileName` here to
 *  forward slashes makes the two sides comparable again. */
const toPosix = (p: string): string => p.replace(/\\/g, '/')
/** Builds a `CompilerHost` for ONE `findEnumerationViolations` call. `overlay` entries are served
 *  directly (parsed fresh — they are 1-2 small files, never cached, since their content is specific
 *  to this one call); every other path is served from the two MODULE-LEVEL caches above, populated
 *  lazily via the real `ts.createCompilerHost`'s own `readFile`/`getSourceFile` on first request and
 *  reused by every subsequent call in this test file's run. `setParentNodes: true` is required — the
 *  scanner's AST walks (`enclosingFunctionIsSanctioned` etc.) read `.parent`. */
function makeSharedHost(overlay: ReadonlyMap<string, string>): ts.CompilerHost {
  const base = ts.createCompilerHost(REAL_OPTIONS, true)
  return {
    ...base,
    fileExists: (fileName) => {
      const key = toPosix(fileName)
      return overlay.has(key) || readFileTextCache.has(key) || base.fileExists(fileName)
    },
    // RULING V1 (fix round B8b): resolving a relative specifier that lands OUTSIDE the real src/
    // tree (an overlay-only synthetic file, e.g. z9/z9b's `ihx/` probe) needs its PARENT directory
    // to read as existing — the real filesystem has no such directory, and without this override
    // `base.directoryExists` (backed by the real fs) says no, so `ts.resolveModuleName`'s own
    // directory-probe short-circuits before ever calling `fileExists` for a candidate file inside
    // it, and the whole shape silently fails to resolve (verified empirically: removing this
    // override drops the z9b probe's resolution to `undefined` — see the round's report). An
    // overlay directory reads as existing whenever ANY overlaid path sits under it.
    directoryExists: (dirName) => {
      const key = toPosix(dirName)
      const withSlash = key.endsWith('/') ? key : `${key}/`
      for (const k of overlay.keys()) { if (k.startsWith(withSlash)) return true }
      return base.directoryExists ? base.directoryExists(dirName) : true
    },
    readFile: (fileName) => {
      const key = toPosix(fileName)
      const overlayText = overlay.get(key)
      if (overlayText !== undefined) return overlayText
      const cached = readFileTextCache.get(key)
      if (cached !== undefined) return cached
      const real = base.readFile(fileName)
      if (real !== undefined) readFileTextCache.set(key, real)
      return real
    },
    getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const key = toPosix(fileName)
      const overlayText = overlay.get(key)
      if (overlayText !== undefined) {
        const target = typeof languageVersionOrOptions === 'object' ? languageVersionOrOptions.languageVersion : languageVersionOrOptions
        return ts.createSourceFile(fileName, overlayText, target, true)
      }
      const cached = parsedSourceFileCache.get(key)
      if (cached) return cached
      const sf = base.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
      if (sf) parsedSourceFileCache.set(key, sf)
      return sf
    },
  }
}

/** The REAL tree's program inputs — used by the "real tree" completeness test below. */
function realTreeInputs(): EnumerationProgramInputs {
  return {
    rootNames: getRealRootNamesCached(),
    options: REAL_OPTIONS,
    listingPipelineAbs: path.join(SRC_ROOT, 'lib/fba/listingPipeline.ts'),
    composerAbs: path.join(SRC_ROOT, 'lib/fba/itemHighlightComposer.ts'),
  }
}

/**
 * THE K8 scanner. Builds a `ts.Program`, finds the declaration SYMBOL of each restricted name
 * inside its home file, then walks every root file looking for a reference to that symbol:
 * - Inside the TWO home files (`listingPipeline.ts`/`itemHighlightComposer.ts`): a reference is
 *   fine when it is the declaration itself, an IMPORT binding (bringing the OTHER home's two names
 *   into scope — that binding itself is not a "use"), or a genuine use whose nearest enclosing
 *   top-level function is one of `SANCTIONED_ENCLOSING_FN_NAMES`. Anything else — a new function, a
 *   module-level alias/const, a re-export — is a violation.
 * - In every OTHER file: ANY reference to a restricted name is unconditionally a violation — such a
 *   file should never need to reach these five names directly; it must call `produce*` instead.
 * `require(...)`/dynamic `import(...)` destructuring is walked STRUCTURALLY as well (their return
 * type is untyped/`any`, so the checker's own symbol resolution goes dark for that one shape) —
 * still a compiler-API/AST answer, never a spelling regex over source text.
 */
function findEnumerationViolations(inputs: EnumerationProgramInputs): { violations: string[]; ms: number } {
  const t0 = Date.now()
  const { rootNames, options, listingPipelineAbs, composerAbs } = inputs
  const homeAbsOf: Record<RestrictedName, string> = {
    buildItemHighlights: listingPipelineAbs, buildItemHighlightsPerDesign: listingPipelineAbs, runIhTail: listingPipelineAbs,
    composeItemHighlightDetailed: composerAbs, composeItemHighlight: composerAbs,
  }
  const homeFiles = new Set<string>([listingPipelineAbs, composerAbs])
  const host = makeSharedHost(inputs.overlay ?? new Map())
  // RULING W4: pass the shared BASE program (built once, over the unmodified real tree) as
  // `oldProgram` — TypeScript's own incremental-reuse path (the mechanism `--incremental`/watch mode
  // uses) then skips re-binding and re-checking every unchanged file's declarations instead of only
  // skipping re-parsing (a hand-rolled SourceFile cache alone, tried first, did not move the whole
  // file's runtime — see the round's report for the measured before/after).
  const program = ts.createProgram({ rootNames, options, host, oldProgram: sharedBaseProgram ?? undefined })
  if (!inputs.overlay || inputs.overlay.size === 0) sharedBaseProgram = program
  const checker = program.getTypeChecker()

  // RULING P8 (fix round B5, wire Blocking 1, W1 hole 1: "the enclosure test is still a SPELLING
  // test"): resolve a NAME to its TOP-LEVEL declaration ONLY — a nested declaration (N1, "a nested
  // `function produceItemHighlights()`") or a second local declaration with the same NAME but a
  // DIFFERENT symbol (N2) must never be mistaken for the sanctioned/restricted one just because a
  // depth-first walk over the whole file happened to visit it. `sf.statements` is the file's own
  // TOP-LEVEL statement list — never recursed into.
  function findTopLevelFnDecl(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt
    }
    return null
  }
  function findDeclSymbol(name: RestrictedName): ts.Symbol | null {
    const sf = program.getSourceFile(homeAbsOf[name])
    if (!sf) return null
    const decl = findTopLevelFnDecl(sf, name)
    return decl?.name ? (checker.getSymbolAtLocation(decl.name) ?? null) : null
  }
  const declSymbols: Record<string, ts.Symbol | null> = {}
  for (const name of RESTRICTED_NAMES) declSymbols[name] = findDeclSymbol(name)

  // RULING P8: the SANCTIONED enclosing functions, resolved the SAME declaration-identity way —
  // each by its OWN top-level declaration SYMBOL in its OWN home file (`composeItemHighlight` in
  // the composer; the other four in `listingPipeline.ts`), never by name alone.
  const SANCTIONED_ENCLOSING_FN_HOME: Readonly<Record<string, string>> = {
    buildItemHighlights: listingPipelineAbs, buildItemHighlightsPerDesign: listingPipelineAbs,
    produceItemHighlights: listingPipelineAbs, produceItemHighlightsPerDesign: listingPipelineAbs,
    composeItemHighlight: composerAbs,
  }
  const sanctionedDeclSymbols = new Set<ts.Symbol>()
  for (const [name, home] of Object.entries(SANCTIONED_ENCLOSING_FN_HOME)) {
    const sf = program.getSourceFile(home)
    const decl = sf && findTopLevelFnDecl(sf, name)
    if (decl?.name) {
      const sym = checker.getSymbolAtLocation(decl.name)
      if (sym) sanctionedDeclSymbols.add(sym)
    }
  }

  function resolvesToTarget(node: ts.Node, target: ts.Symbol): boolean {
    let sym: ts.Symbol | undefined = checker.getSymbolAtLocation(node)
    if (!sym) return false
    const seen = new Set<ts.Symbol>()
    while (sym && (sym.flags & ts.SymbolFlags.Alias) && !seen.has(sym)) {
      seen.add(sym)
      try { sym = checker.getAliasedSymbol(sym) } catch { break }
    }
    if (sym === target) return true
    const targetDecls = target.declarations ?? []
    const symDecls = sym?.declarations ?? []
    return symDecls.some((d) => targetDecls.includes(d))
  }
  /** RULING P8: the nearest enclosing `FunctionDeclaration` NODE is sanctioned only when ITS OWN
   *  declared symbol IS one of `sanctionedDeclSymbols` — never by comparing names. A nested
   *  `function produceItemHighlights(){...}` (N1) or a second local `function
   *  composeItemHighlight(){...}` (N2) declares a DIFFERENT symbol (different declaration node),
   *  even though `.name.text` matches, so this now correctly rejects both. */
  function enclosingFunctionIsSanctioned(node: ts.Node): { sanctioned: boolean; name: string | null } {
    let cur: ts.Node | undefined = node
    while (cur) {
      if (ts.isFunctionDeclaration(cur)) {
        const sym = cur.name ? checker.getSymbolAtLocation(cur.name) : undefined
        return { sanctioned: !!sym && sanctionedDeclSymbols.has(sym), name: cur.name?.text ?? null }
      }
      cur = cur.parent
    }
    return { sanctioned: false, name: null }
  }
  function isTypeOnlyPosition(node: ts.Node): boolean {
    let cur: ts.Node | undefined = node
    while (cur) {
      if (ts.isTypeReferenceNode(cur) || ts.isTypeQueryNode(cur)) return true
      if (ts.isImportSpecifier(cur) && cur.isTypeOnly) return true
      if (ts.isImportClause(cur) && cur.isTypeOnly) return true
      if (ts.isTypeAliasDeclaration(cur)) return true
      cur = cur.parent
    }
    return false
  }
  function isImportBindingDecl(node: ts.Node): boolean {
    const p = node.parent
    return !!p && ts.isImportSpecifier(p) && (p.name === node || p.propertyName === node)
  }
  function specifierTargetsHome(spec: string): string | null {
    if (/listingPipeline/.test(spec)) return listingPipelineAbs
    if (/itemHighlightComposer/.test(spec)) return composerAbs
    return null
  }
  function isRequireCall(node: ts.Node): node is ts.CallExpression {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
  }
  /** `require(...)`/dynamic `import(...)` destructuring — untyped, so `resolvesToTarget` goes dark;
   *  read the AST structurally instead (still the compiler API, never a source-text regex). */
  function structuralDynamicViolations(sf: ts.SourceFile, rel: string): string[] {
    const out: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
        let spec: string | null = null
        const init = node.initializer
        if (isRequireCall(init)) spec = (init.arguments[0] as ts.StringLiteralLike).text
        else if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)
          && init.expression.expression.kind === ts.SyntaxKind.ImportKeyword
          && init.expression.arguments.length === 1 && ts.isStringLiteralLike(init.expression.arguments[0])) {
          spec = (init.expression.arguments[0] as ts.StringLiteralLike).text
        }
        const home = spec ? specifierTargetsHome(spec) : null
        if (home && home !== sf.fileName) {
          for (const el of (node.name as ts.ObjectBindingPattern).elements) {
            const propName = el.propertyName ?? el.name
            if (ts.isIdentifier(propName) && (RESTRICTED_NAMES as readonly string[]).includes(propName.text)) {
              out.push(`${rel}: destructures restricted name '${propName.text}' from '${spec}' outside its home module`)
            }
          }
        } else if (!home) {
          // RULING Q3 (fix round B6, wire Blocking): destructuring off a namespace-of-home
          // expression is not only a `require`/`await import(...)` shape — "const { name } = lp as
          // any" (X7) reaches the SAME namespace through an existing variable, not a fresh dynamic
          // import. `resolvesToNamespaceOfHome` is the ONE predicate that already answers "does this
          // expression resolve to the home namespace, through any alias/cast/capture" — reuse it,
          // never a second copy.
          let initExpr: ts.Expression = init
          while (ts.isAsExpression(initExpr) || ts.isParenthesizedExpression(initExpr) || ts.isNonNullExpression(initExpr)) initExpr = initExpr.expression
          if ((ts.isIdentifier(initExpr) || ts.isPropertyAccessExpression(initExpr)) && resolvesToNamespaceOfHome(initExpr, 0)) {
            for (const el of (node.name as ts.ObjectBindingPattern).elements) {
              const propName = el.propertyName ?? el.name
              if (ts.isIdentifier(propName) && (RESTRICTED_NAMES as readonly string[]).includes(propName.text)) {
                out.push(`${rel}: destructures restricted name '${propName.text}' from a namespace of its home module (via a cast or an intermediate variable) outside its home module`)
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }
  /** `obj['buildItemHighlights'](...)` — bracket-string element access, traced back through
   *  `as any` casts, local re-assignment, and OBJECT CAPTURE ("const holder = { mod: lp }" then
   *  "holder.mod[...]" — RULING P8, N5/N5b) to a namespace import of a restricted home module.
   *  `idNode` may itself be a `PropertyAccessExpression` ("holder.mod"), not only a bare
   *  identifier — every recursive call unwraps `as`/paren/non-null wrappers first. */
  function resolvesToNamespaceOfHome(idNode: ts.Node, depth: number): boolean {
    if (depth > 5) return false
    let node: ts.Node = idNode
    while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression
    const origSym = checker.getSymbolAtLocation(node)
    /** Checks ONE symbol's own declarations for a namespace-of-home shape — never the fully
     *  alias-unwrapped TARGET, which for a plain `import * as X from home` skips PAST the
     *  `NamespaceImport` node straight to the module symbol (whose declaration is the SourceFile,
     *  not a NamespaceImport) and would wrongly report false. */
    const declaresNamespaceOfHome = (sym: ts.Symbol | undefined): boolean => {
      for (const d of sym?.declarations ?? []) {
        if (ts.isNamespaceImport(d) && specifierTargetsHome((d.parent.parent as ts.ImportDeclaration).moduleSpecifier.getText().replace(/^['"]|['"]$/g, ''))) return true
        // `export * as X from '<home>'` — the barrel's OWN re-export declaration (N3b).
        if (ts.isNamespaceExport(d) && ts.isExportDeclaration(d.parent) && d.parent.moduleSpecifier
          && specifierTargetsHome(d.parent.moduleSpecifier.getText().replace(/^['"]|['"]$/g, ''))) return true
        // RULING Q3 (fix round B6, wire Blocking): the FULLY-RESOLVED module symbol's own
        // declaration IS the home file's `SourceFile` node — recognized here too, so the
        // TYPE-derivation check below (`typeSym`) can answer "this expression's type IS the home
        // namespace" even when nothing in its OWN symbol chain is a NamespaceImport/NamespaceExport
        // specifier (e.g. a name re-exported through a barrel and consumed several hops away, where
        // only the STATIC TYPE still carries the module's identity). `ts.SourceFile#fileName` is
        // ALWAYS forward-slashed internally, even on Windows — `path.join`'s backslashes must be
        // normalized before comparing, or this silently never matches on that platform.
        if (ts.isSourceFile(d) && (d.fileName === listingPipelineAbs.replace(/\\/g, '/') || d.fileName === composerAbs.replace(/\\/g, '/'))) return true
      }
      return false
    }
    if (declaresNamespaceOfHome(origSym)) return true
    // RULING Q3 (fix round B6, wire Blocking): "treat an expression as reaching a home when the
    // CHECKER's type for it is, or derives from, a home module's namespace type" — a second,
    // TYPE-level test alongside the symbol-declaration test above, so an expression whose SYMBOL
    // resolution is severed (an `any` boundary) but whose STATIC TYPE the checker still infers as
    // (or through an alias of) the home namespace is caught the same way.
    const nodeType = checker.getTypeAtLocation(node)
    const typeSym = nodeType.getSymbol() ?? (nodeType as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol
    if (typeSym && typeSym !== origSym && declaresNamespaceOfHome(typeSym)) return true
    // RULING W2 (fix round B7b, wire Important, correcting P8/Q3's "N3b exportStarAs" comment):
    // walk the ALIAS chain ONE HOP AT A TIME with `getImmediateAliasedSymbol`, checking EACH
    // intermediate symbol — an import specifier bound through a barrel's `export * as X from
    // '<home>'` is an alias whose FIRST hop lands on the barrel's OWN re-export symbol (a
    // NamespaceExport declaration). Review B6/wire's mutation matrix (M0-M4) proved the PRIOR code
    // here called `checker.getAliasedSymbol`, which resolves the WHOLE chain in a single call — so
    // this loop's first (and only meaningful) iteration landed directly on the fully-resolved module
    // symbol and never actually SAW the intermediate NamespaceExport node; N3b/"exportStarAs" passed
    // ONLY because that same fully-resolved module symbol's declaration is the home file's own
    // `SourceFile` node, caught by `declaresNamespaceOfHome`'s SourceFile clause below — a route the
    // independent `typeSym` check three lines up ALSO reaches on its own. The loop was dead: with
    // EITHER check present alone the pin passed; only removing BOTH, or removing the SourceFile
    // clause itself, failed it (M1/M2 pass, M3/M4 fail — see the pin's own comment in
    // itemHighlightWriterEnumeration.test.ts's K8 describe block for the up-to-date mutation record).
    // `getImmediateAliasedSymbol` makes the hop genuine: for the barrel shape it now lands on the
    // NamespaceExport declaration itself at hop 1 and returns true there, independently of the
    // SourceFile clause — so the loop is no longer redundant with `typeSym`, it is a second,
    // distinct path to the same conclusion.
    let aliasSym = origSym
    const seenAlias = new Set<ts.Symbol>()
    while (aliasSym && (aliasSym.flags & ts.SymbolFlags.Alias) && !seenAlias.has(aliasSym)) {
      seenAlias.add(aliasSym)
      try { aliasSym = checker.getImmediateAliasedSymbol(aliasSym) } catch { break }
      if (aliasSym && declaresNamespaceOfHome(aliasSym)) return true
    }
    for (const d of origSym?.declarations ?? []) {
      if (ts.isVariableDeclaration(d) && d.initializer) {
        let init: ts.Expression = d.initializer
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isNonNullExpression(init)) init = init.expression
        // RULING Q3 (fix round B6, wire Blocking): "follow a variable initializer through a call,
        // an `await import(...)`, and an object literal — not only identifiers and property
        // access." Two additions, closing the class rather than the reviewer's individual shapes:
        //   - `await import('<home>')` assigned WHOLE to a variable (X3: "const m = await
        //     import(home); (m as any)['name'](...)") — the initializer itself names the home
        //     module directly, no further symbol resolution needed.
        //   - a CALL initializer (X5: "const typed = asMap(lp)") — taint propagates through the
        //     call: if ANY argument itself resolves to the home namespace, the call's result is
        //     treated as reaching home too, regardless of what the callee's OWN return type says.
        if (ts.isAwaitExpression(init)) {
          const callee = init.expression
          if (ts.isCallExpression(callee) && callee.expression.kind === ts.SyntaxKind.ImportKeyword
            && callee.arguments.length === 1 && ts.isStringLiteralLike(callee.arguments[0])
            && specifierTargetsHome((callee.arguments[0] as ts.StringLiteralLike).text)) {
            return true
          }
        }
        if (ts.isCallExpression(init) && init.arguments.some((a) => resolvesToNamespaceOfHome(a, depth + 1))) return true
        if ((ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) && resolvesToNamespaceOfHome(init, depth + 1)) return true
      }
      // RULING P8 (object capture, N5/N5b): a property inside an object LITERAL whose own value
      // (or shorthand binding) is a namespace-of-home identifier/property-access.
      if (ts.isPropertyAssignment(d) && resolvesToNamespaceOfHome(d.initializer, depth + 1)) return true
      if (ts.isShorthandPropertyAssignment(d) && resolvesToNamespaceOfHome(d.name, depth + 1)) return true
    }
    // The OBJECT half of a property access ("holder.mod") — one more hop outward, in case the
    // PROPERTY's own symbol resolution above did not resolve it but the base expression would.
    if (ts.isPropertyAccessExpression(node)) {
      if (resolvesToNamespaceOfHome(node.expression, depth + 1)) return true
      // RULING P8 (object capture through an `any` cast, N5b: "const holderAny = holder as any;
      // holderAny.mod[...]"): once the BASE is cast to `any`, `holderAny.mod` has no resolvable
      // symbol at all (an `any`-typed property access), so neither the direct check above NOR the
      // base-hop above can ever see the object literal's OWN "mod: lp" property. Strip the base
      // back through its variable-declaration chain to the underlying (pre-cast, still literally-
      // typed) expression, and if THAT is the object literal, look up the SAME property name on
      // it directly — the property's own initializer is unaffected by a cast applied downstream.
      const strippedBase = stripCastChain(node.expression, 0)
      if (ts.isObjectLiteralExpression(strippedBase)) {
        for (const p of strippedBase.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === node.name.text) {
            if (resolvesToNamespaceOfHome(p.initializer, depth + 1)) return true
          }
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === node.name.text) {
            if (resolvesToNamespaceOfHome(p.name, depth + 1)) return true
          }
        }
      }
    }
    return false
  }
  /** Follows an identifier through its OWN variable-declaration initializer, one hop at a time
   *  (unwrapping `as`/paren/non-null at each step), stopping at whatever is NOT a further
   *  re-assignable identifier — used only to see PAST an `any` cast down to the original,
   *  still-precisely-typed expression it was cast FROM. */
  function stripCastChain(expr: ts.Expression, depth: number): ts.Expression {
    if (depth > 5) return expr
    let e: ts.Expression = expr
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression
    if (ts.isIdentifier(e)) {
      const sym = checker.getSymbolAtLocation(e)
      for (const d of sym?.declarations ?? []) {
        if (ts.isVariableDeclaration(d) && d.initializer) return stripCastChain(d.initializer, depth + 1)
      }
    }
    return e
  }
  /** RULING P8 (fix round B5, wire Blocking 1, W1 hole 2): "a string-literal-typed key is not
   *  treated as a reference unless it is an ElementAccessExpression whose object is a direct
   *  namespace identifier." Reads the expression's OWN TYPE via the checker — not only its
   *  syntax — so a `const K = 'buildItemHighlights' as const` used later as `lp[K]` (N13), or a
   *  literal argument whose generic parameter infers the SAME literal type (`Reflect.get(lp,
   *  'buildItemHighlights')`, N8/N8b; a `pick<M,K extends keyof M>(lp, 'buildItemHighlights')`
   *  helper, N4), is caught by what the COMPILER itself resolved the value to, never a syntax
   *  shape written for one probe string. */
  function stringLiteralTypeValue(node: ts.Node): string | null {
    if (ts.isStringLiteralLike(node)) return node.text
    const t = checker.getTypeAtLocation(node)
    return t.flags & ts.TypeFlags.StringLiteral ? (t as ts.StringLiteralType).value : null
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // RULING V1 (fix round B8b, controller review B7/wire B1): the module-boundary rules, rebuilt on
  // the compiler's AST and its OWN module resolution — never on source text. Folded into this same
  // function (sharing the ONE program/checker K8 already built above) rather than a second
  // `ts.createProgram` call.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const homeFilesPosix = new Set<string>([toPosix(listingPipelineAbs), toPosix(composerAbs)])
  /** Resolves an import/export/dynamic-import/require specifier to a FILE using the compiler's own
   *  resolution — `ts.resolveModuleName`, fed the SAME host K8's program uses, so a path alias
   *  (`@/*`) and a package.json "imports" subpath (`#foo`) resolve exactly as the real build would
   *  resolve them. Returns the resolved file as a posix path, or null when TS could not resolve it
   *  at all (an unresolvable specifier is never treated as a violation — silence, not a guess). */
  function resolveSpecifierToFile(specText: string, containingFile: string): string | null {
    const result = ts.resolveModuleName(specText, containingFile, options, host)
    const resolved = result.resolvedModule?.resolvedFileName
    return resolved ? toPosix(resolved) : null
  }
  function homeKindOfResolved(resolvedPosix: string): { home: string } | null {
    if (resolvedPosix === toPosix(listingPipelineAbs)) return { home: listingPipelineAbs }
    if (resolvedPosix === toPosix(composerAbs)) return { home: composerAbs }
    return null
  }
  /** Rules 1, 2, "export *", and the named-import/re-export half of rule 4 — all DECLARATION-level
   *  (refused regardless of whether anything downstream ever uses the binding), all resolved via
   *  the compiler rather than matched by specifier spelling. Only ever called for a non-home file
   *  (the home files' own sanctioned cross-imports are handled by K8's reference walk, exactly as
   *  before). Import/export declarations are always TOP-LEVEL, so `sf.statements` — never a
   *  recursive walk — is the complete and correct search space. */
  function checkModuleBoundaryDeclarations(sf: ts.SourceFile, rel: string): void {
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
        const resolved = resolveSpecifierToFile(stmt.moduleSpecifier.text, sf.fileName)
        const hit = resolved ? homeKindOfResolved(resolved) : null
        if (!hit) continue
        const clause = stmt.importClause
        if (!clause || clause.isTypeOnly) continue // side-effect-only, or `import type { ... }`
        const nb = clause.namedBindings
        if (nb && ts.isNamespaceImport(nb)) {
          if (!NAMESPACE_IMPORT_ALLOWLIST.includes(rel)) {
            violations.push(`${rel}: namespace-imports '${stmt.moduleSpecifier.text}' as ${nb.name.text} — resolved by the compiler to a restricted home module (${hit.home}); refused at the import declaration regardless of downstream use (not in the allowlist)`)
          }
        }
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue
            for (const name of RESTRICTED_NAMES) {
              if (homeAbsOf[name] !== hit.home) continue
              const target = declSymbols[name]
              // "under any local name": resolved via the SYMBOL the local binding aliases to, never
              // the text of the `as` clause — a rename does not change what it resolves to.
              if (target && resolvesToTarget(el.name, target)) {
                violations.push(`${rel}: imports '${name}'${el.propertyName ? ` (as ${el.name.text})` : ''} — resolved by the compiler to its home module (${hit.home}); route through the produce* wrapper instead`)
              }
            }
          }
        }
      }
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
        if (stmt.isTypeOnly) continue
        const resolved = resolveSpecifierToFile(stmt.moduleSpecifier.text, sf.fileName)
        const hit = resolved ? homeKindOfResolved(resolved) : null
        if (!hit) continue
        const clause = stmt.exportClause
        if (!clause) {
          violations.push(`${rel}: 'export * from ${JSON.stringify(stmt.moduleSpecifier.text)}' — resolved by the compiler to a restricted home module (${hit.home}); re-exports EVERY name, including its restricted ones`)
          continue
        }
        if (ts.isNamespaceExport(clause)) {
          violations.push(`${rel}: re-exports the WHOLE namespace of a restricted home module (${hit.home}) as ${clause.name.text} ('export * as ... from'), resolved by the compiler — refused regardless of whether anything downstream ever consumes it`)
          continue
        }
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue
          // A re-export's `propertyName`/`name` MUST be a name the SOURCE module actually exports —
          // since that source module is already confirmed to be a home file, a direct text match
          // against its five known export names is exact (no deeper symbol hop is needed the way
          // the named-IMPORT case above needs one for a possible local rename).
          const originalText = (el.propertyName ?? el.name).text
          if ((RESTRICTED_NAMES as readonly string[]).includes(originalText) && homeAbsOf[originalText as RestrictedName] === hit.home) {
            violations.push(`${rel}: re-exports '${originalText}'${el.propertyName ? ` (as ${el.name.text})` : ''} from '${stmt.moduleSpecifier.text}' — resolved by the compiler to its home module (${hit.home})`)
          }
        }
      }
      if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference) && ts.isStringLiteralLike(stmt.moduleReference.expression)) {
        const resolved = resolveSpecifierToFile(stmt.moduleReference.expression.text, sf.fileName)
        const hit = resolved ? homeKindOfResolved(resolved) : null
        if (hit) {
          violations.push(`${rel}: 'import ${stmt.name.text} = require(${JSON.stringify(stmt.moduleReference.expression.text)})' — resolved by the compiler to a restricted home module (${hit.home}); an import-equals require hands out the WHOLE namespace, refused regardless of downstream use`)
        }
      }
    }
  }
  /** True when `node` (an Identifier) sits in the callee position of a CallExpression whose only
   *  argument is a plain string literal — the one shape rule 3/the require value-use rule leaves
   *  alone; every other use of the identifier is refused regardless of what it resolves to. */
  function isDirectLiteralCallCallee(node: ts.Node): ts.CallExpression | null {
    const p = node.parent
    if (p && ts.isCallExpression(p) && p.expression === node && p.arguments.length === 1 && ts.isStringLiteralLike(p.arguments[0])) return p
    return null
  }
  function checkLiteralDynamicTarget(argText: string, containingFile: string, rel: string, kind: 'import' | 'require'): void {
    const resolved = resolveSpecifierToFile(argText, containingFile)
    const hit = resolved ? homeKindOfResolved(resolved) : null
    if (hit && !DYNAMIC_HOME_IMPORT_ALLOWLIST.includes(rel)) {
      violations.push(`${rel}: literal dynamic ${kind}('${argText}') of a restricted home module (${hit.home}), resolved by the compiler — refused outside the allowlist regardless of what is destructured`)
    }
  }

  const violations: string[] = []
  // RULING V1: "every non-node_modules, non-.d.ts source file IN THE PROGRAM, not only src/
  // rootNames" — the compiler pulls in any file it can resolve an import to, home-module or not,
  // inside `src/` or not (the z9/z9b "outside src/" shapes); scanning `program.getSourceFiles()`
  // instead of the narrower `rootNames` array is what makes those files reachable to the scanner at
  // all, with no change to which files become ROOTS (still `src/`, plus whatever a shape test adds).
  const scanSourceFiles = program.getSourceFiles().filter((f) => !/[\\/]node_modules[\\/]/.test(f.fileName) && !f.fileName.endsWith('.d.ts'))
  for (const sf of scanSourceFiles) {
    const file = sf.fileName
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
    const isHome = homeFilesPosix.has(file)
    if (!isHome) {
      violations.push(...structuralDynamicViolations(sf, rel))
      checkModuleBoundaryDeclarations(sf, rel)
    }
    const visit = (node: ts.Node): void => {
      // RULING V1, rule 3 (dynamic import) and the require/module.require/createRequire VALUE-USE
      // rule: a non-literal specifier, or any use of `require`/`module.require`/`createRequire`
      // other than a direct literal call, is refused ANYWHERE in the program (home-targeted or not
      // — its target cannot be statically bounded); a literal specifier that DOES resolve to a home
      // module is refused outside the allowlist. Placed in the SAME recursive walk K8 already runs
      // (these node kinds can appear anywhere, unlike an import/export declaration).
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
          if (!NON_LITERAL_DYNAMIC_IMPORT_ALLOWLIST.includes(rel)) {
            violations.push(`${rel}: dynamic import(...) has a NON-LITERAL specifier — refused anywhere in the program (not in the allowlist)`)
          }
        } else {
          checkLiteralDynamicTarget((node.arguments[0] as ts.StringLiteralLike).text, sf.fileName, rel, 'import')
        }
      }
      // A bare identifier `require` is skipped when it sits in PROPERTY-NAME position (`x.require`)
      // — that is not a value reference to Node's `require` at all (any object could happen to have
      // a property spelled that way); the ONE such combination that IS a real indirection risk,
      // `module.require`, is matched structurally below instead, by its own PropertyAccessExpression
      // shape, never by this identifier text alone.
      if (ts.isIdentifier(node) && node.text === 'require' && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        const directCall = isDirectLiteralCallCallee(node)
        if (directCall) {
          checkLiteralDynamicTarget((directCall.arguments[0] as ts.StringLiteralLike).text, sf.fileName, rel, 'require')
        } else {
          // Not the sanctioned `require('literal')` direct-call shape — assigned to a variable,
          // passed as an argument, called with zero/non-literal args, etc. Refused unconditionally;
          // its target cannot be statically bounded.
          violations.push(`${rel}: value use of 'require' other than a direct literal call is refused`)
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'require' && ts.isIdentifier(node.expression) && node.expression.text === 'module') {
        const directCall = isDirectLiteralCallCallee(node)
        if (directCall) {
          checkLiteralDynamicTarget((directCall.arguments[0] as ts.StringLiteralLike).text, sf.fileName, rel, 'require')
        } else {
          violations.push(`${rel}: value use of 'module.require' other than a direct literal call is refused`)
        }
      }
      if (ts.isIdentifier(node) && node.text === 'createRequire') {
        violations.push(`${rel}: value use of 'createRequire' is refused — its indirection cannot be statically bounded`)
      }
      // RULING P8: the KEY need not be a literal NODE — a `const K = '...' as const` used later
      // as `lp[K]` (N13) has an IDENTIFIER argument whose TYPE is the string-literal type.
      if (ts.isElementAccessExpression(node)) {
        const text = stringLiteralTypeValue(node.argumentExpression)
        if (text && (RESTRICTED_NAMES as readonly string[]).includes(text)) {
          const target = declSymbols[text]
          let matches = false
          if (target && ts.isStringLiteralLike(node.argumentExpression)) {
            const sym = checker.getSymbolAtLocation(node.argumentExpression)
            matches = !!sym && (sym === target || (sym.declarations ?? []).some((d) => (target.declarations ?? []).includes(d)))
          }
          if (!matches) {
            let obj: ts.Expression = node.expression
            while (ts.isAsExpression(obj) || ts.isParenthesizedExpression(obj)) obj = obj.expression
            if (ts.isIdentifier(obj) || ts.isPropertyAccessExpression(obj)) matches = resolvesToNamespaceOfHome(obj, 0)
          }
          if (matches) {
            violations.push(isHome
              ? `${rel}: bracket-access reference to '${text}' outside sanctioned function`
              : `${rel}: bracket-access reference to '${text}' outside its home module`)
          }
        }
      }
      // RULING P8: `Reflect.get(obj, 'name')` and any similarly-shaped generic helper call
      // (`pick(lp, 'buildItemHighlights')`) — a CALL whose arguments include BOTH a restricted
      // name (literal text OR string-literal TYPE, e.g. inferred through a `K extends keyof M`
      // generic parameter) AND a namespace/object of that name's home module. Parametrized over
      // every `RESTRICTED_NAMES` entry, not a case written for one probe string.
      if (ts.isCallExpression(node)) {
        for (const arg of node.arguments) {
          const text = stringLiteralTypeValue(arg)
          if (!text || !(RESTRICTED_NAMES as readonly string[]).includes(text)) continue
          const homeOfName = homeAbsOf[text as RestrictedName]
          const otherArgIsHomeNamespace = node.arguments.some((other) => {
            if (other === arg) return false
            let o: ts.Expression = other
            while (ts.isAsExpression(o) || ts.isParenthesizedExpression(o)) o = o.expression
            return (ts.isIdentifier(o) || ts.isPropertyAccessExpression(o)) && resolvesToNamespaceOfHome(o, 0)
          })
          if (otherArgIsHomeNamespace) {
            violations.push(`${rel}: call passes restricted name '${text}' as a key argument alongside a namespace/object of its home module (${homeOfName}) — outside its home module`)
          }
        }
      }
      if (ts.isIdentifier(node) && (RESTRICTED_NAMES as readonly string[]).includes(node.text)) {
        const parent = node.parent
        if (ts.isFunctionDeclaration(parent) && parent.name === node) { ts.forEachChild(node, visit); return }
        if (isTypeOnlyPosition(node)) { ts.forEachChild(node, visit); return }
        const target = declSymbols[node.text]
        if (target && resolvesToTarget(node, target)) {
          if (isHome && isImportBindingDecl(node)) { ts.forEachChild(node, visit); return }
          if (isHome) {
            const { sanctioned, name: encName } = enclosingFunctionIsSanctioned(node)
            if (!sanctioned) {
              violations.push(`${rel}: reference to '${node.text}' outside sanctioned function (found inside ${encName ?? 'top-level'})`)
            }
          } else {
            violations.push(`${rel}: reference to '${node.text}' outside its home module`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { violations, ms: Date.now() - t0 }
}

/** RULING W4 (fix round B7b): builds program inputs as an OVERLAY on the real tree instead of a
 *  filesystem copy (see `makeSharedHost` above for why) — optionally appending `homeAppend` text to
 *  one home file (to prove a new in-home bypass function goes RED) and/or adding one or more
 *  synthetic files at `extra` (relative to `src/`) (to prove an outside-file bypass goes RED —
 *  RULING Q3, fix round B6: a TWO-file shape, a barrel plus a route consuming it, needs more than one
 *  extra file at once). `listingPipelineAbs`/`composerAbs` are now the REAL tree's own absolute
 *  paths — the home-append overlay is keyed on that SAME path, so a mutated home file is still
 *  resolved, by every other real file's `@/lib/fba/...` import, to the ONE path the overlay covers.
 *  Nothing is ever written to disk; `cleanup` is a no-op kept only so every existing call site's
 *  `const { inputs, cleanup } = scratchCopy(...); try { ... } finally { cleanup() }` shape still
 *  compiles and runs unchanged. */
function scratchCopy(opts: { homeAppend?: { rel: 'pipeline' | 'composer'; text: string }; extra?: { relPath: string; content: string; notRoot?: boolean } | readonly { relPath: string; content: string; notRoot?: boolean }[]; packageJson?: Record<string, unknown> }): { inputs: EnumerationProgramInputs; cleanup: () => void } {
  const listingPipelineAbs = path.join(SRC_ROOT, 'lib/fba/listingPipeline.ts')
  const composerAbs = path.join(SRC_ROOT, 'lib/fba/itemHighlightComposer.ts')
  const overlay = new Map<string, string>()
  if (opts.homeAppend) {
    const targetAbs = opts.homeAppend.rel === 'pipeline' ? listingPipelineAbs : composerAbs
    const original = fs.readFileSync(targetAbs, 'utf8')
    overlay.set(toPosix(targetAbs), original + '\n' + opts.homeAppend.text)
  }
  const rootNames = getRealRootNamesCached()
  const extras = opts.extra ? (Array.isArray(opts.extra) ? opts.extra : [opts.extra]) : []
  for (const e of extras) {
    // A `relPath` starting with `../` (e.g. `../ihx/probe.ts`, the z9/z9b "outside src/" shapes)
    // escapes SRC_ROOT the same way a real relative import would — `path.join` resolves it, it is
    // never written to disk, and `makeSharedHost`'s overlay + `directoryExists` override (above)
    // serve it as if it existed there.
    const full = path.join(SRC_ROOT, e.relPath)
    overlay.set(toPosix(full), e.content)
    // `notRoot: true` (the z9/z9b "reached only by resolution" test) deliberately leaves this file
    // OUT of `rootNames` — the compiler must find it by resolving another root file's import, which
    // is exactly the "program.getSourceFiles(), not only rootNames" scope this round's ruling asks
    // for. Every OTHER extra (an inert barrel nothing imports) still needs the explicit root.
    if (!e.notRoot) rootNames.push(full)
  }
  // RULING V1 (fix round B8b, z10: a package.json "imports" subpath alias): overlay the REPO
  // ROOT's package.json with synthetic content (never written to disk, never touching the real
  // file) so `ts.resolveModuleName`'s bundler resolution — which walks UP from the importing file
  // looking for the nearest package.json's "imports" field — reads the synthetic one instead.
  if (opts.packageJson) {
    overlay.set(toPosix(path.join(process.cwd(), 'package.json')), JSON.stringify(opts.packageJson))
  }
  const inputs: EnumerationProgramInputs = { rootNames, options: REAL_OPTIONS, listingPipelineAbs, composerAbs, overlay }
  return { inputs, cleanup: () => {} }
}

describe('RULING K8: the enumeration test detects REFERENCES, not spellings (TypeScript compiler API)', () => {
  // ─── The 7 shapes the OLD (spelling-based) scanners already caught — proven RED again through
  // the NEW reference-resolution scanner, so K8 is additive, not a regression. ───────────────────
  const OUTSIDE_FILE_SHAPES: Record<string, string> = {
    plain: `
      import { buildItemHighlights } from '@/lib/fba/listingPipeline'
      export async function POST() { return buildItemHighlights({} as never) }
    `,
    alias: `
      import { buildItemHighlights as composeIh } from '@/lib/fba/listingPipeline'
      export async function POST() { return composeIh({} as never) }
    `,
    namespace: `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() { return lp.buildItemHighlights({} as never) }
    `,
    lower: `
      import { runIhTail } from '@/lib/fba/listingPipeline'
      import { composeItemHighlightDetailed } from '@/lib/fba/itemHighlightComposer'
      export async function POST() {
        const res = composeItemHighlightDetailed([], [], {} as never)
        return runIhTail(res.line ?? '', {} as never)
      }
    `,
    'lower-ns': `
      import * as pipeline from '@/lib/fba/listingPipeline'
      import * as composer from '@/lib/fba/itemHighlightComposer'
      export async function POST() {
        const res = composer.composeItemHighlightDetailed([], [], {} as never)
        return pipeline.runIhTail(res.line ?? '', {} as never)
      }
    `,
    dynamic: `
      export async function POST() {
        const { buildItemHighlights } = await import('@/lib/fba/listingPipeline')
        return buildItemHighlights({} as never)
      }
    `,
    // 8 MORE bypass shapes review B3 measured GREEN under the OLD scanners:
    nsdestructure: `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() {
        const { buildItemHighlights: b } = lp
        return b({} as never)
      }
    `,
    nsbracket: `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() {
        const lpAny = lp as any
        return lpAny['buildItemHighlights']({})
      }
    `,
    dynthen: `
      export async function POST() {
        const r1 = await import('@/lib/fba/itemHighlightComposer').then(({ composeItemHighlightDetailed: c }) => c)
        const r2 = await import('@/lib/fba/listingPipeline').then(({ runIhTail: t }) => t)
        return { r1, r2 }
      }
    `,
    requirecjs: `
      export function POST() {
        const { buildItemHighlights: b } = require('@/lib/fba/listingPipeline')
        return b({} as never)
      }
    `,
    // RULING P8 (fix round B5, wire Blocking 1): the 9 shapes review B4 measured GREEN under K8
    // itself — an `as any` bracket through a namespace import, a typed generic "pick" helper, an
    // object-capture bracket, `Reflect.get` (typed and untyped), and a constkey element access.
    // ("exportStarAs-anyBracket" MOVED OUT of this single-file map by RULING Q3, fix round B6 —
    // its own name names a TWO-file shape (a barrel's `export * as` plus a route consuming it
    // through an `any` bracket), which this map cannot express; see the dedicated test below.)
    'typed-pick': `
      import * as lp from '@/lib/fba/listingPipeline'
      function pick<M, K extends keyof M>(m: M, k: K): M[K] { return m[k] }
      export async function POST() {
        const fn = pick(lp, 'buildItemHighlights')
        return (fn as never)
      }
    `,
    'objcapture-anyBracket': `
      import * as lp from '@/lib/fba/listingPipeline'
      const holder = { mod: lp }
      export async function POST() {
        const holderAny = holder as any
        return holderAny.mod['buildItemHighlights']({})
      }
    `,
    'reflect-get': `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() {
        const fn = Reflect.get(lp, 'buildItemHighlights')
        return (fn as never)
      }
    `,
    'constkey-elementaccess': `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() {
        const K = 'buildItemHighlights' as const
        return (lp as never)[K]({} as never)
      }
    `,
  }
  for (const [name, content] of Object.entries(OUTSIDE_FILE_SHAPES)) {
    it(`sensitivity ("${name}") — an outside-file bypass goes RED in a scratch copy`, () => {
      const { inputs, cleanup } = scratchCopy({ extra: { relPath: `app/api/fba/probe-k8-${name}/route.ts`, content } })
      try {
        const { violations } = findEnumerationViolations(inputs)
        expect(violations.length, `"${name}" must be flagged`).toBeGreaterThan(0)
      } finally { cleanup() }
    })
  }

  // RULING Q3 (fix round B6, wire Blocking): the REAL "exportStarAs-anyBracket" shape — a barrel
  // file doing `export * as X from '<home>'`, and a SEPARATE route file importing that barrel's
  // alias and bracketing a restricted name through it via an `any` cast. The PRIOR pin under this
  // name (`itemHighlightWriterEnumeration.test.ts`, single-file, direct `import * as lpR7 ...`) was
  // a DIFFERENT shape entirely — a direct namespace import, already caught by the pre-existing
  // `declaresNamespaceOfHome` branch BEFORE the alias-hop loop this pin was written for ever runs
  // (the `test-proves-the-mock` class). This pin is the two-file shape.
  //
  // RULING W2 (fix round B7b, wire Important) MUTATION RECORD, re-measured against the CURRENT
  // `getImmediateAliasedSymbol`-based loop (the prior claim here — "asserts it fails WITHOUT the
  // alias-hop loop too... reported in the round's own verification" — was false; review B6/wire §1a
  // proved no such verification existed, and the OLD `getAliasedSymbol` loop was provably dead: it
  // resolved the whole chain in one call and only ever passed via the `typeSym` path below it):
  //   M0 control (no mutation)                                          -> PASS (detects it)
  //   M1 loop no-op'd (`while (false && aliasSym...)`)                   -> STILL PASSES
  //   M2 `typeSym` check disabled (`if (false && typeSym...)`)           -> STILL PASSES
  //   M3 BOTH M1 and M2                                                  -> FAILS (goes RED)
  //   M4 the SourceFile-declaration clause alone disabled                -> STILL PASSES
  // M1 and M2 each independently still pass because `getImmediateAliasedSymbol` now hops ONE alias
  // at a time: for this shape, hop 1 lands directly on the barrel's `export * as lpR7 from '<home>'`
  // NamespaceExport declaration and returns true THERE, never needing the SourceFile clause at all —
  // a second, genuinely independent path alongside `typeSym`'s own route to the same clause. That is
  // also why M4 no longer fails as it did under the old code: detection here no longer depends on the
  // SourceFile clause being present. Only removing BOTH paths (M3) leaves nothing to catch the shape.
  it('sensitivity ("exportStarAs-anyBracket", REAL two-file shape) — a barrel\'s `export * as X from home` consumed through an `any` bracket in a SEPARATE file goes RED', () => {
    const { inputs, cleanup } = scratchCopy({
      extra: [
        { relPath: 'lib/fba/r7BarrelProbe.ts', content: `export * as lpR7 from '@/lib/fba/listingPipeline'\n` },
        {
          relPath: 'app/api/fba/probe-k8-exportStarAs-anyBracket/route.ts',
          content: `
            import { lpR7 } from '@/lib/fba/r7BarrelProbe'
            export async function POST() {
              const lpAny = lpR7 as any
              return lpAny['buildItemHighlights']({})
            }
          `,
        },
      ],
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `"exportStarAs-anyBracket" (real shape) must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // RULING P8 (fix round B5, wire Blocking 1, "reflect-typed"/N8b): the SAME Reflect.get mechanism
  // with NO cast at all — TS types `Reflect.get`'s return precisely, so this is the "fully typed,
  // no `any`" variant of the shape above.
  it('sensitivity ("reflect-typed") — Reflect.get with no cast at all goes RED in a scratch copy', () => {
    const content = `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() {
        return Reflect.get(lp, 'buildItemHighlights')
      }
    `
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'app/api/fba/probe-k8-reflect-typed/route.ts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, 'reflect-typed must be flagged').toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // RULING P8 ("js-route"/N10): a plain-JS App Router route — `tsconfig.json` has `allowJs: true`
  // and Next compiles `.js` routes, so a `.ts`/`.tsx`-only scan never opened this file at all.
  it('sensitivity ("js-route") — a plain .js route file goes RED (extension scan, N10)', () => {
    const content = `
      import { buildItemHighlights } from '@/lib/fba/listingPipeline'
      export async function POST() { return buildItemHighlights({}) }
    `
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'app/api/fba/probe-k8-js-route/route.js', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, 'js-route must be flagged').toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // RULING P8 ("mts-helper"/N11): `tsconfig.json`'s own `include` has `"**/*.mts"`.
  it('sensitivity ("mts-helper") — a .mts helper wrapping the builder goes RED (extension scan, N11)', () => {
    const content = `
      import { buildItemHighlights } from '@/lib/fba/listingPipeline'
      export function wrap(input: never) { return buildItemHighlights(input) }
    `
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/probeK8Helper.mts', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, 'mts-helper must be flagged').toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // "barrel" (a re-export in a helper, then consumed by a real filename): the restricted name is
  // written once, at the re-export site — that is where the NEW scanner (an Identifier reference,
  // exactly like any other) flags it, matching the existing `findReExportBypass` scanner's own
  // documented behaviour.
  it('sensitivity ("barrel") — a re-export of a restricted name in a helper file goes RED at the re-export site', () => {
    const { inputs, cleanup } = scratchCopy({
      extra: { relPath: 'app/api/fba/probe-k8-barrel/helper.ts', content: `export { buildItemHighlights as buildIh } from '@/lib/fba/listingPipeline'` },
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.some((v) => v.includes('buildItemHighlights')), JSON.stringify(violations)).toBe(true)
    } finally { cleanup() }
  })

  // ─── The 4 IN-HOME shapes (a new branch/alias inside listingPipeline.ts/itemHighlightComposer.ts
  // itself) the OLD scanners missed entirely, because their import/namespace/re-export/dynamic
  // scanners blanket-exempt "the whole file is listingPipeline.ts" and the OLD call scanner only
  // ever tracked the two BUILDER names, never the composer's two names or `runIhTail`. ───────────
  const HOME_SHAPES: Record<string, { rel: 'pipeline' | 'composer'; text: string }> = {
    'pipeline-lower': {
      rel: 'pipeline',
      text: `
export function k8BypassPipelineLower(input: unknown) {
  const res = composeItemHighlightDetailed([], [], {} as never)
  return runIhTail(res.line ?? '', {} as never)
}
`,
    },
    'pipeline-ref': {
      rel: 'pipeline',
      text: `
export function k8BypassPipelineRef(input: never) {
  const build = buildItemHighlights
  return build(input)
}
`,
    },
    'pipeline-alias': { rel: 'pipeline', text: `export const k8BypassPipelineAlias = buildItemHighlights\n` },
    'composer-alias': { rel: 'composer', text: `export const k8BypassComposerAlias = composeItemHighlightDetailed\n` },
    // RULING P8 (fix round B5, wire Blocking 1, N1 "nested-shadow"): a NESTED declaration merely
    // BEARING a sanctioned name — `enclosingFunctionIsSanctioned` must resolve by DECLARATION
    // IDENTITY (this nested function's own distinct symbol), never by `.name.text`.
    'nested-shadow': {
      rel: 'pipeline',
      text: `
export function k8BypassN1Outer(input: unknown) {
  function produceItemHighlights() {
    const res = composeItemHighlightDetailed([], [], {} as never)
    return runIhTail(res.line ?? '', {} as never)
  }
  return produceItemHighlights()
}
`,
    },
    // RULING P8 (N2 "local-sanctioned-name"): a NEW top-level declaration bearing a sanctioned
    // NAME but living in the WRONG home file — a different symbol from the real
    // `composeItemHighlight` (declared in the composer), even though the name is identical.
    'local-sanctioned-name': {
      rel: 'pipeline',
      text: `
export function composeItemHighlight(pool: unknown, titles: string[]) {
  const res = composeItemHighlightDetailed(pool as never, titles, {} as never)
  return runIhTail(res.line ?? '', {} as never)
}
`,
    },
  }
  for (const [name, shape] of Object.entries(HOME_SHAPES)) {
    it(`sensitivity ("${name}") — a new bypass inside the HOME file itself goes RED`, () => {
      const { inputs, cleanup } = scratchCopy({ homeAppend: shape })
      try {
        const { violations } = findEnumerationViolations(inputs)
        expect(violations.length, `"${name}" must be flagged`).toBeGreaterThan(0)
      } finally { cleanup() }
    })
  }

  // ─── The REAL tree: zero violations, real functions only, runtime reported (never silently
  // raised if it exceeds 60s — RULING K8's own instruction). ───────────────────────────────────
  it('the REAL tree has ZERO reference-level violations (report the runtime)', () => {
    const { violations, ms } = findEnumerationViolations(realTreeInputs())
    // eslint-disable-next-line no-console
    console.log(`[K8] findEnumerationViolations over the real tree: ${ms}ms${ms > 60_000 ? ' — EXCEEDS 60s' : ''}`)
    expect(violations, JSON.stringify(violations)).toEqual([])
  }, 120_000)
})
