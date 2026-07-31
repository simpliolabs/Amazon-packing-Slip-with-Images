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
  /** Per-child copy — on multi-design these are the bytes the push PREFERS (pushFields ~:156), and
   *  they were shipping unmeasured: live 2026-07-31, B0F6QZ34B1 desc-only regen, broadcast 955 (in
   *  band, silent) while designs 2/3 fanned out at 889/877 under the 900 floor with NO census line.
   *  Aggregated to ONE violation per code (worst + count) so a 91-child family cannot log-storm. */
  perChildTitles?: readonly { sku?: string; designKey?: string; title: string }[]
  perChildBullets?: readonly { sku?: string; designKey?: string; bullets: readonly string[] }[]
  perChildDescriptions?: readonly { sku?: string; designKey?: string; description: string }[]
}

export interface ShipViolation {
  code:
    | 'TITLE_UNDER_BAND' | 'TITLE_OVER_CAP' | 'TITLE_WORD_REPEAT' | 'TITLE_DANGLING_SEPARATOR'
    | 'KEYWORDS_BELOW_FLOOR' | 'KEYWORDS_OVER_CAP'
    | 'BULLETS_COUNT' | 'BULLET_UNDER_MIN' | 'BULLET_OVER_MAX'
    | 'DESC_UNDER_FLOOR' | 'DESC_OVER_CEILING' | 'DESC_MISSING_DESIGN'
    // Per-child copy (the pushed bytes on multi-design). DISTINCT codes on purpose: Phase 3's
    // enforcement map keys on the broadcast codes, and a per-child shortfall must never route a
    // healthy BROADCAST into abort-and-preserve (R4 — that would freeze good copy over a fan-out
    // artifact). These stay measure-only until they earn their own enforcement decision.
    | 'PER_CHILD_TITLE_OVER_CAP' | 'PER_CHILD_TITLE_UNDER_BAND'
    | 'PER_CHILD_BULLET_UNDER_MIN' | 'PER_CHILD_BULLET_OVER_MAX'
    | 'PER_CHILD_DESC_UNDER_FLOOR' | 'PER_CHILD_DESC_OVER_CEILING'
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

  // ── PER-CHILD COPY — the pushed bytes on multi-design (pushFields prefers per_child_*). One
  // aggregated violation per code: worst offender + how many of how many, so a 91-child family
  // emits at most 6 lines, never a storm. Empty per-child sections are silent (same philosophy
  // as the broadcast checks: measure what shipped, not what didn't run).
  const childKey = (c: { sku?: string; designKey?: string }): string => c.designKey || c.sku || '?'
  const pushAgg = (code: ShipViolation['code'], offenders: { key: string; measured: number }[], bound: number, total: number): void => {
    if (!offenders.length) return
    const worst = offenders.reduce((a, b) => (Math.abs(b.measured - bound) > Math.abs(a.measured - bound) ? b : a))
    v.push({ code, measured: worst.measured, bound, detail: `${worst.key} (${offenders.length} of ${total})` })
  }
  const pcT = (input.perChildTitles ?? []).filter((c) => (c.title || '').trim())
  if (pcT.length) {
    pushAgg('PER_CHILD_TITLE_OVER_CAP', pcT.filter((c) => c.title.trim().length > C.title.hardCap).map((c) => ({ key: childKey(c), measured: c.title.trim().length })), C.title.hardCap, pcT.length)
    if (input.apparel) pushAgg('PER_CHILD_TITLE_UNDER_BAND', pcT.filter((c) => c.title.trim().length <= C.title.hardCap && c.title.trim().length < C.title.goldenBandLo).map((c) => ({ key: childKey(c), measured: c.title.trim().length })), C.title.goldenBandLo, pcT.length)
  }
  const pcB = (input.perChildBullets ?? []).filter((c) => (c.bullets ?? []).some((b) => (b || '').trim()))
  if (pcB.length) {
    const worstLenOf = (c: { bullets: readonly string[] }, pick: 'min' | 'max'): number => {
      const lens = c.bullets.filter((b) => (b || '').trim()).map((b) => b.length)
      return pick === 'min' ? Math.min(...lens) : Math.max(...lens)
    }
    pushAgg('PER_CHILD_BULLET_OVER_MAX', pcB.filter((c) => worstLenOf(c, 'max') > C.bullets.max).map((c) => ({ key: childKey(c), measured: worstLenOf(c, 'max') })), C.bullets.max, pcB.length)
    if (input.apparel) pushAgg('PER_CHILD_BULLET_UNDER_MIN', pcB.filter((c) => worstLenOf(c, 'min') < C.bullets.min).map((c) => ({ key: childKey(c), measured: worstLenOf(c, 'min') })), C.bullets.min, pcB.length)
  }
  if (!degraded.has('description')) {
    const pcD = (input.perChildDescriptions ?? []).filter((c) => visibleLen(c.description) > 0)
    if (pcD.length) {
      pushAgg('PER_CHILD_DESC_OVER_CEILING', pcD.filter((c) => visibleLen(c.description) > C.description.ceiling).map((c) => ({ key: childKey(c), measured: visibleLen(c.description) })), C.description.ceiling, pcD.length)
      if (input.apparel) pushAgg('PER_CHILD_DESC_UNDER_FLOOR', pcD.filter((c) => visibleLen(c.description) <= C.description.ceiling && visibleLen(c.description) < C.description.floor).map((c) => ({ key: childKey(c), measured: visibleLen(c.description) })), C.description.floor, pcD.length)
    }
  }

  return v
}
