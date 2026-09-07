import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * genderLexiconSingleSource.test.ts — the SOURCE-SCAN ENUMERATION TEST (fix round 1, I1).
 *
 * WHAT WENT WRONG (opus reviewer, task-7-review-findings.md, "I1"). Task 7 exported the forced-
 * gender lexicon core (`LEAN_FEM_CORE`/`LEAN_MASC_CORE`, contentTruth.ts) and had `nicheGuards.ts`/
 * `syncListingContent.ts` import + compose it — but the "enumeration/source pin" that was supposed
 * to guard against a THIRD hand-copy only asserted that each consumer FILE contains the substrings
 * `from '@/lib/fba/contentTruth'`, `LEAN_FEM_CORE`, `LEAN_MASC_CORE` ANYWHERE in the file. The
 * reviewer proved by EXECUTED PERTURBATION that re-drifting `syncListingContent.ts`'s regex to a
 * hand-copied literal, while leaving the now-decorative import line in place, stayed GREEN — the pin
 * was a false assurance. `nicheGuards.ts` only went RED via the unrelated behavioural
 * `leanExcludesKeyword` pin, not the pin the brief actually asked for.
 *
 * THE FIX (controller ruling, task-7-fix-round-1-findings.md, "I1"). Replace the identifier-anywhere
 * pin with a test that reads every non-test `*.ts` file under `src/lib`, finds every regex-literal or
 * `new RegExp(...)`-string that contains a gender-alternation token, and requires EACH ONE to be
 * either (a) a definition/composition that references `LEAN_FEM_CORE`/`LEAN_MASC_CORE` by name, or
 * (b) an explicit, classified ALLOWLIST entry keyed by FILE + VERBATIM LITERAL TEXT (never by line
 * number, never by count) — so a brand-new hand-copy anywhere is RED, and so is editing an
 * allowlisted literal by even one character (it no longer matches the allowlisted text, so it falls
 * through to "not composed, not allowlisted" and fails).
 *
 * SCANNER RULE — how a "gender-alternation regex" is recognised, and how it is told apart from
 * PROSE (e.g. `listingPipeline.ts:1414`'s prompt string "never name an adult-only audience
 * (women/men/ladies/plus-size)" — plain sentence text, not a pattern, and must not trip this):
 *   1. CANDIDATES are collected structurally, not by grepping the whole file as text: a JS regex
 *      LITERAL (`/…/flags`) whose opening `/` is immediately preceded — ignoring whitespace — by one
 *      of `= ( , ? : [ | & ! ; {`, a newline, or the keyword `return` (exactly the set that can
 *      precede a regex in expression position; a `/` anywhere else is division, not a pattern); or
 *      the first string/template ARGUMENT of a `new RegExp(...)` call. A `/` inside a string/template
 *      literal, or inside a `//`/`/* … *‍/` comment, is skipped before candidates are even looked for,
 *      so prose can never be mis-read as a regex boundary.
 *   2. A candidate is a HIT only if its literal TEXT contains a gender-alternation token: the
 *      bracket forms `wom[ae]n`/`m[ae]n` this codebase's real copies use verbatim; the plural/word
 *      forms `women`, `womens?`, `ladies`, `\blady\b`, `guys?`, `gals?`, `dudes?`, `bros?`, `gents?`;
 *      or a bare, unguarded "men" that is not part of a longer alphabetic run (so "garment",
 *      "dimension", "amendment" never trip it, but titleBand.ts's own unguarded
 *      `for\s+(?:men(?:…` does). Case-insensitive (titleCap.ts's copies operate on Title-Cased text:
 *      "Men"/"Women").
 *   3. A HIT PASSES without an allowlist entry when its literal text contains the identifier
 *      `LEAN_FEM_CORE` or `LEAN_MASC_CORE` (it is composing onto the shared core, the Task 7 idiom,
 *      or the two definition lines in `contentTruth.ts` themselves — the ONLY place the literal
 *      pattern strings are hand-typed, by design).
 *   4. Every other hit must appear in `ALLOWLIST` below, matched by EXACT `{ file, literal }` — the
 *      file path relative to `src/lib` with forward slashes, and the literal INCLUDING its `/flags`
 *      or its quote/backtick delimiters, byte-for-byte as extracted. No entry ever matches by line
 *      number or occurrence count, per the ruling — one entry covers every occurrence of the exact
 *      same literal text in the exact same file.
 *
 * SEEDING THE ALLOWLIST (fix round 1, verified with `rg -a` and by reading each site — task-7-report.md
 * appendix has the full per-site trace): the reviewer's/controller's named sites
 * (`listingPipeline.ts`'s ~17 lines, `rankAnalysis.ts:449`, `titleBand.ts` incl. its own `:269` tail,
 * `keywordResearcher.ts`, `itemHighlightComposer.ts`, `lockedTitleTruth.ts`, `poGoldCorpus.ts`,
 * `productTypeDefinitions.ts`) turned out to be an UNDERCOUNT once scanned mechanically rather than
 * by a narrower `rg` pattern — the honest, corrected total is 64 distinct (file, literal) pairs
 * across 11 files (`itemHighlightComposer.ts` carries none), plus two MORE files the manual list
 * never named (`titleCap.ts`, `titleReferee.ts`) and a competitor-search helper
 * (`keyword-engine/competitorFinder.ts`). Every entry is classified by `reason`:
 *   - `predicate-twin` — a fem/masc TEST that IS the shared predicate in miniature (detects whether a
 *     phrase names one gender). `filedFor: 'Task 9: convert to the core with a per-site pin'`.
 *   - `strip-net` — a REMOVAL/rewrite regex, the same class B1 fixed inside `contentTruth.ts` itself.
 *     `filedFor: 'title Phase 4'`.
 *   - `tail-shape` — an audience-TAIL recognizer/stripper at the end of an assembled string, the same
 *     shape as `contentTruth.ts`'s (now core-derived) `AUDIENCE_TAIL_RE` and `titleBand.ts`'s OWN
 *     separate `:269` copy (explicitly named OUT of this round — "title Phase 4 unifies the title
 *     oracles"). `filedFor: 'title Phase 4'`.
 *   - `stop-list` — gender words are a handful of tokens among many unrelated ones in a generic
 *     alternation (apparel-contaminant lists, a stopword list, a garment-context list, the
 *     ADULT/KIDS-axis word list) — not itself a fem/masc predicate. No conversion is owed; recorded
 *     so a reader does not mistake it for missed drift.
 * `listingPipeline.ts` and `rankAnalysis.ts` are NOT converted in this round (controller ruling:
 * "converting seven predicate-twins in listingPipeline.ts without per-site pins is how silent
 * regressions ship" — filed as Task 9). Nothing in this allowlist is touched by this commit.
 */

const SRC_ROOT = path.join(process.cwd(), 'src', 'lib')

const GENDER_TOKENS = [
  'wom[ae]n', 'm[ae]n', 'women', 'womens?', 'ladies', '\\blady\\b',
  'guys?', 'gals?', 'dudes?', 'bros?', 'gents?',
  // bare plural forms (no trailing literal "?") — this codebase's real copies all happen to spell
  // these with the "?" convention, but a hand-copy is not obliged to: `/\bguys\b/i` (no "?") must
  // trip this scanner exactly as `/\bguys?\b/i` already does.
  'guys', 'gals', 'dudes', 'bros', 'gents',
]

const isAlphaChar = (ch: string): boolean => /[A-Za-z]/.test(ch)

/** Bare, unguarded "men" (e.g. titleBand.ts:269's `for\s+(?:men(?:...)`): a hit only when "men" is
 *  NOT part of a longer alphabetic run — so "garment", "dimension", "amendment" never trip it, but a
 *  real gendered alternation branch does. A trailing "s" (mens) or apostrophe+s (men's/men’s) is
 *  consumed before checking the boundary AFTER, so those still count as the word. The character
 *  before a literal regex escape (`\b`, `\s`, …) is itself alphabetic (the escape's own letter), so a
 *  backslash immediately before that letter means "treat this as a boundary", not "adjacent to a
 *  real letter". */
function hasBareMen(lowerText: string): boolean {
  const re = /men/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lowerText))) {
    const beforeIdx = m.index - 1
    const beforeIsEscape = lowerText[beforeIdx - 1] === '\\'
    const beforeAlpha = !beforeIsEscape && isAlphaChar(lowerText[beforeIdx] ?? '')
    let afterIdx = m.index + 3
    if (lowerText[afterIdx] === 's') afterIdx++
    else if ((lowerText[afterIdx] === '\'' || lowerText[afterIdx] === '’') && lowerText[afterIdx + 1] === 's') afterIdx += 2
    const afterAlpha = isAlphaChar(lowerText[afterIdx] ?? '')
    if (!beforeAlpha && !afterAlpha) return true
  }
  return false
}

function containsGenderToken(literalText: string): boolean {
  const lc = literalText.toLowerCase()
  if (GENDER_TOKENS.some((tok) => lc.includes(tok))) return true
  return hasBareMen(lc)
}

function listNonTestTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...listNonTestTsFiles(full)); continue }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    if (entry.name.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

interface Candidate { literal: string; start: number }

/** Structural candidate finder: JS regex literals and `new RegExp(...)` string/template arguments,
 *  skipping comments and plain string/template literals so a `/` inside prose is never mistaken for
 *  a regex boundary (see the scanner-rule doc above). Deliberately simple (single-pass, no full JS
 *  parse) — sufficient for this codebase's actual call shapes, verified against all 90 raw hits by
 *  manual read before the allowlist below was written. */
function findCandidates(src: string): Candidate[] {
  const hits: Candidate[] = []
  const n = src.length
  let i = 0
  while (i < n) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++
        j++
      }
      i = j + 1
      continue
    }
    if (src.startsWith('new RegExp(', i)) {
      const callStart = i
      let j = i + 'new RegExp('.length
      while (j < n && /\s/.test(src[j])) j++
      const delim = src[j]
      if (delim === '`' || delim === '\'' || delim === '"') {
        let k = j + 1
        let depth = 0 // ${...} nesting depth, only meaningful for backtick templates
        while (k < n) {
          if (src[k] === '\\') { k += 2; continue }
          if (delim === '`' && src[k] === '$' && src[k + 1] === '{') { depth++; k += 2; continue }
          if (delim === '`' && depth > 0) {
            if (src[k] === '{') depth++
            else if (src[k] === '}') depth--
            k++
            continue
          }
          if (src[k] === delim) break
          k++
        }
        hits.push({ literal: src.slice(j, k + 1), start: j })
        i = k + 1
        continue
      }
      i = callStart + 'new RegExp('.length
      continue
    }
    if (ch === '/') {
      let b = i - 1
      while (b >= 0 && /[ \t]/.test(src[b])) b--
      const prevChar = b >= 0 ? src[b] : ''
      const prevWord = src.slice(Math.max(0, b - 9), b + 1)
      const isRegexStart =
        ['=', '(', ',', '?', ':', '[', '|', '&', '!', ';', '{', '\n'].includes(prevChar) ||
        /\breturn$/.test(prevWord) || i === 0
      if (isRegexStart) {
        let j = i + 1
        let inClass = false
        let bad = false
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue }
          if (src[j] === '[') { inClass = true; j++; continue }
          if (src[j] === ']') { inClass = false; j++; continue }
          if (src[j] === '/' && !inClass) break
          if (src[j] === '\n') { bad = true; break }
          j++
        }
        if (!bad && j < n) {
          let f = j + 1
          while (f < n && /[a-z]/i.test(src[f])) f++
          hits.push({ literal: src.slice(i, f), start: i })
          i = f
          continue
        }
      }
    }
    i++
  }
  return hits
}

function lineOf(src: string, idx: number): number {
  let line = 1
  for (let k = 0; k < idx; k++) if (src[k] === '\n') line++
  return line
}

const isComposition = (literal: string): boolean =>
  literal.includes('LEAN_FEM_CORE') || literal.includes('LEAN_MASC_CORE')

interface AllowlistEntry {
  /** Path relative to src/lib, forward-slashed. */
  file: string
  /** EXACT literal text as `findCandidates` extracts it (delimiters/flags included). */
  literal: string
  reason: 'predicate-twin' | 'stop-list' | 'strip-net' | 'tail-shape'
  filedFor?: string
  note?: string
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: "fba/contentTruth.ts",
    literal: "/\\b(?:women|woman|womens|womans|ladies|lady|men|mens|mans|adults?|plus[\\s-]?size)\\b/gi",
    reason: "stop-list",
    note: "ADULT_AUDIENCE_RE — rule (c) kids/adult axis, a DIFFERENT predicate than forced-gender rule (c2); not a lean copy",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\b(?:men|mens|man|male|boys?)\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "stripOppositeGenderTokens (backend, masculine half)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\b(?:women|womens|woman|ladies|female|girls?)\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "stripOppositeGenderTokens (backend, feminine half)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bmen['’]?s\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "enforceHardAudience swap: men's -> Women's",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bmens\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "enforceHardAudience swap: mens -> Womens",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bmen\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "enforceHardAudience swap: men -> Women",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwomen['’]?s\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "enforceHardAudience swap: women's -> Men's",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwomens\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "enforceHardAudience swap: womens -> Mens",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwomen\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "enforceHardAudience swap: women -> Men",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor men and women\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "title-v2 scorer: docks a universal design carrying \"for Men and Women\"",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor\\s+women\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForWomen (for women)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwomen['’]?s\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForWomen (womens/women's)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bladies\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForWomen (ladies)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor\\s+men\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForMen (for men)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor\\s+men\\s+and\\s+women\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForMen exclusion (for men and women)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bmen['’]?s\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForMen (men's)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bmen['’]?s\\s+and\\s+women['’]?s\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "AUDIENCE-WHEN-LEAN dock: hasForMen exclusion (men's and women's)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\b(?:t[-\\s]?shirts?|tees?|shirts?|graphic\\s*tees?|hoodie|sweat\\s?shirts?|sweater|apparel|clothing|garments?|fabric|cotton|ring[-\\s]?spun|jersey|knit(?:ted)?|relaxed\\s*fit|regular\\s*fit|comfort\\s*colors|bella\\s*canvas|gildan|next\\s*level|unisex|m[ae]ns?|wom[ae]ns?|fashion|outfit|wardrobe|sleeves?|crew\\s?neck|tank\\s?tops?|garment[-\\s]?dyed|\\bdye\\b|wear|wearable)\\b/i",
    reason: "stop-list",
    note: "APPAREL_CONTAMINANTS — generic apparel/material stop-list, gender words are 2 of ~25 tokens",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^(?:m[ae]ns?|wom[ae]ns?|ladies)$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "BARE_GENDER_RE — whole-string exact-match gender predicate",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\s+(?:t[- ]?shirts?|tees?|tshirts?|shirts?|graphic|apparel|clothing|tops?|design|for|men|women|him|her|kids|adults|m[ae]n'?s|wom[ae]n'?s|unisex|gifts?)\\s*$/i",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "TRAIL_STRIP — trailing generic-word strip, gender words are 2 of ~20 tokens",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^(?:vintage|retro|classic|\\d{2,4}s?|t|tshirt|tshirts|tee|tees|shirt|shirts|hoodie|hoodies|sweatshirt|sweater|tank|top|tops|comfort|color|colors|graphic|graphics|soft|premium|quality|unisex|man|mans|men|mens|woman|womans|women|womens|ladies|youth|adult|kid|kids|toddler|baby|for|gift|gifts|funny|cute|cool|novelty|design|designs|apparel|clothing|crewneck|crew|long|short|sleeve|sleeves|cotton|ringspun|the|a|an|and|with|by|ideal|perfect|great)$/i",
    reason: "stop-list",
    note: "STOP — generic single-token stop-list, gender words are a handful of ~60 tokens",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^(t-?shirts?|tshirts?|shirts?|tees?|hoodies?|sweat\\w*|sweaters?|tanks?|graphics?|vintage|retro|classic|\\d{2}s|comfort|colou?rs?|apparel|clothing|garments?|premium|quality|soft|blank|unisex|m[ae]ns?|wom[ae]ns?|ladies)$/i",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "GENERIC_TAIL (trimGeneric) — strips generic edge tokens from a design-name candidate",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\s+for\\s+(?:men(?:\\s+and\\s+women)?|women(?:\\s+and\\s+men)?)\\s*$/i",
    reason: "tail-shape",
    filedFor: "title Phase 4",
    note: "audience-tail match+strip, 4 call sites (buildTitleFor variants)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\s+for\\s+(?:men|women)(?:\\s+and\\s+(?:men|women))?\\s*$/i",
    reason: "tail-shape",
    filedFor: "title Phase 4",
    note: "audience-tail match+strip variant (post enforceHardAudience repair)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor\\s+men\\s*$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "tailGender predicate (for men $)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor\\s+women\\s*$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "tailGender predicate (for women $)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwom[ae]ns?\\b|\\bladies\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "FEM_T/FEM_H/PAR_FEM/MT_FEM-style predicate (women/ladies), 4 call sites",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bm[ae]ns?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "MASC_T/MASC_H/PAR_MASC/MT_MASC-style predicate (men), 4 call sites",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^men$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "sgAud whole-string predicate (men)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^women$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "sgAud whole-string predicate (women)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor (?:men and women|women and men)\\b/gi",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "dedupeAudiencePhrases: strips the inclusive \"for men and women\" phrase",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor (men|women)\\s*$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "sg trailing single-gender match",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bfor (?:men and women|women and men)\\s*$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "inclusive-tail exclusion test",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwom[ae]ns?\\b|\\bladies\\b|\\bfemale\\b|\\bgirls?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "FEM_RE-style predicate w/ female+girls extras, 2 call sites",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bm[ae]ns?\\b|\\bmale\\b|\\bboys?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "MASC_RE-style predicate w/ male+boys extras, 2 call sites",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bwom[ae]n\\b|womens|ladies|female/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "mentionsWomen (true audience detection for the \"for Men\" regression guard)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/\\bm[ae]n\\b|mens|male/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "mentionsMen (same guard, masculine half)",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^(?:men|mens|man|male|boys?)$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "whole-string masc predicate (men/mens/man/male/boys), 2 call sites",
  },
  {
    file: "fba/listingPipeline.ts",
    literal: "/^(?:women|womens|woman|ladies|female|girls?)$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "whole-string fem predicate (women/womens/woman/ladies/female/girls), 2 call sites",
  },
  {
    file: "fba/lockedTitleTruth.ts",
    literal: "/\\bfor\\s+(?:m[ae]n|wom[ae]n)(?:['’]s)?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "GENDER_DISPLAY_RE — DISPLAY-ONLY warning-copy quote-finder, does not gate any verdict",
  },
  {
    file: "fba/poGoldCorpus.ts",
    literal: "/\\bfor\\s+men\\s+and\\s+women\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "PO gold corpus stat: inclusive \"for men and women\" count",
  },
  {
    file: "fba/poGoldCorpus.ts",
    literal: "/\\bfor\\s+(?:men|women)\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "PO gold corpus stat: single-gender \"for men\"/\"for women\" count",
  },
  {
    file: "fba/productTypeDefinitions.ts",
    literal: "/\\b(men|man|male|mens|boys?|guys?|gentlemen)\\b/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "coerceGenderToEnum — Amazon target_gender ATTRIBUTE coercion (different job: enum mapping, not content truth)",
  },
  {
    file: "fba/productTypeDefinitions.ts",
    literal: "/\\b(women|woman|female|womens|girls?|ladies|gals?)\\b/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "coerceGenderToEnum — feminine half",
  },
  {
    file: "fba/rankAnalysis.ts",
    literal: "/\\bwom[ae]ns?\\b|\\bladies\\b|\\bfemale\\b|\\bgirls?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "hard-lean keyword filter (rankAnalysis) — feminine half; functionally identical to nicheGuards.leanExcludesKeyword",
  },
  {
    file: "fba/rankAnalysis.ts",
    literal: "/\\bm[ae]ns?\\b|\\bmale\\b|\\bboys?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "hard-lean keyword filter (rankAnalysis) — masculine half",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/\\s+for\\s+(?:men(?:\\s+and\\s+women)?|women(?:\\s+and\\s+men)?|her|him|kids)\\s*$/i",
    reason: "tail-shape",
    filedFor: "title Phase 4",
    note: "titleBand.ts's OWN AUDIENCE_TAIL_RE — named explicitly by the reviewer/controller as OUT of this round",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/\\bwom[ae]ns?\\b|\\bladies\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "MONEY_FEM_RE — money-tail contradiction detector",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/\\bm[ae]ns?\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "MONEY_MASC_RE — money-tail contradiction detector",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/\\s+for\\s+(?:women|men)\\s*$/i",
    reason: "tail-shape",
    filedFor: "title Phase 4",
    note: "AUD_SUFFIX_RE — money-tail audience-suffix strip",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/women\\s*$/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "audTok predicate (trailing \"women\")",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/^(men|mens|men['’]s|guys|dudes|boys|him|his)$/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "classifyAudienceWord — inclusive-title contradiction detector, masculine (already carries guys/dudes/boys)",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/^(women|womens|women['’]s|ladies|gals|girls|her)$/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "classifyAudienceWord — inclusive-title contradiction detector, feminine (already carries gals/girls)",
  },
  {
    file: "fba/titleBand.ts",
    literal: "/\\b(?:men|mens|men['’]s|women|womens|women['’]s|ladies)\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "GENDERED_NOUN_RE — PO-ruled (2026-09-02) intentionally NARROWER audience-repeat dock predicate",
  },
  {
    file: "fba/titleCap.ts",
    literal: "/\\bfor Men (?:and|&) Women\\b|\\bMen['’]s (?:and|&) Women['’]s\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "hadInclusiveAudience predicate (capTitleReport truncation)",
  },
  {
    file: "fba/titleCap.ts",
    literal: "/\\s*\\b(?:for\\s+)?(?:Men|Women)[‘’]?s?(?:\\s(?:and|&))?$/i",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "capTitleReport: strips the inclusive-audience tail surviving a truncation cut",
  },
  {
    file: "fba/titleCap.ts",
    literal: "/\\s+(?:Men[‘’]?s?|Women[‘’]?s?)\\s+(?:Short|Long)$/i",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "capTitleReport: strips a dangling \"Men/Women Short/Long\" fragment after truncation",
  },
  {
    file: "fba/titleReferee.ts",
    literal: "/\\bfor women\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "titleReferee audience classifier (for women)",
  },
  {
    file: "fba/titleReferee.ts",
    literal: "/\\bfor (men|mens)\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "titleReferee audience classifier (for men/mens)",
  },
  {
    file: "fba/titleReferee.ts",
    literal: "/\\bmens\\b/i",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "titleReferee audience classifier (mens)",
  },
  {
    file: "keyword-engine/competitorFinder.ts",
    literal: "/\\s*[-–—]\\s*(for|ideal for)\\s+men\\s*[&,]\\s*women\\s*$/i",
    reason: "strip-net",
    filedFor: "title Phase 4",
    note: "buildSearchQueryFromTitle: strips \"for men & women\" suffix before a competitor search",
  },
  {
    file: "keyword-engine/keywordResearcher.ts",
    literal: "/\\bwom[ae]n\\b|\\bladies\\b/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "broadCategorySeed audience predicate (women/ladies), flag-off legacy path",
  },
  {
    file: "keyword-engine/keywordResearcher.ts",
    literal: "/\\bmen\\b/",
    reason: "predicate-twin",
    filedFor: "Task 9: convert to the core with a per-site pin",
    note: "broadCategorySeed audience predicate (men)",
  },
  {
    file: "keyword-engine/nicheGuards.ts",
    literal: "/\\b(?:shirts?|t-?shirts?|tshirts?|apparel|clothing|outfit|top|tank|hoodie|sweatshirt|wom[ae]ns?|m[ae]ns?|ladies|wife|husband|widow|funny|graphic|vintage|gift)\\b/i",
    reason: "stop-list",
    note: "GARMENT_CONTEXT — apparel/family-context stop-list (Check 6 in the review), gender words are 3 of ~18 tokens",
  },
]

describe('genderLexiconSingleSource — ONE lexicon enumeration test (fix round 1, I1)', () => {
  it('every gender-alternation regex/RegExp literal under src/lib is either a core composition or an explicitly allowlisted, classified legacy copy', () => {
    const offenders: string[] = []
    for (const file of listNonTestTsFiles(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8')
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/')
      for (const cand of findCandidates(src)) {
        if (!containsGenderToken(cand.literal)) continue
        if (isComposition(cand.literal)) continue
        const allowed = ALLOWLIST.some((a) => a.file === rel && a.literal === cand.literal)
        if (!allowed) offenders.push(`${rel}:${lineOf(src, cand.start)}  ${JSON.stringify(cand.literal)}`)
      }
    }
    expect(offenders, `Un-allowlisted gender-alternation copies found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('every allowlist entry still exists verbatim in its file (catches an entry that is now stale — the site was edited/removed and the allowlist was not)', () => {
    const stale: string[] = []
    const bySrcFile = new Map<string, string>()
    for (const entry of ALLOWLIST) {
      if (!bySrcFile.has(entry.file)) {
        bySrcFile.set(entry.file, fs.readFileSync(path.join(SRC_ROOT, entry.file), 'utf8'))
      }
      const src = bySrcFile.get(entry.file)!
      if (!src.includes(entry.literal)) stale.push(`${entry.file}  ${JSON.stringify(entry.literal)}`)
    }
    expect(stale, `Allowlist entries no longer found verbatim in their file:\n${stale.join('\n')}`).toEqual([])
  })

  it('per-class counts — the honest, corrected residue this round sizes for the follow-up (Task 9 / title Phase 4)', () => {
    const counts: Record<string, number> = {}
    for (const e of ALLOWLIST) counts[e.reason] = (counts[e.reason] ?? 0) + 1
    expect(counts).toEqual({
      'predicate-twin': 42,
      'strip-net': 14,
      'tail-shape': 4,
      'stop-list': 4,
    })
    expect(ALLOWLIST.length).toBe(64)
  })
})
