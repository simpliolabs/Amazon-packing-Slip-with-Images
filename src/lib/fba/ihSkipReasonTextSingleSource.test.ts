/**
 * ihSkipReasonTextSingleSource.test.ts — SOURCE-SCAN ENUMERATION TEST (fix round 3, controller
 * RULING, I-2, `phase-1-fix-round-3-findings.md`: "add the source-scan pin ... that fails if a skip
 * reason is rendered by a literal ternary anywhere in `pushExecutor.ts` or the page").
 *
 * WHY THIS EXISTS. Before this fix, FOUR separate sites hand-rolled their OWN ternary mapping an
 * `IhSkuSkipReason` to seller-facing text (`pushExecutor.ts` :3777/:3958/:4042/:4794, and the card in
 * the listing page) — the FOURTH appearance of the exact same single-vs-bulk / site-vs-site
 * divergence on this branch (composer vs seam; single vs bulk skip reasons; single vs bulk empty
 * guard; now this). `ihSkipReasonText` (`perDesignItemHighlights.ts`) is now the ONE mapper every
 * site calls. This is the runtime backstop against a FIFTH hand-rolled copy ever being added again —
 * a new `IhHoldReason` must be impossible to surface without every caller of `ihSkipReasonText`
 * getting it, by construction.
 *
 * SCANNER RULE (part 1 — the TERNARY shape). Reads `pushExecutor.ts` and the listing page (comments
 * stripped — this codebase documents heavily between a comparison and its consequent) and flags any
 * TERNARY whose condition compares to a skip-reason token (`NO_LINE_FOR_DESIGN`,
 * `REPEAT_IN_STORED_LINE`, `UNDER_FLOOR`, or the bare string literals `'no-line-for-design'` /
 * `'repeat-in-stored-line'` / `'under-floor'`) and whose `?`-branch opens a raw string/template
 * literal — i.e. a hand-rolled reason→text mapping. A plain `if (...)`/boolean-guard comparison
 * against the same tokens (routing/control-flow, not text construction) does NOT trip this — the `?`
 * must follow the comparison, not `{`/`&&`/`)`.
 *
 * R3 (finish-line-rulings.md, controller RULING, 2026-09-08) — SCANNER RULE part 2 (the BARE-LITERAL
 * shape, extending the pin past ternaries). REPRODUCED live: `page.tsx:6198` hardcoded the literal
 * text `no-line-for-design` directly into a JSX narrative string ("Held{...} — skipped
 * (no-line-for-design)") with NO ternary at all — the OLD scanner's own MINOR 1 self-test proved
 * this shape is a MISS ("MISSED | LIVE page.tsx:6198 hardcoded reason literal"): there is no `?`
 * anywhere near it for `HAND_ROLLED_TERNARY_RE` to anchor on. `findHardcodedSkipReasonLiterals`
 * below flags any of the EIGHT `IhSkuSkipReason` string literals appearing bare — NOT immediately
 * wrapped in a quote character on both sides — anywhere in the file. A quoted occurrence (a real
 * `=== 'under-floor'` comparison, or a type union like
 * `skipReason?: 'no-line-for-design' | 'repeat-in-stored-line' | 'under-floor'`) is deliberately left
 * alone: quoting is exactly what makes it a comparison/type value instead of narrative text that
 * bypasses `ihSkipReasonText`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const PUSH_EXECUTOR_PATH = path.join(process.cwd(), 'src/lib/fba/pushExecutor.ts')
const PAGE_PATH = path.join(process.cwd(), 'src/app/fba/listing/[asin]/page.tsx')

const REASON_TOKEN = "(?:NO_LINE_FOR_DESIGN|REPEAT_IN_STORED_LINE|UNDER_FLOOR|'no-line-for-design'|'repeat-in-stored-line'|'under-floor')"
/** A skip-reason token, optionally followed by whitespace/newlines/a closing paren, then `?` then a
 *  string/template-literal OPENING quote — a ternary whose TRUE branch is a raw text literal. */
const HAND_ROLLED_TERNARY_RE = new RegExp(`${REASON_TOKEN}\\s*\\)?\\s*\\n?\\s*\\?\\s*[\`'"]`)

/** Every `IhSkuSkipReason` string literal (the three seam constants' string values PLUS every
 *  `IhHoldReason` member — FIX ROUND 3, I-1, widened the union; MINOR 1 flagged that the ternary
 *  scanner's token list never followed), longest-first so a combined alternation always matches the
 *  LONGEST literal at a given position (`under-floor-no-repeat` before `under-floor`, or the shorter
 *  token would falsely "consume" a prefix of the longer one and the bare-literal check below would
 *  misjudge what is actually quoted). */
const SKIP_REASON_LITERALS = [
  'under-floor-no-repeat', 'repeat-in-stored-line', 'no-line-for-design',
  'designs-unrated', 'thin-candidates', 'unrated-pool', 'under-floor', 'no-spec',
]
/** Matches one of the literals above ONLY when it is NOT immediately wrapped in a quote character
 *  on either side — i.e. bare narrative text (JSX or an unquoted template segment), never a quoted
 *  comparison value or type-union member. */
const BARE_SKIP_REASON_LITERAL_RE = new RegExp(`(?<![\`'"])(?:${SKIP_REASON_LITERALS.join('|')})(?![\`'"])`, 'g')

/** Strip `//` line comments and `/* … *‍/` block comments (this repo's own established pattern,
 *  `itemHighlightNetUnionCollision.test.ts` / `patchSkuMultiReplaceSingleSource.test.ts`). */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

/** Returns every hand-rolled-ternary match found in `src` (comments stripped first), each a short
 *  snippet around the match for a readable failure message. */
export function findHandRolledSkipReasonTernaries(src: string): string[] {
  const stripped = stripComments(src)
  const violations: string[] = []
  const re = new RegExp(HAND_ROLLED_TERNARY_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    violations.push(stripped.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10).replace(/\s+/g, ' ').trim())
  }
  return violations
}

/** R3 (finish-line-rulings.md, controller RULING, 2026-09-08): returns every BARE skip-reason
 *  literal found in `src` (comments stripped first) — a hardcoded reason STRING baked directly into
 *  rendered/narrative text, the shape MINOR 1 proved the ternary scanner alone cannot see. */
export function findHardcodedSkipReasonLiterals(src: string): string[] {
  const stripped = stripComments(src)
  const violations: string[] = []
  const re = new RegExp(BARE_SKIP_REASON_LITERAL_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    violations.push(stripped.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10).replace(/\s+/g, ' ').trim())
  }
  return violations
}

/** The combined pin both "REAL file" tests below apply — a violation of EITHER shape fails it. */
function findAnySkipReasonViolation(src: string): string[] {
  return [...findHandRolledSkipReasonTernaries(src), ...findHardcodedSkipReasonLiterals(src)]
}

describe('ihSkipReasonText is the ONE mapper — no hand-rolled reason→text ternary in pushExecutor.ts or the page (source-scan pin, fix round 3, controller RULING I-2)', () => {
  it('SCANNER SELF-TEST: flags a synthetic hand-rolled ternary (the OLD :3958/:4042/:4794 shape)', () => {
    const bad = [
      "const reason = item.skipReason === REPEAT_IN_STORED_LINE",
      "  ? 'Skipped — this SKU\\'s stored Item Highlight repeats a significant word.'",
      "  : item.skipReason === UNDER_FLOOR",
      "    ? `Skipped — this SKU's stored Item Highlight is under the floor.`",
      "    : 'Skipped — this SKU\\'s design has no composed Item Highlight (held).'",
    ].join('\n')
    expect(findHandRolledSkipReasonTernaries(bad)).not.toEqual([])
  })

  it('SCANNER SELF-TEST: flags a synthetic hand-rolled ternary keyed on the bare string literals', () => {
    const bad = "const t = r.skipReason === 'under-floor' ? `This stored line is only ${r.line.length} chars.` : 'other text'"
    expect(findHandRolledSkipReasonTernaries(bad)).not.toEqual([])
  })

  it('SCANNER SELF-TEST: accepts the sanctioned shape — a call to ihSkipReasonText, no hand-rolled text', () => {
    const good = [
      "const reason = `Skipped — ${ihSkipReasonText(item.skipReason ?? NO_LINE_FOR_DESIGN)}.`",
      "const reasonText = `Skipped — ${ihSkipReasonText(sk.reason)}.`",
    ].join('\n')
    expect(findHandRolledSkipReasonTernaries(good)).toEqual([])
  })

  it('SCANNER SELF-TEST: accepts a plain if/boolean-guard comparison against the same tokens (control flow, not text construction)', () => {
    const good = "if (ctx.perDesignEntries && (item.skipReason === NO_LINE_FOR_DESIGN || item.skipReason === REPEAT_IN_STORED_LINE || !item.raw || item.skipReason === UNDER_FLOOR)) {\n  const reason = `Skipped — ${ihSkipReasonText(item.skipReason ?? NO_LINE_FOR_DESIGN)}.`\n}"
    expect(findHandRolledSkipReasonTernaries(good)).toEqual([])
  })

  it('the REAL pushExecutor.ts has zero hand-rolled reason-to-text ternaries', () => {
    const src = fs.readFileSync(PUSH_EXECUTOR_PATH, 'utf8')
    expect(findHandRolledSkipReasonTernaries(src)).toEqual([])
  })

  it('the REAL listing page has zero hand-rolled reason-to-text ternaries', () => {
    const src = fs.readFileSync(PAGE_PATH, 'utf8')
    expect(findHandRolledSkipReasonTernaries(src)).toEqual([])
  })

  it('PERTURBATION (proves the pin actually bites on the real file, not just synthetic snippets): reintroducing the OLD :4794 ternary in a copy of the real text goes RED', () => {
    const src = fs.readFileSync(PUSH_EXECUTOR_PATH, 'utf8')
    expect(findHandRolledSkipReasonTernaries(src)).toEqual([])   // baseline: clean
    const mutated = src.replace(
      "const reasonText = `Skipped — ${ihSkipReasonText(sk.reason)}.`",
      "const reasonText = sk.reason === REPEAT_IN_STORED_LINE\n          ? `Skipped — this SKU's stored ${sk.field} repeats a significant word.`\n          : `Skipped — this SKU's design has no composed ${sk.field} (held).`",
    )
    expect(mutated).not.toEqual(src)   // the replace actually matched something
    expect(findHandRolledSkipReasonTernaries(mutated)).not.toEqual([])
  })
})

describe('R3 (finish-line-rulings.md, controller RULING, 2026-09-08) — the pin also catches a BARE hardcoded skip-reason literal, not only a ternary', () => {
  it('SCANNER SELF-TEST: flags the EXACT live miss MINOR 1 named (page.tsx:6198, no ternary anywhere near it)', () => {
    const bad = "Held{r.hold ? ` · ${r.hold}` : ''} — skipped (no-line-for-design)"
    expect(findHardcodedSkipReasonLiterals(bad)).not.toEqual([])
    // and MINOR 1's own regex proved this shape a MISS — the pin now differs from that baseline
    expect(findHandRolledSkipReasonTernaries(bad)).toEqual([])   // confirms it truly has no ternary
  })

  it('SCANNER SELF-TEST: flags a switch-based hand-rolled mapper (another MINOR 1 miss)', () => {
    const bad = "switch (reason) {\n  case 'under-floor': return 'This line is under the floor.'\n  default: return `Skipped (under-floor)`\n}"
    expect(findHardcodedSkipReasonLiterals(bad)).not.toEqual([])
  })

  it('SCANNER SELF-TEST: accepts a QUOTED comparison — routing/control-flow, not narrative text', () => {
    const good = "if (row.hold === 'designs-unrated') { markUnrated(row) }"
    expect(findHardcodedSkipReasonLiterals(good)).toEqual([])
  })

  it("SCANNER SELF-TEST: accepts a QUOTED type-union member (MINOR 2's stale-but-typed union, out of scope for this ruling)", () => {
    const good = "interface Row { skipReason?: 'no-line-for-design' | 'repeat-in-stored-line' | 'under-floor' }"
    expect(findHardcodedSkipReasonLiterals(good)).toEqual([])
  })

  it('SCANNER SELF-TEST: accepts dynamic interpolation of the ACTUAL reason (never a hardcoded literal)', () => {
    const good = "return `Skipped at push — ${r.skipReason}`"
    expect(findHardcodedSkipReasonLiterals(good)).toEqual([])
  })

  it('the REAL pushExecutor.ts has zero bare hardcoded skip-reason literals', () => {
    const src = fs.readFileSync(PUSH_EXECUTOR_PATH, 'utf8')
    expect(findHardcodedSkipReasonLiterals(src)).toEqual([])
  })

  it('the REAL listing page has zero bare hardcoded skip-reason literals (fixed: page.tsx:6198)', () => {
    const src = fs.readFileSync(PAGE_PATH, 'utf8')
    expect(findHardcodedSkipReasonLiterals(src)).toEqual([])
  })

  it('the REAL pushExecutor.ts and the page have zero violations of EITHER shape (the combined pin)', () => {
    expect(findAnySkipReasonViolation(fs.readFileSync(PUSH_EXECUTOR_PATH, 'utf8'))).toEqual([])
    expect(findAnySkipReasonViolation(fs.readFileSync(PAGE_PATH, 'utf8'))).toEqual([])
  })

  it('MUTATION: reintroducing the OLD page.tsx:6198 hardcoded literal in a copy of the real page text goes RED', () => {
    const src = fs.readFileSync(PAGE_PATH, 'utf8')
    expect(findHardcodedSkipReasonLiterals(src)).toEqual([])   // baseline: clean (post-fix)
    const mutated = src.replace(
      "{r.skipReason && <span className=\"px-1 py-0.5 rounded bg-amber-100 text-amber-800 font-medium\" title={ihSkipReasonText(r.skipReason)}>Skipped at push — {r.skipReason}</span>}",
      "{!r.line && <span className=\"px-1 py-0.5 rounded bg-amber-100 text-amber-800 font-medium\">Held{r.hold ? ` · ${r.hold}` : ''} — skipped (no-line-for-design)</span>}",
    )
    expect(mutated).not.toEqual(src)   // the replace actually matched something
    expect(findHardcodedSkipReasonLiterals(mutated)).not.toEqual([])
  })
})
