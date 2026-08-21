/**
 * itemHighlightComposer.ts — Architecture A (PO sign-off 2026-08-20): the pool-first Item
 * Highlights composer. DETERMINISTIC, no LLM.
 *
 * WHY. The PO rejected the brief-driven batch outright ("THESE ARE TERRIBLE!!!"): the LLM led
 * every family with beige filler ("Casual Apparel"), followed one template skeleton, mashed specs
 * ("Cotton Relaxed Unisex Fit") and used ONE pool phrase where the pool held five. The endorsed
 * competitor line is the family's TOP RANKING KEYWORDS arranged with variety — an ALLOCATION the
 * pool's own measured data already decides. So code composes: the line is verbatim pool phrases BY
 * CONSTRUCTION and beige is structurally impossible (there is no slot for invented classes).
 *
 * SELECTION: theme-fit first (3 → 0, null last), then volume; only phrases the shipping TITLES do
 * not already cover (the repo's ONE coverage predicate); each pick must add a new folded
 * significant token (near-dupes can't stack); garment-noun surface variety is rewarded (shirts /
 * tees / apparel / top as DISTINCT indexed tokens — the competitor craft); the running line
 * respects Amazon's ≤2 per-word rule and the 125-char contract budget, aiming into the 110-125
 * fill band. The PO's wear-style fact "Can be worn as Oversized" (ruling 2026-08-20) joins when
 * the blank is a relaxed/unisex cut, the pool shows oversized demand, and budget allows.
 *
 * Thin pools (<MIN_CANDIDATES usable phrases) return null — the caller's existing LLM/spec
 * fallback chain remains the degradation path. Downstream nets (repeat cap, blank-brand waterfall)
 * still run on the returned string; this module never re-implements them.
 */
import { CONTENT_CONTRACT } from './contentContract'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage-core'
import { ihFoldWord, IH_INSIGNIFICANT, ihRepeatViolations } from './productDetailAttrs'
import { scrubTrademarks } from './trademarkGuard'
import { trueWeightClass, type BlankSpec } from './blankSpecs'

export interface ComposerPoolRow {
  keyword: string
  searchVolume?: number | null
  themeFit?: number | null
}

/** Competitor blank/apparel makers — never composable unless the family's own allowed brand.
 *  The trademark lexicon covers franchises/marks, not blanks (the Darlin' pool composed
 *  "Pro Club Shirts" straight through it). */
const APPAREL_BRAND_RE = /\b(?:pro\s?club|gild[ae]n|guildan|softstyle|heavy\s?cotton\s?brand|hanes|fruit\s+of\s+the\s+loom|next\s+level|bella\s?canvas|american\s+apparel|champion|carhartt|comfort\s+colors)\b/i
const MIN_CANDIDATES = 3
const GARMENT_SURFACE_RE = /\b(?:t[-\s]?shirts?|tees?|tshirts?|shirts?|apparel|tops?|clothing|hoodies?|sweatshirts?|garments?)\b/i

/** Acronyms/initialisms keep their canonical ALL-CAPS form — "Sd Card 32gb" and "Usa Soccer"
 *  read amateur on a customer-facing line (found on the Electronics family, 2026-08-21). */
const ACRONYM_CASE: Record<string, string> = {
  sd: 'SD', sdhc: 'SDHC', sdxc: 'SDXC', microsd: 'MicroSD', usb: 'USB', hdmi: 'HDMI',
  usa: 'USA', uk: 'UK', led: 'LED', hd: 'HD', tv: 'TV', gps: 'GPS', diy: 'DIY',
}
/** Title Case a pool phrase without disturbing its wording (the token sequence is what ranks).
 *  Exported as THE customer-facing IH caser — the spec fallback ships through it too, so both
 *  producer paths case with one implementation (acronym caps included). Length-preserving. */
export const titleCasePhrase = (p: string): string =>
  p.split(/\s+/).map((w) => {
    const lower = w.toLowerCase()
    if (ACRONYM_CASE[lower]) return ACRONYM_CASE[lower]
    const unit = lower.match(/^(\d+)(gb|tb|mb|k)$/)          // 32gb → 32GB, 4k → 4K
    if (unit) return unit[1] + unit[2].toUpperCase()
    return IH_INSIGNIFICANT.has(lower) ? lower : w.charAt(0).toUpperCase() + w.slice(1)
  }).join(' ')
    .replace(/^./, (c) => c.toUpperCase())

/** ONE humanizer for any spec/attribute-derived MACHINE TOKEN that reaches customer copy
 *  (live B0GQ6PGR2N: Item Highlights shipped raw "short_sleeve"). Enum detail rows deliberately
 *  STORE the Amazon API token — push needs it, and the editor prettifies at display only — so any
 *  producer composing copy FROM spec rows must humanize at ITS seam: underscores → spaces, then
 *  the shared Title Case above (acronym caps preserved). Values without underscores pass through
 *  untouched — already-human labels ("Crew Neck") are not re-cased here. */
export function humanizeSpecToken(value: string): string {
  const v = (value ?? '').trim()
  if (!v.includes('_')) return v
  return titleCasePhrase(v.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim())
}

/** Gender/audience irregular plurals fold together (woman≡women, ladies≡lady, man≡men) — without
 *  this, "alligator shirt women" + "alligator shirts woman" both pass novelty and the line becomes
 *  the exact permutation-spam the PO rejected. */
const GENDER_FOLDS: Record<string, string> = { women: 'woman', men: 'man', ladies: 'lady', gals: 'gal' }
const significantFolded = (phrase: string): string[] =>
  phrase.toLowerCase().split(/\s+/)
    .map((w) => { const f = ihFoldWord(w); return GENDER_FOLDS[f] ?? f })
    .filter((w) => w && !IH_INSIGNIFICANT.has(w))

/**
 * Compose the Item Highlights line from the rated pool. Returns null when the pool cannot carry
 * the structure (caller falls back). `titles` = every title the shipped IH will sit beside.
 */
export function composeItemHighlight(
  pool: ComposerPoolRow[],
  titles: string[],
  opts?: { relaxedOrUnisexCut?: boolean; spec?: Pick<BlankSpec, 'weightNote' | 'stretch' | 'material' | 'fit' | 'neck' | 'sleeve' | 'dye'> | null; garmentFamily?: 'tee' | 'sweatshirt' | 'hoodie' | 'hat' | 'none' | null; allowedBrand?: string | null },
): string | null {
  const titleCovers = makeCoverageChecker(titles.filter(Boolean).join(' '))
  // The PO wear-style fact reserves its budget UP FRONT when eligible — otherwise the greedy fill
  // reaches the band first and the fact never fits (test-caught design gap).
  const OVERSIZED_FACT = 'Can be worn as Oversized'
  const factEligible = !!opts?.relaxedOrUnisexCut && pool.some((r) => /\bover[\s-]?sized?\b/i.test(r.keyword))
  const RESERVE = factEligible ? OVERSIZED_FACT.length + 2 : 0
  const MAX = CONTENT_CONTRACT.itemHighlights.max - RESERVE
  const AIM = CONTENT_CONTRACT.itemHighlights.fillTarget - RESERVE

  // FIT GATE on RATED pools (2026-08-20, the "Disney World Shirts"/"Band Tees" drift): when the
  // rater has judged a meaningful share of the pool, TRUST the judgment — candidates must carry
  // themeFit >= 1, so off-design harvest noise (high-volume, unrated or fit-0) cannot compose.
  // Unrated/legacy pools keep volume ordering (there is no judgment to trust).
  const ratedShare = pool.length ? pool.filter((r) => typeof r.themeFit === 'number').length / pool.length : 0
  const requireFit = ratedShare >= 0.3

  // Candidates: 2-5 word pool phrases the titles don't cover, ranked theme-fit DESC then volume DESC.
  // 2026-08-21: every null branch below names itself — two 6014 families returned null WITH a full
  // spec available and nobody could say which filter starved them. A silent null is a guess factory.
  const why = { pool: pool.length, ratedShare: Math.round(ratedShare * 100), requireFit, afterFit: 0, candidates: 0, picked: 0, lineLen: 0 }
  const nullOut = (stage: string): null => { console.log(JSON.stringify({ tag: 'IH_COMPOSER_NULL', stage, ...why })); return null }
  const candidates = pool
    .filter((r) => !!r.keyword)
    .filter((r) => !requireFit || (typeof r.themeFit === 'number' && r.themeFit >= 1))
    .map((r) => { why.afterFit++; return { ...r, keyword: r.keyword.trim() } })
    .filter((r) => {
      const words = r.keyword.split(/\s+/).length
      // PO ruling 2026-08-20: a bare "Oversized <garment>" pool phrase is a CUT claim — excluded
      // here always; oversized demand surfaces only as the sanctioned wear-style fact below.
      if (/\bover[\s-]?sized?\b/i.test(r.keyword)) return false
      // TRUTH FILTERS (2026-08-20, the Darlin' F-grade: "Pro Club Shirts, Heavyweight T Shirts,
      // Comfort Colors Sweatshirt" composed straight from a dirty pool — the composer is a mirror;
      // these keep a rotten pool from composing lies):
      // (a) third-party marks — the trademark door must pass the phrase byte-identical;
      if (scrubTrademarks(r.keyword) !== r.keyword) return false
      // (a2) competitor APPAREL brands — outside the trademark lexicon (it covers franchises, not
      // blanks): a pool row naming another maker never composes. The family's own allowed blank
      // brand (brand_in_copy, e.g. Comfort Colors) is exempted by name.
      {
        const bm = r.keyword.match(APPAREL_BRAND_RE)
        if (bm && bm[0].toLowerCase() !== (opts?.allowedBrand ?? '').toLowerCase()) return false
      }
      // (b) fabric-class truth — a weight-class word must match the blank (unknown blank ⇒ none);
      {
        const m = r.keyword.match(/\b(light|mid|middle|heavy)[\s-]?weight\b/i)
        if (m) {
          const wt = trueWeightClass(opts?.spec)
          if (!wt || !wt.startsWith(m[1].toLowerCase().slice(0, 3))) return false
        }
      }
      // (c) wrong-garment truth — a tee family never claims sweatshirt/hoodie vocab, and vice versa.
      // 'none' = NON-APPAREL (PO ruling 2026-08-21: B0GCF11RKL is Electronics — its pool's apparel
      // keywords were the contamination, and the composer put "T Shirts for Women" on a memory
      // card). A non-apparel family composes NO garment vocabulary at all.
      if (opts?.garmentFamily === 'none' && GARMENT_SURFACE_RE.test(r.keyword)) return false
      if (opts?.garmentFamily === 'tee' && /\b(?:sweatshirts?|hoodies?|crewnecks?)\b/i.test(r.keyword)) return false
      if ((opts?.garmentFamily === 'sweatshirt' || opts?.garmentFamily === 'hoodie') && /\b(?:tees?|t[\s-]?shirts?|tshirts?)\b/i.test(r.keyword)) return false
      return words >= 2 && words <= 5 && !titleCovers(r.keyword)
    })
    .sort((a, b) => {
      const tf = (x: ComposerPoolRow) => (typeof x.themeFit === 'number' ? x.themeFit : -1)
      if (tf(b) !== tf(a)) return tf(b) - tf(a)
      return (b.searchVolume ?? 0) - (a.searchVolume ?? 0)
    })
  why.candidates = candidates.length
  if (candidates.length < MIN_CANDIDATES) return nullOut('too-few-candidates')

  const picked: string[] = []
  const usedFolded = new Set<string>()
  const usedGarmentSurfaces = new Set<string>()
  const lineLen = () => picked.reduce((n, p, i) => n + p.length + (i ? 2 : 0), 0)
  const brandRe = opts?.allowedBrand
    ? new RegExp('\\b' + opts.allowedBrand.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*') + '\\b', 'i')
    : null

  // Two passes: first prefer candidates introducing a NEW garment surface (the variety craft),
  // then fill remaining budget with any novel candidate.
  for (const preferNewGarment of [true, false]) {
    for (const c of candidates) {
      if (picked.length >= 7 || lineLen() >= AIM) break
      const phrase = titleCasePhrase(c.keyword)
      if (picked.includes(phrase)) continue
      const folded = significantFolded(c.keyword)
      if (!folded.some((w) => !usedFolded.has(w))) continue            // must add something new
      const gm = c.keyword.match(GARMENT_SURFACE_RE)?.[0]?.toLowerCase().replace(/[-\s]/g, '').replace(/s$/, '')
      if (preferNewGarment && gm && usedGarmentSurfaces.has(gm)) continue
      if (preferNewGarment && !gm) continue
      const nextLen = lineLen() + (picked.length ? 2 : 0) + phrase.length
      if (nextLen > MAX) continue
      const draft = [...picked, phrase].join(', ')
      if (ihRepeatViolations(draft).length > 0) continue               // Amazon's ≤2 per-word rule
      // PO ruling 2026-08-21 (B0GWFFK1W7 "comfort colors tshirt, comfort colors graphic tee…" —
      // "repeating CC 2 times"): the blank brand appears in AT MOST ONE picked phrase. Amazon's
      // ≤2-per-word cap allows two; the PO does not.
      if (brandRe && brandRe.test(phrase) && picked.some((pp) => brandRe.test(pp))) continue
      picked.push(phrase)
      folded.forEach((w) => usedFolded.add(w))
      if (gm) usedGarmentSurfaces.add(gm)
    }
  }
  why.picked = picked.length
  if (picked.length < MIN_CANDIDATES) return nullOut('too-few-picked')

  // PO ruling 2026-08-20: the wear-style FACT for relaxed/unisex cuts (budget reserved above).
  // Never bare "Oversized <garment>" from here — cut claims are blank_specs territory and such
  // pool phrases are excluded in the candidate filter.
  if (
    factEligible &&
    !usedFolded.has(ihFoldWord('oversized')) &&
    ihRepeatViolations([...picked, OVERSIZED_FACT].join(', ')).length === 0
  ) {
    picked.push(OVERSIZED_FACT)
  }

  // PO RULING 2026-08-21, verbatim "44 is NEVER approved, MIN 85% of MAX 125": an under-min line
  // never ships. Pad toward the floor with TRUE spec facts (blank_specs values — never invented),
  // each passing the same novelty + repeat gates as pool phrases. A family that cannot truthfully
  // reach the floor returns NOT-READY (null) — the caller's fallback/hold path decides, but a
  // short line is not a shippable outcome from here.
  const MIN = CONTENT_CONTRACT.itemHighlights.min
  if (lineLen() < MIN && opts?.spec) {
    const sp = opts.spec
    const factFillers = [
      sp.material || '',
      sp.fit ? `${sp.fit} Fit` : '',
      sp.neck || '',
      sp.sleeve || '',
      sp.dye ? `${sp.dye} Fabric` : '',
    ].filter(Boolean)
    for (const f of factFillers) {
      if (lineLen() >= MIN) break
      const phrase = titleCasePhrase(f)
      if (picked.includes(phrase)) continue
      const folded = significantFolded(f)
      if (!folded.some((w) => !usedFolded.has(w))) continue
      if (lineLen() + 2 + phrase.length > CONTENT_CONTRACT.itemHighlights.max) continue
      if (ihRepeatViolations([...picked, phrase].join(', ')).length > 0) continue
      picked.push(phrase)
      folded.forEach((w) => usedFolded.add(w))
    }
  }
  why.picked = picked.length; why.lineLen = lineLen()
  if (lineLen() < MIN) return nullOut('under-floor-after-pad')

  // Scrub parity with the LLM path (defense in depth — candidates are already door-clean, but the
  // wear-fact join and future edits must never reopen the trademark door).
  return scrubTrademarks(picked.join(', '))
}
