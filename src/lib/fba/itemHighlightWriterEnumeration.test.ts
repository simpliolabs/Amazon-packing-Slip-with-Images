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
