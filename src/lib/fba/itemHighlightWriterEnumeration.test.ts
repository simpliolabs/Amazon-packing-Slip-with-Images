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
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

/** The REAL tree's program inputs — used by the "real tree" completeness test below. */
function realTreeInputs(): EnumerationProgramInputs {
  return {
    rootNames: listTsFilesFlat(SRC_ROOT),
    options: { ...BASE_COMPILER_OPTIONS, baseUrl: process.cwd(), paths: { '@/*': ['./src/*'] } },
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
  const program = ts.createProgram({ rootNames, options })
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
    // RULING Q3 (fix round B6, wire Blocking, "X1"): a SHORTHAND property (`{ buildItemHighlights }`
    // inside an object literal — a dispatch table: `const t = { buildItemHighlights }` then
    // `t.buildItemHighlights(i)`) resolves its NAME node to the object literal's OWN property
    // symbol (declared by the ShorthandPropertyAssignment itself), never to the function it pulls
    // its VALUE from — `getSymbolAtLocation` alone therefore always misses it, no matter how the
    // alias chain below is walked. `getShorthandAssignmentValueSymbol` is the checker's OWN API for
    // exactly this: "what does this shorthand's implicit value reference resolve to".
    if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
      const valueSym = checker.getShorthandAssignmentValueSymbol(node.parent)
      if (valueSym === target || (valueSym?.declarations ?? []).some((d) => (target.declarations ?? []).includes(d))) return true
    }
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
        let flagged = !!home && home !== sf.fileName
        // RULING Q3 (fix round B6, wire Blocking, "X7"): CLOSE THE CLASS beyond require/dynamic-
        // import literal specifiers — destructuring directly from a namespace-of-home reference
        // reached through ANY cast/alias chain (`const { buildItemHighlights: b } = lp as any`)
        // is the SAME shape, just a different source expression. Structural, via the SAME
        // `resolvesToNamespaceOfHome` the bracket-access checker below already uses.
        if (!flagged) {
          let stripped: ts.Expression = init
          while (ts.isAsExpression(stripped) || ts.isParenthesizedExpression(stripped) || ts.isNonNullExpression(stripped)) stripped = stripped.expression
          if ((ts.isIdentifier(stripped) || ts.isPropertyAccessExpression(stripped)) && resolvesToNamespaceOfHome(stripped, 0)) flagged = true
        }
        if (flagged) {
          for (const el of (node.name as ts.ObjectBindingPattern).elements) {
            const propName = el.propertyName ?? el.name
            if (ts.isIdentifier(propName) && (RESTRICTED_NAMES as readonly string[]).includes(propName.text)) {
              out.push(`${rel}: destructures restricted name '${propName.text}'${spec ? ` from '${spec}'` : ' from a namespace-of-home reference'} outside its home module`)
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
  /** RULING Q3 (fix round B6, wire Blocking): does barrel FILE `barrelSf`, at its TOP LEVEL,
   *  contain a wildcard re-export (`export * from '<home>'`, no namespace binding at all) whose
   *  specifier targets home? Used to extend a namespace import of an INTERMEDIATE barrel ("X2",
   *  `import * as ns from './barrel'` where `barrel.ts` says `export * from '<home>'`) — every one
   *  of `ns`'s properties for a home export name IS that home export's own symbol, so `ns` is
   *  namespace-of-home too, even though `ns`'s OWN import specifier names the barrel, not home. */
  function barrelHasWildcardReexportOfHome(barrelSf: ts.SourceFile): boolean {
    for (const stmt of barrelSf.statements) {
      if (ts.isExportDeclaration(stmt) && !stmt.exportClause && stmt.moduleSpecifier
        && specifierTargetsHome(stmt.moduleSpecifier.getText().replace(/^['"]|['"]$/g, ''))) return true
    }
    return false
  }
  function resolvesToNamespaceOfHome(idNode: ts.Node, depth: number): boolean {
    if (depth > 5) return false
    let node: ts.Node = idNode
    while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression
    // RULING Q3 (fix round B6, wire Blocking): CLOSE THE CLASS, not the six cases — treat an
    // expression as reaching home whenever the CHECKER's own TYPE for it IS, or is aliased to, a
    // home module's namespace type (every module's type-symbol declaration is its OWN SourceFile).
    // This alone closes X3 (`const m = await import(home)` — TS types the awaited value as
    // `typeof import(home)` precisely) and X9 (a two-hop barrel re-export preserves the namespace
    // TYPE across both hops even where the alias-SYMBOL chain might not), with no shape-specific
    // code for either.
    const nodeType = checker.getTypeAtLocation(node)
    const typeSym = nodeType.getSymbol() ?? nodeType.aliasSymbol
    if (typeSym && (typeSym.declarations ?? []).some((d) => ts.isSourceFile(d) && homeFiles.has(d.fileName))) return true
    const origSym = checker.getSymbolAtLocation(node)
    /** Checks ONE symbol's own declarations for a namespace-of-home shape — never the fully
     *  alias-unwrapped TARGET, which for a plain `import * as X from home` skips PAST the
     *  `NamespaceImport` node straight to the module symbol (whose declaration is the SourceFile,
     *  not a NamespaceImport) and would wrongly report false. */
    const declaresNamespaceOfHome = (sym: ts.Symbol | undefined): boolean => {
      for (const d of sym?.declarations ?? []) {
        if (ts.isNamespaceImport(d)) {
          const spec = (d.parent.parent as ts.ImportDeclaration).moduleSpecifier.getText().replace(/^['"]|['"]$/g, '')
          if (specifierTargetsHome(spec)) return true
          // RULING Q3 ("X2", plain `export * from` barrel behind a namespace import): the
          // namespace import targets an INTERMEDIATE local barrel, not home directly — check
          // whether that barrel's OWN file wildcard-re-exports home.
          const importSym = checker.getSymbolAtLocation((d.parent.parent as ts.ImportDeclaration).moduleSpecifier)
          for (const bd of importSym?.declarations ?? []) {
            if (ts.isSourceFile(bd) && barrelHasWildcardReexportOfHome(bd)) return true
          }
        }
        // `export * as X from '<home>'` — the barrel's OWN re-export declaration (N3b).
        if (ts.isNamespaceExport(d) && ts.isExportDeclaration(d.parent) && d.parent.moduleSpecifier
          && specifierTargetsHome(d.parent.moduleSpecifier.getText().replace(/^['"]|['"]$/g, ''))) return true
      }
      return false
    }
    if (declaresNamespaceOfHome(origSym)) return true
    // RULING P8 (N3b "exportStarAs"): walk the ALIAS chain ONE HOP AT A TIME, checking EACH
    // intermediate symbol — an import specifier bound through a barrel's `export * as X from
    // '<home>'` is an alias whose FIRST unwrap lands on the barrel's re-export symbol (a
    // NamespaceExport declaration); unwrapping ALL THE WAY to the final module symbol (as a
    // single `while` loop before any check would do) skips past that node entirely.
    let aliasSym = origSym
    const seenAlias = new Set<ts.Symbol>()
    while (aliasSym && (aliasSym.flags & ts.SymbolFlags.Alias) && !seenAlias.has(aliasSym)) {
      seenAlias.add(aliasSym)
      try { aliasSym = checker.getAliasedSymbol(aliasSym) } catch { break }
      if (declaresNamespaceOfHome(aliasSym)) return true
    }
    for (const d of origSym?.declarations ?? []) {
      if (ts.isVariableDeclaration(d) && d.initializer) {
        let init: ts.Expression = d.initializer
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isNonNullExpression(init)) init = init.expression
        if ((ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) && resolvesToNamespaceOfHome(init, depth + 1)) return true
        // RULING Q3 ("X5", a namespace passed THROUGH a helper call whose declared return type
        // WIDENS it, e.g. `function asMap(m: unknown): Record<string,unknown> { return m as any }`
        // then `const m = asMap(lp)`): the TYPE-based check above cannot see through the widened
        // return type, so follow the CALL's own ARGUMENTS structurally instead — conservative
        // (never proves the function forwards the value, only that it COULD), exactly the
        // "structural, never a spelling regex" discipline this file already uses for require/
        // dynamic-import destructuring.
        if (ts.isCallExpression(init) && init.arguments.some((a) => resolvesToNamespaceOfHome(a, depth + 1))) return true
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

  /** RULING Q3 (fix round B6, wire Blocking, "X6"): `Object.entries(lp).find(([k]) => k ===
   *  'buildItemHighlights')` puts the restricted name in a BinaryExpression, never as a call
   *  argument or an element-access key — neither `stringLiteralTypeValue`'s callers nor
   *  `resolvesToNamespaceOfHome`'s own callers see it. Detected STRUCTURALLY: an enumeration call
   *  (`Object.entries`/`.keys`/`.values`/`.getOwnPropertyNames`, `Reflect.ownKeys`) whose argument
   *  resolves to a namespace-of-home, combined ANYWHERE in the same enclosing STATEMENT with a
   *  restricted-name string literal compared via `==`/`===`/`!=`/`!==` — the general shape "read
   *  this home module's own key names and test one against a restricted name", not a case written
   *  for this one probe string. */
  function objectKeysEnumerationViolations(sf: ts.SourceFile, rel: string): string[] {
    const out: string[] = []
    const EQUALITY_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ])
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 1) {
        const callee = node.expression
        const ownerText = ts.isIdentifier(callee.expression) ? callee.expression.text : null
        const methodName = callee.name.text
        const isEnumCall = (ownerText === 'Object' && ['entries', 'keys', 'values', 'getOwnPropertyNames'].includes(methodName))
          || (ownerText === 'Reflect' && methodName === 'ownKeys')
        if (isEnumCall) {
          let arg: ts.Expression = node.arguments[0]
          while (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg)) arg = arg.expression
          if ((ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) && resolvesToNamespaceOfHome(arg, 0)) {
            let stmt: ts.Node = node
            while (stmt.parent && !ts.isStatement(stmt)) stmt = stmt.parent
            const scan = (n: ts.Node): void => {
              if (ts.isBinaryExpression(n) && EQUALITY_OPS.has(n.operatorToken.kind)) {
                for (const side of [n.left, n.right]) {
                  if (ts.isStringLiteralLike(side) && (RESTRICTED_NAMES as readonly string[]).includes(side.text)) {
                    out.push(`${rel}: enumerates a namespace-of-home object's keys (${ownerText}.${methodName}) and compares one to restricted name '${side.text}' — outside its home module`)
                  }
                }
              }
              ts.forEachChild(n, scan)
            }
            scan(stmt)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  const violations: string[] = []
  for (const file of rootNames) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
    const isHome = homeFiles.has(file)
    if (!isHome) violations.push(...structuralDynamicViolations(sf, rel))
    if (!isHome) violations.push(...objectKeysEnumerationViolations(sf, rel))
    const visit = (node: ts.Node): void => {
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

/** Copies `SRC_ROOT` into a fresh scratch temp dir (never inside the repo — RULING K8's own
 *  "scratch COPY" instruction), optionally appending `homeAppend` text to one home file (to prove a
 *  new in-home bypass function goes RED) and/or adding one or more synthetic files (`extra`, or
 *  `extraFiles` for a genuine MULTI-FILE shape — RULING Q3, fix round B6: the real `export * as X
 *  from '<home>'` barrel shape needs a SEPARATE barrel file plus a route that imports the alias, not
 *  one file pretending to be both) at a path relative to `src/`. Returns program inputs pointed at
 *  the COPY, and a cleanup function. The real tree is NEVER written. */
function scratchCopy(opts: {
  homeAppend?: { rel: 'pipeline' | 'composer'; text: string }
  extra?: { relPath: string; content: string }
  extraFiles?: { relPath: string; content: string }[]
}): { inputs: EnumerationProgramInputs; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihw-enum-k8-'))
  const copyRoot = path.join(dir, 'src')
  fs.cpSync(SRC_ROOT, copyRoot, { recursive: true })
  if (opts.homeAppend) {
    const target = path.join(copyRoot, opts.homeAppend.rel === 'pipeline' ? 'lib/fba/listingPipeline.ts' : 'lib/fba/itemHighlightComposer.ts')
    fs.appendFileSync(target, '\n' + opts.homeAppend.text)
  }
  const rootNames = listTsFilesFlat(copyRoot)
  const allExtra = [...(opts.extra ? [opts.extra] : []), ...(opts.extraFiles ?? [])]
  for (const e of allExtra) {
    const full = path.join(copyRoot, e.relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, e.content)
    rootNames.push(full)
  }
  const inputs: EnumerationProgramInputs = {
    rootNames,
    options: { ...BASE_COMPILER_OPTIONS, baseUrl: dir, paths: { '@/*': ['./src/*'] } },
    listingPipelineAbs: path.join(copyRoot, 'lib/fba/listingPipeline.ts'),
    composerAbs: path.join(copyRoot, 'lib/fba/itemHighlightComposer.ts'),
  }
  return { inputs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
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
    // RULING Q3 (fix round B6, wire Blocking): `exportStarAs-anyBracket` used to live HERE as a
    // single-file `import * as lpR7` — a PLAIN namespace import, not `export * as`, already caught
    // by `declaresNamespaceOfHome`'s pre-existing branch, so the alias-hop loop this shape was
    // named for was never exercised (`test-proves-the-mock`, again). Moved to its own dedicated
    // TWO-FILE test below (a real barrel + a route consuming its alias), which `extraFiles` can now
    // express.
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
    // RULING Q3 (fix round B6, wire Blocking): the 6 "new (r8/B5)" shapes review B5 measured GREEN
    // under K8 itself (§1 of that review). Reproduced VERBATIM from the reviewer's own probe files
    // (`.../scratchpad/writer/r8-wire/shapes/`), never re-typed loosely.
    'awaitimport-anyBracket': `
      export async function POST() {
        const m = await import('@/lib/fba/listingPipeline')
        const fn = (m as any)['buildItemHighlights'] as (i: never) => unknown
        return fn({} as never)
      }
    `,
    'concat-key': `
      import * as lp from '@/lib/fba/listingPipeline'
      const K = 'buildItem' + 'Highlights'
      export async function POST() {
        const fn = (lp as any)[K] as (i: never) => unknown
        return fn({} as never)
      }
    `,
    'cast-through-function': `
      import * as lp from '@/lib/fba/listingPipeline'
      function asMap(m: unknown): Record<string, (i: never) => unknown> {
        return m as Record<string, (i: never) => unknown>
      }
      const map = asMap(lp)
      export async function POST() { return map['buildItemHighlights']({} as never) }
    `,
    'entries-find': `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() {
        const entry = Object.entries(lp).find(([k]) => k === 'buildItemHighlights')
        const fn = entry?.[1] as unknown as (i: never) => unknown
        return fn({} as never)
      }
    `,
    'any-destructure': `
      import * as lp from '@/lib/fba/listingPipeline'
      const { buildItemHighlights: b } = lp as any
      export async function POST() { return (b as (i: never) => unknown)({} as never) }
    `,
    // RULING Q3 ("X11", already RED at HEAD — reproduced here for the acceptance's own "all 11 go
    // RED" instruction, never removed just because it was already caught).
    'optional-chain': `
      import * as lp from '@/lib/fba/listingPipeline'
      export async function POST() { return lp?.buildItemHighlights?.({} as never) }
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

  // RULING Q3 (fix round B6, wire Blocking): the REAL `exportStarAs-anyBracket` shape — a genuine
  // TWO-FILE barrel (`export * as X from '<home>'`) plus a route that imports the barrel's alias and
  // brackets it through `as any`. The OLD pin (a single-file `import * as lpR7`) was never this
  // shape at all — it was a PLAIN namespace import, already caught by `declaresNamespaceOfHome`
  // before the alias-hop loop this fix round added was ever reached. This shape's own barrel file
  // resolves `lpR7`'s declaration to a `NamespaceExport` node (`export * as lpR7 from ...`), which
  // `declaresNamespaceOfHome`'s FIRST check (looking only for `NamespaceImport`) does NOT match —
  // only the alias-hop loop's `NamespaceExport` branch does, so this pin actually exercises it.
  it('sensitivity ("exportStarAs-anyBracket", the REAL two-file shape) — a barrel `export * as X` consumed through `as any` goes RED', () => {
    const barrel = `export * as lpR7 from '@/lib/fba/listingPipeline'`
    const route = `
      import { lpR7 } from '../../../../lib/fba/probe-k8-exportStarAs-anyBracket-barrel'
      export async function POST() {
        const lpAny = lpR7 as any
        return lpAny['buildItemHighlights']({})
      }
    `
    const { inputs, cleanup } = scratchCopy({
      extraFiles: [
        { relPath: 'lib/fba/probe-k8-exportStarAs-anyBracket-barrel.ts', content: barrel },
        { relPath: 'app/api/fba/probe-k8-exportStarAs-anyBracket/route.ts', content: route },
      ],
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `real exportStarAs-anyBracket must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // Proves the pin above actually exercises the alias-hop loop, per the ruling's own instruction
  // ("confirm it goes RED, and that it FAILS if the alias-hop loop is removed"): re-running
  // `declaresNamespaceOfHome`'s FIRST check ALONE (no alias-hop) against the SAME barrel-declared
  // symbol must NOT see it — proving the loop, not the direct check, is what catches this shape.
  it('the exportStarAs-anyBracket pin is NOT caught by the direct (non-alias-hop) NamespaceImport/NamespaceExport check alone — proving the alias-hop loop is load-bearing for it', () => {
    const barrel = `export * as lpR7 from '@/lib/fba/listingPipeline'`
    const route = `
      import { lpR7 } from '../../../../lib/fba/probe-k8-exportStarAs-anyBracket-barrel2'
      export async function POST() {
        const lpAny = lpR7 as any
        return lpAny['buildItemHighlights']({})
      }
    `
    const { inputs, cleanup } = scratchCopy({
      extraFiles: [
        { relPath: 'lib/fba/probe-k8-exportStarAs-anyBracket-barrel2.ts', content: barrel },
        { relPath: 'app/api/fba/probe-k8-exportStarAs-anyBracket2/route.ts', content: route },
      ],
    })
    try {
      const program = ts.createProgram({ rootNames: inputs.rootNames, options: inputs.options })
      const checker = program.getTypeChecker()
      const routeSf = program.getSourceFile(inputs.rootNames.find((f) => f.includes('probe-k8-exportStarAs-anyBracket2'))!)!
      let importedIdentifier: ts.Identifier | null = null
      const findImport = (n: ts.Node): void => {
        if (ts.isImportSpecifier(n) && n.name.text === 'lpR7') importedIdentifier = n.name
        ts.forEachChild(n, findImport)
      }
      findImport(routeSf)
      expect(importedIdentifier).not.toBeNull()
      const sym = checker.getSymbolAtLocation(importedIdentifier!)
      // The DIRECT (non-alias-hop) check: does `sym` ITSELF declare a NamespaceImport/NamespaceExport
      // of the home module? An import SPECIFIER's own symbol is an ALIAS symbol whose declaration is
      // the ImportSpecifier node, never a NamespaceImport/NamespaceExport — only unwrapping the alias
      // (the loop) reaches the barrel's `export * as` declaration.
      const directlyDeclaresNamespace = (sym?.declarations ?? []).some((d) => ts.isNamespaceImport(d) || ts.isNamespaceExport(d))
      expect(directlyDeclaresNamespace, 'the import specifier symbol itself must NOT directly declare the namespace — only the alias-hop loop reaches it').toBe(false)
    } finally { cleanup() }
  })

  // RULING Q3 (fix round B6, wire Blocking, "X2"): a PLAIN `export * from '<home>'` barrel (no
  // namespace binding at all — every home export is forwarded flattened) consumed via a namespace
  // import of the BARREL, bracketed through `as any`. Caught only by the OLD `findReExportBypass`
  // spelling scanner before this round; `barrelHasWildcardReexportOfHome` closes it in K8 itself.
  it('sensitivity ("starexport-barrel-anyBracket") — a plain `export * from` barrel behind a namespace import + any-bracket goes RED', () => {
    const barrel = `export * from '@/lib/fba/listingPipeline'`
    const route = `
      import * as barrelNs from '../../../../lib/fba/probe-k8-starexport-barrel'
      export async function POST() {
        const anyNs = barrelNs as any
        return anyNs['buildItemHighlights']({})
      }
    `
    const { inputs, cleanup } = scratchCopy({
      extraFiles: [
        { relPath: 'lib/fba/probe-k8-starexport-barrel.ts', content: barrel },
        { relPath: 'app/api/fba/probe-k8-starexport-barrel-route/route.ts', content: route },
      ],
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `starexport-barrel-anyBracket must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
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

  // RULING Q3 (fix round B6, wire Blocking, "X8", already RED at HEAD — reproduced for the
  // acceptance's own "all 11 go RED" instruction): a `.mjs` helper, the SAME extension-scan class
  // as "mts-helper" above.
  it('sensitivity ("mjs-helper") — a .mjs helper wrapping the builder goes RED (extension scan)', () => {
    const content = `
      import { buildItemHighlights } from '@/lib/fba/listingPipeline'
      export function r8MjsWrap(input) { return buildItemHighlights(input) }
    `
    const { inputs, cleanup } = scratchCopy({ extra: { relPath: 'lib/fba/probeK8Helper.mjs', content } })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, 'mjs-helper must be flagged').toBeGreaterThan(0)
    } finally { cleanup() }
  })

  // RULING Q3 (fix round B6, wire Blocking, "X9"): a TWO-HOP barrel — `barrel1` does `export * as
  // inner from '<home>'`, `barrel2` does a PLAIN named re-export (`export { inner } from barrel1`),
  // and the route imports `inner` from barrel2 and brackets it through `as any`. The TYPE-based
  // check in `resolvesToNamespaceOfHome` closes this: `inner`'s TYPE (not its alias-symbol chain)
  // is `typeof import('<home>')` across both re-export hops.
  it('sensitivity ("twohop-barrel-anyBracket") — a barrel re-exporting ANOTHER barrel\'s `export * as` alias goes RED', () => {
    const barrel1 = `export * as inner from '@/lib/fba/listingPipeline'`
    const barrel2 = `export { inner } from './probe-k8-x9-barrel1'`
    const route = `
      import { inner } from '../../../../lib/fba/probe-k8-x9-barrel2'
      export async function POST() {
        const fn = (inner as any)['buildItemHighlights'] as (i: never) => unknown
        return fn({} as never)
      }
    `
    const { inputs, cleanup } = scratchCopy({
      extraFiles: [
        { relPath: 'lib/fba/probe-k8-x9-barrel1.ts', content: barrel1 },
        { relPath: 'lib/fba/probe-k8-x9-barrel2.ts', content: barrel2 },
        { relPath: 'app/api/fba/probe-k8-x9-route/route.ts', content: route },
      ],
    })
    try {
      const { violations } = findEnumerationViolations(inputs)
      expect(violations.length, `twohop-barrel-anyBracket must be flagged: ${JSON.stringify(violations)}`).toBeGreaterThan(0)
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
    // RULING Q3 (fix round B6, wire Blocking, "X1"): a SHORTHAND dispatch table INSIDE the home
    // file itself — `const t = { buildItemHighlights }` then `t.buildItemHighlights(i)` — was
    // caught only by the OLDER spelling scanners (a bare `buildItemHighlights(` call regex), never
    // by K8 itself, because the shorthand's symbol is the object literal's OWN property, not the
    // function. `resolvesToTarget`'s new `getShorthandAssignmentValueSymbol` branch closes it.
    'home-shorthand-table': {
      rel: 'pipeline',
      text: `
const k8X1Table = { buildItemHighlights }
export function k8BypassX1(input: Parameters<typeof buildItemHighlights>[0]) {
  return k8X1Table.buildItemHighlights(input)
}
`,
    },
    // RULING Q3 ("X10", already RED at HEAD — reproduced for the acceptance's own "all 11 go RED"
    // instruction): a GETTER returning the builder — no `FunctionDeclaration` encloses the
    // reference at all, only an accessor.
    'home-getter': {
      rel: 'pipeline',
      text: `
export const k8X10Holder = { get build() { return buildItemHighlights } }
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
