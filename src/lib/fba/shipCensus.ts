/**
 * shipCensus.ts — MEASUREMENT-ONLY inspection of the bytes that are about to persist.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Phase 2 of handoff/FOUNDATION_SHIP_DOOR_PLAN.md, deliberately measure-only: it MUTATES NOTHING
 * and therefore cannot regress anything. It exists because of a same-day live specimen
 * (B0GR22ZHBW, 2026-07-30 19:41): the backend degrade gate measured a healthy string, PASSED, and
 * the editorial audit then deleted tokens down to 118 bytes — which persisted, because nothing
 * measures after the audit. This morning the same listing ABORTED at 194, because that run happened
 * to be short at gate time. Same pipeline, opposite outcomes, decided by WHEN the measurement ran.
 *
 * The census runs at `scrubPublished` — the ONE exit every path passes through — on the exact
 * PipelineResult being returned, and emits one JSON line per violation. It answers, with live
 * frequencies instead of inference, the question every phase after this depends on: which
 * invariants are actually being broken at the exit, on which paths, how often.
 *
 * NOT A JUDGE OF QUALITY (anti-Goodhart section of the plan): a run with zero violations has
 * in-band, structurally sound copy — it may still be bad copy. The census proves bands, never worth.
 *
 * Pure leaf: no pipeline imports, no env reads, no I/O. The caller passes every fact.
 */

import { CONTENT_CONTRACT } from './contentContract'

export interface ShipCensusInput {
  /** Which exit produced this result. */
  exit: 'full' | 'title' | 'bullets' | 'keywords' | 'description'
  apparel: boolean
  title: string
  bullets: readonly string[]
  /** Visible-character description source (HTML allowed; tags are stripped for length). */
  description: string
  /** Per-child backend strings — the bytes that PATCH Amazon. */
  perChildKeywords: readonly { asin?: string; sku?: string; keywords: string }[]
  /** The resolved design name, when known — lets the census flag copy that never mentions its own
   *  design (the original "Valentine not in Descriptions" disease, seen again 2026-07-30 as a
   *  917-char description with zero anniversary/vow/renewal words). */
  designName?: string | null
  /** Sections a producing stage already declared degraded — the census must not double-report. */
  degradedSections?: readonly string[]
}

export interface ShipViolation {
  code:
    | 'TITLE_UNDER_BAND' | 'TITLE_OVER_CAP' | 'TITLE_WORD_REPEAT' | 'TITLE_DANGLING_SEPARATOR'
    | 'KEYWORDS_BELOW_FLOOR' | 'KEYWORDS_OVER_CAP'
    | 'BULLETS_COUNT' | 'BULLET_UNDER_MIN' | 'BULLET_OVER_MAX'
    | 'DESC_UNDER_FLOOR' | 'DESC_OVER_CEILING' | 'DESC_MISSING_DESIGN'
  /** The measured number that tripped it (length/bytes/count). */
  measured: number
  /** The bound it violated, from CONTENT_CONTRACT — never a local literal. */
  bound: number
  detail?: string
}

const CONNECTORS = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', 'in', 'to', 'or', 'by', '&', '|'])

/** Byte length as Amazon counts backend keywords. */
const byteLen = (s: string): number => new TextEncoder().encode(s || '').length

const visibleLen = (html: string): number => (html || '').replace(/<[^>]*>/g, '').length

/**
 * Inspect one result. Pure; returns the violations, mutates nothing.
 * A non-apparel result only checks structural facts (counts, caps) — length bands are
 * apparel-calibrated and a short non-apparel title is legitimately short.
 */
export function shipCensus(input: ShipCensusInput): ShipViolation[] {
  const v: ShipViolation[] = []
  const C = CONTENT_CONTRACT
  const degraded = new Set(input.degradedSections ?? [])

  // ── TITLE ──
  const t = (input.title || '').trim()
  if (t) {
    if (t.length > C.title.hardCap) v.push({ code: 'TITLE_OVER_CAP', measured: t.length, bound: C.title.hardCap })
    else if (input.apparel && t.length < C.title.goldenBandLo) {
      v.push({ code: 'TITLE_UNDER_BAND', measured: t.length, bound: C.title.goldenBandLo })
    }
    if (/[|,;:]\s*$/.test(t)) v.push({ code: 'TITLE_DANGLING_SEPARATOR', measured: t.length, bound: 0, detail: t.slice(-8) })
    // Repeated significant word — the "Tshirt, Tshirt" class. Letters-only comparison so
    // punctuation cannot hide a duplicate; connectors are allowed to repeat.
    const seen = new Set<string>()
    for (const w of t.split(/\s+/)) {
      const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!bare || CONNECTORS.has(bare)) continue
      if (seen.has(bare)) { v.push({ code: 'TITLE_WORD_REPEAT', measured: t.length, bound: 1, detail: bare }); break }
      seen.add(bare)
    }
  }

  // ── BACKEND KEYWORDS — the 118-byte class. Measured HERE because this is after every mutating
  // stage; the producing gate measured before the audit and passed a string the audit then gutted. ──
  if (input.perChildKeywords.length > 0 && !degraded.has('backend_keywords')) {
    const floor = C.keywords.minStrict // 220 — the doctrine floor; the census reports, never throws
    let worst: { bytes: number; sku?: string } | null = null
    for (const c of input.perChildKeywords) {
      const b = byteLen(c.keywords)
      if (worst === null || b < worst.bytes) worst = { bytes: b, sku: c.sku }
      if (b > C.keywords.byteCap) v.push({ code: 'KEYWORDS_OVER_CAP', measured: b, bound: C.keywords.byteCap, detail: c.sku })
    }
    if (worst && worst.bytes < floor) {
      v.push({ code: 'KEYWORDS_BELOW_FLOOR', measured: worst.bytes, bound: floor, detail: worst.sku })
    }
  }

  // ── BULLETS ──
  const bl = input.bullets.filter((b) => (b || '').trim().length > 0)
  if (bl.length > 0) {
    if (bl.length !== C.bullets.count) v.push({ code: 'BULLETS_COUNT', measured: bl.length, bound: C.bullets.count })
    for (const b of bl) {
      if (b.length > C.bullets.max) v.push({ code: 'BULLET_OVER_MAX', measured: b.length, bound: C.bullets.max })
      else if (input.apparel && b.length < C.bullets.min) v.push({ code: 'BULLET_UNDER_MIN', measured: b.length, bound: C.bullets.min })
    }
  }

  // ── DESCRIPTION ──
  const dLen = visibleLen(input.description)
  if (dLen > 0) {
    if (dLen > C.description.ceiling) v.push({ code: 'DESC_OVER_CEILING', measured: dLen, bound: C.description.ceiling })
    else if (input.apparel && dLen < C.description.floor) v.push({ code: 'DESC_UNDER_FLOOR', measured: dLen, bound: C.description.floor })
    // The design's own subject must appear SOMEWHERE in its description — the original PO complaint
    // ("Valentine not in Descriptions"), and again live 2026-07-30 (917 chars, zero anniversary
    // words while the design name was "We Still Do" = an anniversary design). ANY significant
    // design-name token counts as a mention; connectors don't.
    const dn = (input.designName || '').trim()
    if (dn) {
      const body = ` ${input.description.toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9\s]/g, ' ')} `
      const toks = dn.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !CONNECTORS.has(w))
      const mentioned = toks.length === 0 || toks.some((w) => body.includes(` ${w} `))
      if (!mentioned) v.push({ code: 'DESC_MISSING_DESIGN', measured: dLen, bound: 1, detail: dn })
    }
  }

  return v
}
