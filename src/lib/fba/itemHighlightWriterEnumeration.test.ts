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

function listTsFilesFlat(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...listTsFilesFlat(full)); continue }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
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

  function findDeclSymbol(name: RestrictedName): ts.Symbol | null {
    const sf = program.getSourceFile(homeAbsOf[name])
    if (!sf) return null
    let found: ts.Symbol | null = null
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        const sym = checker.getSymbolAtLocation(node.name)
        if (sym) found = sym
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
  }
  const declSymbols: Record<string, ts.Symbol | null> = {}
  for (const name of RESTRICTED_NAMES) declSymbols[name] = findDeclSymbol(name)

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
  function enclosingFunctionName(node: ts.Node): string | null {
    let cur: ts.Node | undefined = node
    while (cur) {
      if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text
      cur = cur.parent
    }
    return null
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
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }
  /** `obj['buildItemHighlights'](...)` — bracket-string element access, traced back through
   *  `as any` casts and local re-assignment to a namespace import of a restricted home module. */
  function resolvesToNamespaceOfHome(idNode: ts.Node, depth: number): boolean {
    if (depth > 5) return false
    const objSym = checker.getSymbolAtLocation(idNode)
    for (const d of objSym?.declarations ?? []) {
      if (ts.isNamespaceImport(d) && specifierTargetsHome((d.parent.parent as ts.ImportDeclaration).moduleSpecifier.getText().replace(/^['"]|['"]$/g, ''))) return true
      if (ts.isVariableDeclaration(d) && d.initializer) {
        let init: ts.Expression = d.initializer
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isNonNullExpression(init)) init = init.expression
        if (ts.isIdentifier(init) && resolvesToNamespaceOfHome(init, depth + 1)) return true
      }
    }
    return false
  }

  const violations: string[] = []
  for (const file of rootNames) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
    const isHome = homeFiles.has(file)
    if (!isHome) violations.push(...structuralDynamicViolations(sf, rel))
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        && (RESTRICTED_NAMES as readonly string[]).includes(node.argumentExpression.text)) {
        const text = node.argumentExpression.text
        const target = declSymbols[text]
        let matches = false
        if (target) {
          const sym = checker.getSymbolAtLocation(node.argumentExpression)
          matches = !!sym && (sym === target || (sym.declarations ?? []).some((d) => (target.declarations ?? []).includes(d)))
        }
        if (!matches) {
          let obj: ts.Expression = node.expression
          while (ts.isAsExpression(obj) || ts.isParenthesizedExpression(obj)) obj = obj.expression
          if (ts.isIdentifier(obj)) matches = resolvesToNamespaceOfHome(obj, 0)
        }
        if (matches) {
          violations.push(isHome
            ? `${rel}: bracket-access reference to '${text}' outside sanctioned function`
            : `${rel}: bracket-access reference to '${text}' outside its home module`)
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
            const enc = enclosingFunctionName(node)
            if (!enc || !SANCTIONED_ENCLOSING_FN_NAMES.has(enc)) {
              violations.push(`${rel}: reference to '${node.text}' outside sanctioned function (found inside ${enc ?? 'top-level'})`)
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
 *  new in-home bypass function goes RED) and/or adding one synthetic file at `extraRelPath`
 *  (relative to `src/`) with `extraContent` (to prove an outside-file bypass goes RED). Returns
 *  program inputs pointed at the COPY, and a cleanup function. The real tree is NEVER written. */
function scratchCopy(opts: { homeAppend?: { rel: 'pipeline' | 'composer'; text: string }; extra?: { relPath: string; content: string } }): { inputs: EnumerationProgramInputs; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihw-enum-k8-'))
  const copyRoot = path.join(dir, 'src')
  fs.cpSync(SRC_ROOT, copyRoot, { recursive: true })
  if (opts.homeAppend) {
    const target = path.join(copyRoot, opts.homeAppend.rel === 'pipeline' ? 'lib/fba/listingPipeline.ts' : 'lib/fba/itemHighlightComposer.ts')
    fs.appendFileSync(target, '\n' + opts.homeAppend.text)
  }
  const rootNames = listTsFilesFlat(copyRoot)
  if (opts.extra) {
    const full = path.join(copyRoot, opts.extra.relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, opts.extra.content)
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
