/**
 * ihContentRuleSingleSource.test.ts — SOURCE-SCAN ENUMERATION TEST (Item Highlight WRITER Phase A,
 * 2026-09-10, spec docs/superpowers/specs/2026-09-10-item-highlight-writer.md §2 Phase A / the
 * reverted feat/ih-phase23-wip @ c466225's own adversary: "'Two rulebooks again.' ... Phase [A]
 * must MOVE the rules, not copy them ... A source-scan enumeration test ... should fail if a
 * second Item-Highlight rule list appears anywhere in src/lib").
 *
 * WHAT THIS GUARDS. Phase A moved SEVEN names — the five deterministic Item-Highlight content
 * rules (off-season, promo/pricing, hardcoded-capacity, third-party-brand, sentence-shape — used to
 * be hand-rolled inline in `validateItemHighlights`, listingPipeline.ts) plus the two brand-vocab
 * helpers they depend on (`findThirdPartyBrands`, `ownBrandTokenSet`, also used ~20 more times
 * elsewhere in listingPipeline.ts for title/bullets/backend) — into ONE home,
 * `productDetailAttrs.ts`: the `THIRD_PARTY_BRANDS`/`THIRD_PARTY_BRAND_PHRASES` lists, the
 * `HIGHLIGHT_PROMO_RE`/`CAPACITY_RE` patterns, `findThirdPartyBrands`/`ownBrandTokenSet`, and the
 * `ihContentRuleViolations` predicate that reads them. `validateItemHighlights` now CALLS that
 * predicate instead of re-implementing it, and `capItemHighlightRepeats` (the terminal net every
 * producer, the Regen route, and the push seam already call) enforces it. A SECOND definition of
 * any of these seven names anywhere else in `src/lib` is exactly the "two rulebooks" regression
 * this move exists to close — a future edit to one copy (widening a brand list, tightening the
 * promo regex) would silently NOT reach the other, and the checker route and the actual SP-API push
 * would disagree again.
 *
 * SCANNER RULE — same discipline as this repo's `ihDoctrineSingleSource.test.ts` /
 * `genderLexiconSingleSource.test.ts`: walk every non-test `.ts`/`.tsx` file under `src/lib`, find
 * every line that DEFINES one of the seven canonical names (`const`/`export const`/`function`/
 * `export function` followed by the exact identifier), and require it to match an ALLOWLIST entry
 * keyed by EXACT `{ file, line }` — never by line number or count. Every current definition lives
 * in `fba/productDetailAttrs.ts`; that is the only allowlist this file carries. A definition
 * anywhere else (a brand-new copy) has no matching entry and is RED. Editing an allowlisted
 * definition line by even one character also falls through (it no longer matches the allowlist's
 * stored text byte-for-byte) and is RED too — proven below against SYNTHETIC temp trees (never the
 * real one), the "prove it bites twice" requirement: the self-tests below construct a rogue copy,
 * confirm RED, then a second, differently-shaped rogue copy, confirm RED again, before the final
 * test asserts the REAL tree is clean.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = process.cwd()
const SCAN_DIR = 'src/lib'

/** Matches a DEFINITION line for one of the seven moved names — `const`/`function`, optionally
 *  `export`-ed, followed by the exact identifier and a word boundary (so e.g. `CAPACITY_RE2` or a
 *  mere USE of the name — `CAPACITY_RE.test(...)`, `ihContentRuleViolations(s, ctx)` — never
 *  matches; only the declaration itself does). */
const DEFINITION_RE = /^\s*(?:export\s+)?(?:const|function)\s+(THIRD_PARTY_BRANDS|THIRD_PARTY_BRAND_PHRASES|findThirdPartyBrands|ownBrandTokenSet|HIGHLIGHT_PROMO_RE|CAPACITY_RE|ihContentRuleViolations)\b/

interface AllowlistEntry { file: string; line: string }

/** Every current definition of the seven moved names in the live tree — verified with
 *  `rg -n "^(export )?(const|function) (THIRD_PARTY_BRANDS|THIRD_PARTY_BRAND_PHRASES|findThirdPartyBrands|ownBrandTokenSet|HIGHLIGHT_PROMO_RE|CAPACITY_RE|ihContentRuleViolations)\b" src/lib`
 *  (Phase A, this session): exactly these 7 lines, all in `fba/productDetailAttrs.ts`. */
const ALLOWLIST: AllowlistEntry[] = [
  { file: 'fba/productDetailAttrs.ts', line: 'export const THIRD_PARTY_BRANDS = new Set([' },
  { file: 'fba/productDetailAttrs.ts', line: 'const THIRD_PARTY_BRAND_PHRASES = [' },
  { file: 'fba/productDetailAttrs.ts', line: 'export function findThirdPartyBrands(text: string, ownBrandTokens: Set<string>): string[] {' },
  { file: 'fba/productDetailAttrs.ts', line: 'export function ownBrandTokenSet(brandName: string): Set<string> {' },
  { file: 'fba/productDetailAttrs.ts', line: 'export const CAPACITY_RE = /\\b(\\d{1,4})\\s?(t|g)b?\\b/i // GB/TB only — "MB" is usually a transfer speed, not capacity' },
  { file: 'fba/productDetailAttrs.ts', line: 'const HIGHLIGHT_PROMO_RE = /\\b(?:sale|discount|cheap|free|deal)\\b|% ?off|\\$/i' },
  { file: 'fba/productDetailAttrs.ts', line: 'export function ihContentRuleViolations(s: string, ctx?: IhContentRuleCtx): IhContentRuleViolation[] {' },
]

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Scans `root/scanDir` for definition lines of the seven moved names, returning every one that is
 *  NOT an exact `{file, line}` match in `allowlist`. Exported so this file's own sensitivity can be
 *  proven against a synthetic root (the "prove it bites twice" requirement) without mutating the
 *  real tree. */
export function findUnallowlistedRuleListDefinitions(root: string, scanDir: string, allowlist: AllowlistEntry[]): string[] {
  const violations: string[] = []
  const dirPath = path.join(root, scanDir)
  for (const file of walk(dirPath)) {
    const rel = path.relative(dirPath, file).split(path.sep).join('/')
    let lines: string[]
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { continue }
    lines.forEach((lineText) => {
      if (!DEFINITION_RE.test(lineText)) return
      const allowed = allowlist.some((a) => a.file === rel && a.line === lineText)
      if (!allowed) violations.push(`${rel}: ${lineText.trim()}`)
    })
  }
  return violations
}

describe('IH content-rule single source (Phase A, spec adversary "two rulebooks again"): no second definition of the seven moved names under src/lib', () => {
  it('SCANNER SELF-TEST #1 (bite 1 of 2): a brand-new, unallowlisted second definition (a "second rule list") is RED', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-ih-rulelist-scanner-self-test-new')
    fs.mkdirSync(path.join(tmp, 'lib', 'fba'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'lib', 'fba', 'rogueCopy.ts'),
      "const CAPACITY_RE = /\\bfoo\\b/i\n",
    )
    try {
      const violations = findUnallowlistedRuleListDefinitions(tmp, 'lib', [])
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('fba/rogueCopy.ts')
      expect(violations[0]).toContain('CAPACITY_RE')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SCANNER SELF-TEST #2 (bite 2 of 2, a DIFFERENT symbol and a DIFFERENT file shape): a second copy of findThirdPartyBrands elsewhere is ALSO RED', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-ih-rulelist-scanner-self-test-new-2')
    fs.mkdirSync(path.join(tmp, 'lib', 'fba', 'nested'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'lib', 'fba', 'nested', 'anotherRogueCopy.ts'),
      "export function findThirdPartyBrands(text: string, ownBrandTokens: Set<string>): string[] {\n  return []\n}\n",
    )
    try {
      const violations = findUnallowlistedRuleListDefinitions(tmp, 'lib', [])
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('fba/nested/anotherRogueCopy.ts')
      expect(violations[0]).toContain('findThirdPartyBrands')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SCANNER SELF-TEST: a definition matching an allowlist entry exactly is accepted (restored after each bite above — the scanner only flags UNALLOWLISTED copies, never the canonical one)', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-ih-rulelist-scanner-self-test-good')
    fs.mkdirSync(path.join(tmp, 'lib', 'fba'), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'lib', 'fba', 'productDetailAttrs.ts'),
      'const HIGHLIGHT_PROMO_RE = /\\b(?:sale|discount|cheap|free|deal)\\b|% ?off|\\$/i\n',
    )
    try {
      const violations = findUnallowlistedRuleListDefinitions(tmp, 'lib', [
        { file: 'fba/productDetailAttrs.ts', line: 'const HIGHLIGHT_PROMO_RE = /\\b(?:sale|discount|cheap|free|deal)\\b|% ?off|\\$/i' },
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SCANNER SELF-TEST: editing an allowlisted definition by one character is RED (no line-number/count matching — an EDITED copy is a NEW, unreviewed rule list until re-allowlisted)', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-ih-rulelist-scanner-self-test-edited')
    fs.mkdirSync(path.join(tmp, 'lib', 'fba'), { recursive: true })
    // ONE character different from the allowlisted line below ("cheep" for "cheap").
    fs.writeFileSync(
      path.join(tmp, 'lib', 'fba', 'productDetailAttrs.ts'),
      'const HIGHLIGHT_PROMO_RE = /\\b(?:sale|discount|cheep|free|deal)\\b|% ?off|\\$/i\n',
    )
    try {
      const violations = findUnallowlistedRuleListDefinitions(tmp, 'lib', [
        { file: 'fba/productDetailAttrs.ts', line: 'const HIGHLIGHT_PROMO_RE = /\\b(?:sale|discount|cheap|free|deal)\\b|% ?off|\\$/i' },
      ])
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('cheep')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('the REAL tree has exactly the 7 known, canonical definitions — zero unallowlisted rule lists', () => {
    const violations = findUnallowlistedRuleListDefinitions(REPO_ROOT, SCAN_DIR, ALLOWLIST)
    expect(violations).toEqual([])
  })

  it('every ALLOWLIST entry is actually present verbatim in the real tree (no stale entry hiding a removed/edited definition)', () => {
    for (const entry of ALLOWLIST) {
      const full = path.join(REPO_ROOT, SCAN_DIR, entry.file)
      const content = fs.readFileSync(full, 'utf8')
      expect(content.split(/\r?\n/)).toContain(entry.line)
    }
  })

  it('each of the seven names is defined EXACTLY once in the real tree (the allowlist itself has no duplicate name)', () => {
    const names = ALLOWLIST.map((a) => a.line.match(DEFINITION_RE)?.[1])
    expect(new Set(names).size).toBe(names.length)
    expect(names.sort()).toEqual([
      'CAPACITY_RE', 'HIGHLIGHT_PROMO_RE', 'THIRD_PARTY_BRANDS', 'THIRD_PARTY_BRAND_PHRASES',
      'findThirdPartyBrands', 'ihContentRuleViolations', 'ownBrandTokenSet',
    ].sort())
  })
})
