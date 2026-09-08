/**
 * ihDoctrineSingleSource.test.ts — SOURCE-SCAN ENUMERATION TEST (fix round 3, controller RULING,
 * M-3, `phase-1-fix-round-3-findings.md`: "add a source-scan pin over `docs/` + `handoff/` + `src/`
 * that fails on a new copy of the claim").
 *
 * WHY THIS EXISTS. The refuted doctrine — "the Item Highlight renders ONLY in the HTML `<title>`,
 * never anywhere a shopper looks" — was corrected in TWO places by fix round 1 (Important 5):
 * `src/lib/fba/contentContract.ts:43-56` and `handoff/SELLER_PROFILE.md:248`. The final review
 * (Minor 3) found a THIRD, uncorrected copy at
 * `docs/superpowers/specs/2026-09-05-item-highlights-rebuild.md:12` — exactly the failure mode this
 * pin exists to close: a doctrine correction made at two sites with no mechanical guard against a
 * fourth, fifth, or Nth copy surviving (or a NEW one being introduced) elsewhere in the tree.
 *
 * SCANNER RULE. Walks every `.md`/`.ts`/`.tsx` file under `docs/`, `handoff/`, `src/` (the ruling's
 * own three roots — NOT `.superpowers/`, which holds this project's own historical review/report
 * artifacts that quote the finding as a matter of record, not as asserted doctrine) and flags any
 * line containing `ONLY in the HTML` (case-insensitive — the one substring common to every phrasing
 * of the claim: "renders ONLY in the HTML <title>", "appears ONLY in the HTML `<title>`", etc.)
 * UNLESS that exact (file, line-text) pair is on the ALLOWLIST below — every current occurrence is
 * either (a) a DOCTRINE CORRECTION quoting the OLD claim for context (the three files above) or (b)
 * the terminal-net spec's own record of the finding
 * (`docs/superpowers/specs/2026-09-07-item-highlight-terminal-net.md:28`). Matched by EXACT file +
 * VERBATIM line text (never by line number or count, per this repo's established
 * `genderLexiconSingleSource.test.ts` pattern) — editing an allowlisted line by even one character,
 * or a brand-new occurrence anywhere, is RED.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = process.cwd()
const SCAN_DIRS = ['docs', 'handoff', 'src']
const CLAIM_RE = /ONLY in the HTML/i

/** Every current occurrence of the claim substring in the live tree — each an ALREADY-CORRECTED
 *  reference (a DOCTRINE CORRECTION quoting the old claim, or the spec's own record of the finding),
 *  never a live, uncorrected assertion. Verified with `rg -niE "ONLY in the HTML" docs handoff src`
 *  (fix round 3): exactly these 4 lines, in exactly these 4 files. */
const ALLOWLIST: { file: string; line: string }[] = [
  {
    file: 'docs/superpowers/specs/2026-09-05-item-highlights-rebuild.md',
    line: '  ONLY in the HTML `<title>` — the browser tab and what Google indexes:',
  },
  {
    file: 'docs/superpowers/specs/2026-09-07-item-highlight-terminal-net.md',
    line: '   anywhere a shopper looks") and `handoff/SELLER_PROFILE.md:248` ("renders ONLY in the HTML',
  },
  {
    file: 'handoff/SELLER_PROFILE.md',
    line: 'DOCTRINE CORRECTION (2026-09-07, IH terminal net spec, Important 5): the line used to read "renders ONLY in the HTML <title> ... never on the PDP ... not conversion copy." A LIVE DOM probe the same day refutes it — the Item Highlight renders inside `#centerCol`, in `document.body.innerText`, ~366×60 px directly under the h1, measured on `B0H9VDCBZJ` (124 chars) and `B0DMXMH266` (122 chars). The field IS shopper-visible on the PDP. The "70% SEO" ruling and the 107-char floor were both made believing no shopper sees this field — re-read them against this corrected premise; neither is re-litigated here. PO 2026-09-06: "it shouldnt be [design-blind] as we gave it VISION" — one line PER DESIGN from that design\'s own pool and audience (PR #673). Every fit/fabric claim must be provable from blank_specs (the live "relaxed unisex fit" on a Classic-fit Gildan 18000 was the falsehood this closes). The title\'s forced-gender rule also gates highlights, per design.',
  },
  {
    file: 'src/lib/fba/contentContract.ts',
    line: ' * phase-1-fix-round-findings.md): the line above USED to read "the field renders ONLY in the HTML',
  },
]

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    // Test files are excluded — same as this repo's `itemHighlightNetUnionCollision.test.ts`
    // ("every non-test .ts/.tsx file under src/"): a test's OWN prose/fixtures legitimately discuss
    // or synthesize the claim string (this file's scanner self-tests do exactly that), and are not
    // themselves an assertion of doctrine.
    else if (/\.(md|ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Scans the given roots (relative to `root`) for unallowlisted occurrences of the claim.
 *  Exported so this file's own sensitivity can be proven against a synthetic root without
 *  mutating the real tree. */
export function findUnallowlistedDoctrineClaims(root: string, scanDirs: string[], allowlist: { file: string; line: string }[]): string[] {
  const violations: string[] = []
  for (const dir of scanDirs) {
    const dirPath = path.join(root, dir)
    for (const file of walk(dirPath)) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      let lines: string[]
      // \r?\n: some files in this tree (Windows checkouts) carry CRLF line endings — split on
      // either so a trailing \r never breaks an exact-text allowlist match.
      try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { continue }
      lines.forEach((lineText) => {
        if (!CLAIM_RE.test(lineText)) return
        const allowed = allowlist.some((a) => a.file === rel && a.line === lineText)
        if (!allowed) violations.push(`${rel}: ${lineText.trim()}`)
      })
    }
  }
  return violations
}

describe('IH doctrine (fix round 3, controller RULING, M-3): "renders ONLY in the HTML <title>" has no unallowlisted copy under docs/handoff/src', () => {
  it('SCANNER SELF-TEST: flags a brand-new, unallowlisted occurrence of the claim', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-doctrine-scanner-self-test-bad')
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'stale.md'), 'The Item Highlight renders ONLY in the HTML title tag.\n')
    try {
      const violations = findUnallowlistedDoctrineClaims(tmp, ['docs'], [])
      expect(violations.length).toBe(1)
      expect(violations[0]).toContain('docs/stale.md')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SCANNER SELF-TEST: accepts an occurrence that exactly matches an allowlist entry', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-doctrine-scanner-self-test-good')
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'corrected.md'), 'quoting the old claim: ONLY in the HTML title, for context.\n')
    try {
      const violations = findUnallowlistedDoctrineClaims(tmp, ['docs'], [
        { file: 'docs/corrected.md', line: 'quoting the old claim: ONLY in the HTML title, for context.' },
      ])
      expect(violations).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('SCANNER SELF-TEST: editing an allowlisted line by one character falls through and fails (no line-number/count matching)', () => {
    const tmp = path.join(REPO_ROOT, '.tmp-doctrine-scanner-self-test-edited')
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs', 'corrected.md'), 'quoting the old claim: ONLY in the HTML title, for CONTEXT.\n')
    try {
      const violations = findUnallowlistedDoctrineClaims(tmp, ['docs'], [
        { file: 'docs/corrected.md', line: 'quoting the old claim: ONLY in the HTML title, for context.' },
      ])
      expect(violations.length).toBe(1)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('the REAL tree has exactly the 4 known, already-corrected occurrences — zero unallowlisted claims', () => {
    const violations = findUnallowlistedDoctrineClaims(REPO_ROOT, SCAN_DIRS, ALLOWLIST)
    expect(violations).toEqual([])
  })

  it('every ALLOWLIST entry is actually present in the real tree (no stale/dead allowlist entries)', () => {
    for (const entry of ALLOWLIST) {
      const full = path.join(REPO_ROOT, entry.file)
      const content = fs.readFileSync(full, 'utf8')
      expect(content.split(/\r?\n/)).toContain(entry.line)
    }
  })
})
