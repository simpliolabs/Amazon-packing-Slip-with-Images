'use client'

import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isPushableDetail, unpushableReason, isItemHighlightsField, isSingleDesignOnlyKey, isSingleDesignOnlyDetail, SINGLE_DESIGN_ONLY_LEAK_REASON } from '@/lib/fba/productDetailAttrs'
import { SECTION_WEIGHTS, weightedPoints } from '@/lib/fba/scoreWeights'
import { missingBulletKeywords } from '@/lib/keyword-engine/bulletCoverage'   // SAME token predicate the scorer/generator use (R5: no .includes())
import { stripVariantSuffix, squashEquals } from '@/lib/fba/pushFields'      // SAME comparator/suffix-strip the server deriver + verify use (ship-truth 2026-07-09)
import { groupByDesign, isMultiDesign, resolveMultiDesign, perChildValueResolver, perDesignEntries, type PerDesignGroup } from '@/lib/fba/perDesign'
import { PerDesignCard } from '@/components/fba/PerDesignCard'
import { ModalShell, ModalCloseButton } from '@/components/fba/ModalShell'
import RankAnalysisPanel from './RankAnalysisPanel'
import type { RankAnalysisResult } from '@/lib/fba/rankAnalysis'
import { ScoreSparkline, type SparklinePoint } from '@/components/fba/ScoreSparkline'
import { presentOutcome, MEASURE_TARGET, type OutcomeChip } from '@/lib/fba/outcomePresentation'
// Using <img> instead of next/image to avoid domain config issues with Amazon CDN

// ─── Types (mirrored from fba/page.tsx) ─────────────────────────────────────

interface SeoIssue { field: string; message: string; severity: 'error' | 'warning' | 'info'; auto_fixable?: boolean }

interface ChildContentRow {
  sku: string; asin: string; parent_asin: string
  title: string | null; bullet_1: string | null; bullet_2: string | null
  bullet_3: string | null; bullet_4: string | null; bullet_5: string | null
  description: string | null; backend_keywords: string | null
  image_count: number; has_aplus: boolean; aplus_module_count: number
  aplus_has_brand_story: boolean; aplus_has_headline: boolean
  aplus_images_missing_alt: number; content_synced_at: string
}

interface SeoScoreRow {
  parent_asin: string; title_score: number; bullet_score: number
  keyword_score: number; aplus_score: number
  description_score: number | null; features_score: number | null; overall_score: number
  issues: SeoIssue[]; child_count: number; child_override_count: number
  top_child_asin: string | null; product_title: string | null
  image_url: string | null; total_units_30d: number; scored_at: string
  audience_lean?: string | null
  children: ChildContentRow[]
}

interface KeywordReconciliation {
  keyword: string; action_type: 'CRITICAL' | 'UPGRADE' | 'REINFORCE'
  search_volume: number; placed_in: string[]; exact_text: string; why: string
}

interface PerChildKeywords { sku: string; asin: string; keywords: string }

interface VariantCorrection { sku: string; field: string; current: string; replace_with: string; reason: string }
interface CannibalizationWarning { keyword: string; affected_skus: string[]; issue: string; recommendation: string }
interface ProductDetailImprovement { field_name: string; current_value: string | null; recommended_value: string; reason: string; is_enum?: boolean; enum_valid?: boolean; enum_accepted?: string[]; normalized_from?: string; sp_api_key?: string; attr_scope?: 'broadcast' | 'per-variant'; pushable?: boolean }

/** Some Amazon enums store machine tokens, not labels — SHIRT sleeve accepts "short_sleeve"
 *  while the editor displays "Short Sleeve" (PO: "Short_sleeve should be Short Sleeve").
 *  The stored/pushed value must stay the API token (that's what the schema accepts), so
 *  prettify at DISPLAY only: exact label from the row's accepted list when one matches,
 *  else Title-Case the snake token. Human-looking values pass through untouched. */
const squashEnumVal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
function prettyDetailValue(value: string | null | undefined, accepted?: string[]): string {
  const v = (value ?? '').trim()
  if (!v || !/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(v)) return v
  const hit = (accepted ?? []).find((a) => squashEnumVal(a) === squashEnumVal(v))
  if (hit) return hit
  return v.split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}

interface AplusModuleAction {
  module_type: string; action: 'ADD' | 'EDIT' | 'KEEP'
  content_brief: string; position: number
}

interface ActionPlanItem {
  element: string; level: 'parent' | 'per_child'
  verdict: 'REPLACE' | 'EDIT' | 'CREATE' | 'DONE' | 'SKIP'
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
  current_status: string; instruction: string
  replacement_content?: string | string[] | Record<string, unknown>[] | null
  seller_central_path?: string; content_ready?: boolean
  notes?: string; aplus_modules?: AplusModuleAction[]
}

interface PerChildTitle { sku: string; asin: string; title: string; designName?: string | null; designKey?: string | null }
interface PerChildBullets { sku: string; asin: string; bullets: string[]; designName?: string | null; designKey?: string | null }
interface PerChildDescription { sku: string; asin: string; description: string; designName?: string | null; designKey?: string | null }

interface AiRecommendations {
  parent_asin: string; recommended_title: string; recommended_bullets: string[]
  /** 'manual' = the seller pushed their own title; it's LOCKED against whole-listing regens (044). */
  title_source?: string
  recommended_keywords: string; per_child_keywords?: PerChildKeywords[]
  /** Per-child titles for capacity variation families (SD cards 64/128/256GB). When present,
   *  each child carries its own capacity instead of a single broadcast title. */
  per_child_titles?: PerChildTitle[]
  per_child_bullets?: PerChildBullets[]
  per_child_descriptions?: PerChildDescription[]
  recommended_description: string; variant_corrections: VariantCorrection[]
  cannibalization_warnings?: CannibalizationWarning[]
  product_details_improvements?: ProductDetailImprovement[]
  keyword_reconciliation?: KeywordReconciliation[]
  action_plan?: ActionPlanItem[]
  generated_at: string; keyword_opportunities_used?: number
  /** Last ACCEPTED push timestamp per field (title/bullets/description/keywords, details:<key>),
   *  from keyword_push_log — surfaced as "Shipped <date>" on each shippable row. */
  field_pushed_at?: Record<string, string>
  /** Server-probed: Amazon's Listings API currently accepts title_differentiation writes.
   *  Undefined on legacy responses → client treats Item Highlights as still write-blocked. */
  item_highlights_writable?: boolean
}

/** Compact relative date for audit/ship timestamps ("2h ago", "3d ago", "Jun 11"). */
function relDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days <= 7) return `${days}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface AnalyzedKeyword {
  keyword: string; opportunityScore: number
  actionType: 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED' | 'IRRELEVANT'
  actionText: string; rationale: string; urgency: string; estimatedImpact: string
  searchVolume: number; keywordSales: number; competingProducts: number
  asinImpressionShare: number; asinClickShare: number; asinPurchaseShare: number
  inTitle: boolean; inBullets: boolean; inDescription: boolean; inBackend: boolean
  titleDensity?: number | null
  organicRank?: number | null
  prevOrganicRank?: number | null
  dataSource: string
}

interface KeywordIntelligenceResult {
  asin: string; analyzedAt: string; dataSource: string
  totalKeywordsAnalyzed: number; topOpportunities: AnalyzedKeyword[]
  summary: { critical: number; upgrade: number; reinforce: number; defended: number; optimized: number }
  apiUsage?: { used: number; limit: number; remaining: number; provider: string }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function barColor(score: number, max: number) {
  const pct = score / max
  if (pct >= 0.8) return 'bg-green-500'
  if (pct >= 0.6) return 'bg-amber-500'
  return 'bg-red-500'
}

function issueBorder(field: string) {
  if (field.includes('title')) return 'border-l-blue-500'
  if (field.includes('bullet') || field.includes('description')) return 'border-l-green-500'
  if (field.includes('keyword') || field.includes('backend')) return 'border-l-amber-500'
  if (field.includes('aplus') || field.includes('image')) return 'border-l-purple-500'
  return 'border-l-slate-400'
}

function copyToClipboard(text: string) {
  if (typeof window !== 'undefined') navigator.clipboard.writeText(text)
}

// stripVariantSuffix moved to pushFields (ship-truth 2026-07-09) — the server deriver needs the
// SAME suffix-strip the header/cohesion use, so there is exactly one implementation (imported above).

// Strip a storage-capacity token ("64GB", "1 TB") from a title — used to render the capacity-
// AGNOSTIC parent / variation-hub title for capacity-variation families (SD cards by GB). The
// stored product_title is the best-seller CHILD's title, so it carries that child's capacity; the
// parent header must not. Shared by the page header and the TITLES card's PARENT row so the two
// can never drift.
function stripCapacityToken(title: string | null | undefined): string {
  return (title ?? '')
    .replace(/\b\d{1,4}\s?(?:GB|TB|MB)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Dedup variant rows by ASIN (prefer the FBA SKU). The same ASIN can have both an FBA and an
// FBM SKU; backend keywords are per-ASIN, so the page (and the push) should treat them as one.
function dedupByAsin<T extends { sku: string; asin: string }>(rows: T[]): T[] {
  const byAsin = new Map<string, T>()
  for (const c of rows) {
    const existing = byAsin.get(c.asin)
    if (!existing || c.sku.endsWith('-FBA')) byAsin.set(c.asin, c)
  }
  return [...byAsin.values()].sort((a, b) => a.sku.localeCompare(b.sku))
}

// ─── Inline icons (SVG, not emoji — crisp at any size, consistent stroke) ─────
type IconProps = { className?: string }
const Icon = {
  ArrowLeft: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>),
  Sparkles: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM5 19l.6 1.6L7 21l-1.4.6L5 23l-.6-1.4L3 21l1.4-.4L5 19z" /></svg>),
  Send: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>),
  Clipboard: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>),
  External: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" /></svg>),
  Layers: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>),
  Tag: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" /><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none" /></svg>),
  Check: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>),
  History: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 106 5.3L3 8" /><path d="M12 7v5l4 2" /></svg>),
  Chevron: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>),
  Activity: (p: IconProps) => (<svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>),
}

/** Animated SVG progress ring for the overall 0-100 listing score. */
function ScoreRing({ score }: { score: number }) {
  const r = 32
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, score / 100))
  const stroke = score >= 80 ? '#16a34a' : score >= 60 ? '#d97706' : '#dc2626'
  return (
    <div className="relative flex-shrink-0" style={{ width: 84, height: 84 }}>
      <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
        <circle cx="42" cy="42" r={r} fill="none" stroke="#e2e8f0" strokeWidth="7" />
        <circle cx="42" cy="42" r={r} fill="none" stroke={stroke} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: 'stroke-dashoffset 700ms ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-slate-900 leading-none tabular-nums">{score}</span>
      </div>
    </div>
  )
}

// ─── Page Component ─────────────────────────────────────────────────────────

export default function ListingDetailPage() {
  const params = useParams()
  const router = useRouter()
  const asin = params.asin as string

  // Resolve the Supabase access token for MUTATING calls (AI-recs regen, push-content, claim).
  // The server routes resolve the acting user from this Bearer JWT (work-log getAuthUser pattern)
  // to stamp keyword_push_log.pushed_by + listing_change_log.changed_by — without it those rows
  // carry a NULL actor. Mirrors the dashboard's getToken (src/app/fba/page.tsx).
  const getToken = useCallback(async () => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }, [])

  const [score, setScore] = useState<SeoScoreRow | null>(null)
  const [aiRecs, setAiRecs] = useState<AiRecommendations | null>(null)
  const [kwData, setKwData] = useState<KeywordIntelligenceResult | null>(null)
  // Intelligence table "Show all" (PO 2026-07-17): the top-20 cap hid the design-NICHE terms — after
  // the #419 demotion the top of the list is broad category UPGRADEs, while the niche rows (covered →
  // Defended, lower opp) sat below the cap and looked absent ("where are my fishing keywords?").
  const [kwShowAll, setKwShowAll] = useState(false)
  const [rankData, setRankData] = useState<RankAnalysisResult | null>(null)
  const [rankRefreshing, setRankRefreshing] = useState(false)
  // H10 competitor-keyword CSV import (Intelligence tab)
  const [kwImportBusy, setKwImportBusy] = useState(false)
  const [kwImportMsg, setKwImportMsg] = useState<string | null>(null)
  // Re-research with seed (Intelligence tab) — 3 JS credits per run, seller-triggered
  const [kwSeed, setKwSeed] = useState('')
  const [kwResearchBusy, setKwResearchBusy] = useState(false)
  const [kwResearchMsg, setKwResearchMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [aiLoading, setAiLoading] = useState(false)
  // Which section a per-section regen is running ('title'|'bullets'|'description'|'keywords'),
  // or null for a full audit — so ONLY the regenerating section shows "Regenerating… hold on",
  // not every section's button (PO: "pressing regenerate title also activates bullets/description").
  const [regenSection, setRegenSection] = useState<string | null>(null)
  // aiError carries a KIND (2026-07-08): 'quota'/'auth' render a red actionable banner (check
  // billing / fix the key — no Retry, it can't help); 'degraded'/'transient' render amber WITH
  // Retry. aiWarning = the run succeeded but something inside degraded (non-blocking, amber).
  const [aiError, setAiError] = useState<{ kind: string; message: string; section?: string } | null>(null)
  const [aiWarning, setAiWarning] = useState<{ kind: string; message: string } | null>(null)
  const [aiProgress, setAiProgress] = useState<string>('')
  const [copied, setCopied] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['apply']))
  // Per-design editor cards (multi-design apparel families): in-place edits keyed by designKey.
  // An entry exists only once the seller has touched that design (seeded from the group/fallback on
  // first edit) — so `designEdits[k]` truthy == "this design is dirty". PR-C wires save/ship/verify.
  const [designEdits, setDesignEdits] = useState<Record<string, { title?: string; bullets?: string[]; description?: string }>>({})
  // Per-design live-verify status (PR-C), keyed by designKey: 'matches' (every SKU live-matches),
  // 'needs-update' (one or more differ), else 'unknown' (not yet verified). Drives the card's chip.
  const [designVerifyStatus, setDesignVerifyStatus] = useState<Record<string, 'matches' | 'needs-update' | 'unknown'>>({})
  // True while a per-design Save/Verify is in flight (disables that card's footer buttons).
  const [designBusy, setDesignBusy] = useState<Record<string, boolean>>({})
  const [competitorAsin, setCompetitorAsin] = useState<string>('')
  const [competitorSaving, setCompetitorSaving] = useState(false)
  // Seller-set DESIGN NAME override (migration 031). When set, the pipeline anchors every regen on
  // this verbatim — kills the "stuck design" trap where the extractor falls through and the LLM
  // promotes a high-volume keyword to slogan status (B0GQVL3K4B "Too Young to Retire").
  const [designNameOverride, setDesignNameOverride] = useState<string>('')
  // Per-design seller name overrides (migration 034, {designKey: name}). Loaded on mount, fed as the
  // 4th arg to groupByDesign so the cards relabel instantly, and POSTed by onRenameDesign. DB-only.
  const [designNameOverrides, setDesignNameOverrides] = useState<Record<string, string>>({})
  const [isMultiDesignOverride, setIsMultiDesignOverride] = useState<boolean | null>(null)
  const [designOverrideSaving, setDesignOverrideSaving] = useState(false)
  const [designOverrideSavedAt, setDesignOverrideSavedAt] = useState<number | null>(null)
  // GOLD-TITLE LOCK (the discoverable "lock my title" control). Seeded from the current recommended_title
  // until the seller edits it; a Lock stores it verbatim + title_source='manual' (no Amazon push).
  const [titleLockInput, setTitleLockInput] = useState<string>('')
  const [titleLockTouched, setTitleLockTouched] = useState(false)
  const [titleLockSaving, setTitleLockSaving] = useState(false)
  const [orphans, setOrphans] = useState<{ orphanCount: number; children: { sku: string; asin: string; liveParent: string | null; status: string }[] } | null>(null)

  // ── Ship optimized content to Amazon — per section (title / bullets / description / keywords / details) ──
  // 'details' is a single-attribute push (one detail per click): Material, Brand, Fit Type, etc.
  // The seller picks WHICH detail in the UI; the route resolves the friendly name to an SP-API
  // attribute key (see lib/fba/productDetailAttrs.ts).
  type PushField = 'title' | 'bullets' | 'description' | 'keywords' | 'details'
  const FIELD_LABEL: Record<PushField, string> = { title: 'Title', bullets: 'Bullets', description: 'Description', keywords: 'Backend Keywords', details: 'Product Detail' }
  interface PushDiffRow { sku: string; current: string; proposed: string; bytes: number; chars: number; changed: boolean; isParent?: boolean; asin?: string }
  interface PushResultRow { sku: string; status: string; submissionId: string | null; error?: string; isParent?: boolean }
  interface PushPreview {
    field: PushField; label: string; broadcast: boolean; count: number; changed: number;
    proposedValue: string | string[] | null; diff: PushDiffRow[]
    /** Only set when field='details': the friendly attribute name (e.g. "Material") and SP-API key. */
    detail_field?: string; attribute_key?: string
    /** Feature B — for enum attributes: Amazon's accepted vocabulary and the value we
     *  normalized FROM (e.g. "Unisex Adult") when the audit's value wasn't accepted. */
    acceptedValues?: string[] | null; normalizedFrom?: string | null
    /** Part 2b — true = uncoercible dropdown; the modal shows a seller-picker over acceptedValues. */
    enum_invalid?: boolean
  }
  const [pushField, setPushField] = useState<PushField>('keywords')
  /** Only set when pushField='details': which detail attribute is being pushed (Material, etc.). */
  const [pushDetailField, setPushDetailField] = useState<string | null>(null)
  /** Per-design SKU scope for the NEXT push (PR-C). Set by openPushPreview's 3rd arg and read by
   *  buildPushBody so a per-design Ship targets only that design's SKUs. Reset to null on every
   *  openPushPreview call → all existing (full-listing) Ship buttons are unaffected. */
  const [pushPresetSkus, setPushPresetSkus] = useState<string[] | null>(null)
  // Per-design groups (multi-design apparel). This useMemo MUST live ABOVE the early returns
  // (loading / !score) further down — placing it below caused React #310 ("rendered more hooks
  // than during the previous render": the loading render bailed before the hook, the loaded render
  // ran it). designName-empty groups fall back to the designKey label inside the helper.
  const designGroups = useMemo(
    () => groupByDesign(aiRecs?.per_child_titles, aiRecs?.per_child_bullets, aiRecs?.per_child_descriptions, designNameOverrides),
    [aiRecs, designNameOverrides],
  )
  // PR-4: DERIVE each design's verify chip from LIVE truth — score.children (the cached listing_content the
  // VARIANT COHESION panel already reads) compared to the design's own recommended title. This makes the
  // chip truthful on LOAD (no more "Not verified" for everything), survive reloads, and flip to "Live
  // matches" after a ship+refresh WITHOUT a manual "Verify" click — parity with how single-design cards
  // derive from live truth. An explicit onVerifyDesign result (a live Amazon read) still OVERRIDES this
  // cache-derived default. Title is the per-design discriminator, so it's the compared field (== onVerifyDesign).
  const derivedDesignStatus = useMemo<Record<string, 'matches' | 'needs-update'>>(() => {
    const out: Record<string, 'matches' | 'needs-update'> = {}
    const children = score?.children ?? []
    if (!children.length || !designGroups.length) return out
    const liveBySku = new Map(children.map((c) => [c.sku, c] as const))
    const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim()
    for (const g of designGroups) {
      const expected = norm(g.title)
      if (!expected) continue // no recommendation for this design → leave undefined → 'unknown'
      let allMatch = g.skus.length > 0
      for (const sku of g.skus) {
        const child = liveBySku.get(sku)
        const live = child ? norm(stripVariantSuffix(child.title ?? '')) : ''
        if (!live || !squashEquals(live, expected)) { allMatch = false; break }
      }
      out[g.designKey] = allMatch ? 'matches' : 'needs-update'
    }
    return out
  }, [score?.children, designGroups])
  const [pushPreview, setPushPreview] = useState<PushPreview | null>(null)
  /** Part 2b — the value the seller picked from Amazon's accepted list for an uncoercible dropdown
   *  detail (e.g. Material "100% ring-spun cotton" → pick "Cotton"). Sent as detail_value_override. */
  const [detailOverride, setDetailOverride] = useState<string>('')
  // Cancel support for a streaming push: the token travels with the push body; Stop POSTs it back.
  const pushCancelTokenRef = useRef<string | null>(null)
  const bulkCancelTokenRef = useRef<string | null>(null)
  // True when the stream ended without a clean result (interrupted/timeout) — the modal header
  // shows "Interrupted" instead of "Complete" so the seller isn't told the push finished when it didn't.
  const bulkStreamInterruptedRef = useRef(false)
  // Auto-verify queue state — shows pending + healing + needs_attention counts in a banner so the
  // seller knows the system is watching their pushes and which (if any) need their attention.
  // `healing` (kind='heal' pending/running) drives the violet "self-heal in progress - do not
  // re-push" banner; `tasks` carries heal_payload.missingAttrKeys + next_check_at for its copy.
  interface VerifyQueueTask { id?: string; field?: string; kind?: string | null; status?: string; next_check_at?: string | null; last_error?: string | null; heal_payload?: { missingAttrKeys?: string[] } | null }
  const [verifyQueue, setVerifyQueue] = useState<{ pending: number; healing: number; needs_attention: number; tasks: VerifyQueueTask[] }>({ pending: 0, healing: 0, needs_attention: 0, tasks: [] })
  const [cancelRequested, setCancelRequested] = useState(false)
  const [pushLoading, setPushLoading] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [pushResults, setPushResults] = useState<{ field?: PushField; pushed: number; failed: number; total: number; message: string; results: PushResultRow[]; healScheduled?: boolean; healAttrs?: string[] } | null>(null)
  // ── "Verify on Amazon" — fresh getListingsItem per SKU after a push, so the seller can
  // tell whether Amazon APPLIED the patch (vs just ACCEPTED it). Submissions can sit in
  // Amazon's queue for 15min–6hr; "I pushed an hour ago and nothing changed" needs an answer.
  interface VerifyResultRow { sku: string; asin: string; isParent: boolean; currentLive: string; expected: string; expectedSource?: 'recommendation' | 'push_log' | 'none'; matches: boolean; inherited?: boolean; readFailed?: boolean; lastUpdatedDate: string | null }
  interface VerifyPayload { total: number; matched: number; inherited?: number; unverifiable?: number; stale: number; unknown?: number; results: VerifyResultRow[]; attribute_key?: string }
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyResults, setVerifyResults] = useState<VerifyPayload | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  // ── Manual title editor (B): the seller types/edits the title in the Ship-Title modal, scores it
  // with the real /score-title engine, and pushes THEIR title — control for when the council wobbles.
  const [editTitle, setEditTitle] = useState<string>('')
  const [titleScore, setTitleScore] = useState<{ titleScore: number; maxTitleScore: number; overallScore: number; ruleProblems: string[]; suppressionRisk: boolean } | null>(null)
  const [titleScoreLoading, setTitleScoreLoading] = useState(false)
  // ── Live push progress — populated from NDJSON stream events. Each entry tracks one SKU's
  // state as the route patches it in the loop. Replaces the old all-or-nothing 'Pushing…'
  // spinner with a per-SKU readout, AND eliminates the proxy-502 failure mode entirely
  // (each progress emit() keeps the connection warm).
  interface PushProgressRow { sku: string; status: 'validating' | 'accepted' | 'failed'; error?: string; submissionId?: string | null }
  const [pushProgress, setPushProgress] = useState<PushProgressRow[]>([])
  const [pushPhase, setPushPhase] = useState<'idle' | 'starting' | 'pushing' | 'rescoring' | 'done'>('idle')
  // ── Auto Push (PO): one click pushes EVERY ready Product-Detail field. The seller stays on
  // the trigger; the tool does the legwork field by field with live status. Each field goes
  // through the SAME per-field endpoint as a manual push (validation, write-through, re-score).
  interface BulkPushItem { field: string; value: string; status: 'ready' | 'pushing' | 'done' | 'failed'; note?: string; skip?: boolean; accepted?: string[] }
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkItems, setBulkItems] = useState<BulkPushItem[]>([])
  const [bulkRunning, setBulkRunning] = useState(false)
  // Overall SKU progress for the Auto Push bar ({done,total}); total = every SKU, done = each SKU's
  // terminal event (accepted/failed/partial/skipped) — one per SKU, so the bar reaches 100%.
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [bulkFinished, setBulkFinished] = useState(false)
  // ── "Ship all core" bulk push (element C): Title + Bullets + Description + Keywords in ONE PATCH per
  // SKU (server executor executeBulkCorePush). Minimal state, separate from the details Auto Push above;
  // only one push runs at a time (the shared pushActiveRef guard), so the stop flag (cancelRequested) is
  // reused. The button island (near the ACTION PLAN) + the modal below drive it; the stream reader +
  // stall watchdog mirror runBulkPush.
  const [coreBulkOpen, setCoreBulkOpen] = useState(false)
  const [coreBulkRunning, setCoreBulkRunning] = useState(false)
  const [coreBulkFinished, setCoreBulkFinished] = useState(false)
  const [coreBulkMessage, setCoreBulkMessage] = useState('')
  const [coreBulkProgress, setCoreBulkProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [coreBulkPerField, setCoreBulkPerField] = useState<{ field: string; accepted: number; failed: number }[]>([])
  const coreBulkCancelTokenRef = useRef<string | null>(null)
  const coreBulkInterruptedRef = useRef(false)
  // Mirrors (pushLoading || bulkRunning || coreBulkRunning) for guards inside STABLE callbacks — a ref
  // can't go stale the way a useCallback-captured boolean can (the concurrent-push guard relies on this
  // being current at click time).
  const pushActiveRef = useRef(false)
  useEffect(() => { pushActiveRef.current = pushLoading || bulkRunning || coreBulkRunning }, [pushLoading, bulkRunning, coreBulkRunning])
  // ── Family-SKUs view — full set of FBA + FBM twins + variation parent SKU. The DB cache
  // (listing_content) historically deduped some FBA/FBM pairs, so cards that render from
  // it alone hid the FBM twins (the seller saw "3 children" but the push hit 6).
  // /family-skus discovers them live so the displayed list matches the push reality.
  interface FamilySkuRow { sku: string; asin: string; fulfillment: 'FBA' | 'FBM' | 'unknown'; base_name: string }
  interface FamilySkus { parent: { sku: string; asin: string } | null; children: FamilySkuRow[]; count: number }
  const [familySkus, setFamilySkus] = useState<FamilySkus | null>(null)
  const [showPushModal, setShowPushModal] = useState(false)
  const [fetchedImage, setFetchedImage] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('apply')

  // ── Phase B collaboration (spec §5 Phase B + R-UX4/R-UX7) ─────────────────────────────────
  // The acting user (from the Supabase session) — needed to tell "I hold this claim" from
  // "someone else does", which drives Release vs Takeover.
  const [myUserId, setMyUserId] = useState<string | null>(null)
  // Live claim row for THIS parent ({claimed_by, claimed_by_name, last_heartbeat, stale}); null = free.
  interface ClaimState { claimed_by: string | null; claimed_by_name: string | null; claimed_at: string | null; last_heartbeat: string | null; stale: boolean }
  const [claim, setClaim] = useState<ClaimState | null>(null)
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimError, setClaimError] = useState<string | null>(null)
  // 2-step Takeover confirm (R-UX4): step 1 surfaces "<name> was active <Xm ago>" + unpushed-changes;
  // step 2 force-reassigns. `takeoverInfo` holds what we surface before the seller commits.
  const [takeoverOpen, setTakeoverOpen] = useState(false)
  const [takeoverInfo, setTakeoverInfo] = useState<{ holderName: string | null; lastActiveIso: string | null; hasUnpushedChanges: boolean; loading: boolean } | null>(null)
  // Merged human-readable change-history (R-UX7): change_log ∪ audit_logs ∪ score deltas, time-sorted.
  interface HistoryRow { id: string; ts: string; actor: string | null; action: string | null; summary: string; source: string | null; kind: 'change_log' | 'audit' | 'score'; field?: string | null }
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  // Phase C OUTCOME (spec §5): the listing_outcome_state ledger row for this parent (verdict, baseline,
  // snapshots-since-push, reason, non_copy_lever) + the 12-point score-history sparkline points.
  const [outcome, setOutcome] = useState<OutcomeChip | null>(null)
  const [sparkPoints, setSparkPoints] = useState<SparklinePoint[]>([])
  // I hold the claim iff it exists, is mine, and is not stale.
  const iHoldClaim = !!claim && !!myUserId && claim.claimed_by === myUserId && !claim.stale
  // Claim TTL mirror (src/lib/fba/claims.ts CLAIM_TTL_MS) — read-time staleness on this page.
  const CLAIM_TTL_MS = 15 * 60 * 1000

  // Resolve my user id once (compare against claimed_by for Release vs Takeover).
  useEffect(() => {
    (async () => {
      try {
        const supabase = createClient()
        const { data } = await supabase.auth.getUser()
        setMyUserId(data.user?.id ?? null)
      } catch { /* anonymous — controls degrade to read-only claim chip */ }
    })()
  }, [])

  // Load the current claim for this parent (read-time staleness via last_heartbeat).
  const refreshClaim = useCallback(async () => {
    if (!asin) return
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from('listing_claims')
        .select('claimed_by, claimed_by_name, claimed_at, last_heartbeat, released_at')
        .eq('parent_asin', asin)
        .maybeSingle()
      const row = data as { claimed_by: string | null; claimed_by_name: string | null; claimed_at: string | null; last_heartbeat: string | null; released_at: string | null } | null
      if (!row || row.released_at || !row.claimed_by) { setClaim(null); return }
      const stale = !row.last_heartbeat || (Date.now() - new Date(row.last_heartbeat).getTime() > CLAIM_TTL_MS)
      setClaim({ claimed_by: row.claimed_by, claimed_by_name: row.claimed_by_name, claimed_at: row.claimed_at, last_heartbeat: row.last_heartbeat, stale })
    } catch { /* best-effort; chip just won't render */ }
  }, [asin, CLAIM_TTL_MS])
  useEffect(() => { refreshClaim() }, [refreshClaim])

  // POST a claim action (claim | release | heartbeat | takeover) with the Bearer token.
  const postClaim = useCallback(async (action: 'claim' | 'release' | 'heartbeat' | 'takeover') => {
    const token = await getToken()
    const resp = await fetch('/api/fba/listing-optimizer/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ parent_asin: asin, action }),
    })
    return resp
  }, [asin, getToken])

  // Load the merged change-history feed (declared early so a mutation can refresh it).
  const refreshHistory = useCallback(async () => {
    if (!asin) return
    setHistoryLoading(true)
    try {
      const resp = await fetch(`/api/fba/listing-optimizer/change-log?parent_asin=${encodeURIComponent(asin)}`)
      if (resp.ok) { const d = await resp.json(); setHistory((d.entries || []) as HistoryRow[]) }
    } catch { /* best-effort */ }
    finally { setHistoryLoading(false) }
  }, [asin])

  // Phase C: load the OUTCOME ledger row (read-only via RLS auth SELECT) + the score-history sparkline.
  // Both are best-effort: a missing 039/038 table just leaves the panel/sparkline empty (no error).
  const refreshOutcome = useCallback(async () => {
    if (!asin) return
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from('listing_outcome_state')
        .select('outcome_verdict, snapshots_since_push, verdict_reason, non_copy_lever, baseline_overall_score, push_epoch_at, last_evaluated_at')
        .eq('listing_key', asin)
        .maybeSingle()
      if (data) {
        const r = data as Record<string, unknown>
        setOutcome({
          verdict: (r.outcome_verdict as OutcomeChip['verdict']) ?? null,
          snapshots_since_push: (r.snapshots_since_push as number | null) ?? null,
          verdict_reason: (r.verdict_reason as string | null) ?? null,
          non_copy_lever: (r.non_copy_lever as OutcomeChip['non_copy_lever']) ?? null,
          baseline_overall_score: (r.baseline_overall_score as number | null) ?? null,
          push_epoch_at: (r.push_epoch_at as string | null) ?? null,
          last_evaluated_at: (r.last_evaluated_at as string | null) ?? null,
        })
      } else {
        setOutcome(null)
      }
    } catch { /* 039 absent → no outcome panel */ }
    try {
      const resp = await fetch(`/api/fba/score-history?listing_key=${encodeURIComponent(asin)}&limit=12`)
      if (resp.ok) { const d = await resp.json(); setSparkPoints((d.points || []) as SparklinePoint[]) }
    } catch { /* 038 absent → no sparkline */ }
  }, [asin])
  useEffect(() => { refreshOutcome() }, [refreshOutcome])
  useEffect(() => { refreshHistory() }, [refreshHistory])

  // ── HEARTBEAT — fire on a FIXED interval while I hold the claim (spec §5 B "Watchdog-on-READ":
  // heartbeat regardless of edits). 30s << CLAIM_TTL (15min) so 20+ beats elapse before a steal.
  // If the server says I lost it (released/stolen), drop my local claim so the UI re-offers Claim.
  const HEARTBEAT_MS = 30 * 1000
  useEffect(() => {
    if (!iHoldClaim) return
    const id = setInterval(async () => {
      try {
        const resp = await postClaim('heartbeat')
        if (resp.status === 409) { await refreshClaim() } // lost it — re-sync
      } catch { /* transient; next beat retries */ }
    }, HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [iHoldClaim, postClaim, refreshClaim, HEARTBEAT_MS])

  // bumpHeartbeat — every MUTATING action (AI regen, push) also refreshes the heartbeat so an
  // actively-worked listing never goes stale mid-edit even if the interval is between beats.
  const bumpHeartbeat = useCallback(async () => {
    if (!iHoldClaim) return
    try { await postClaim('heartbeat') } catch { /* best-effort */ }
  }, [iHoldClaim, postClaim])

  // AUTO-CLAIM on page load: when the listing is free (or stale), auto-claim it for the current
  // user. No manual "Claim" button needed — opening the page = working on it.
  const [autoClaimDone, setAutoClaimDone] = useState(false)
  useEffect(() => {
    if (autoClaimDone || !myUserId || claimBusy) return
    if (claim === undefined) return // still loading
    if (iHoldClaim) { setAutoClaimDone(true); return }
    if (claim && !claim.stale) return // someone else holds it, don't auto-claim
    // Free or stale — auto-claim silently
    setAutoClaimDone(true)
    ;(async () => {
      try {
        const resp = await postClaim('claim')
        if (resp.ok || resp.status === 409) await refreshClaim()
        else setAutoClaimDone(false) // retry on next effect cycle
      } catch { setAutoClaimDone(false) }
    })()
  }, [myUserId, claim, iHoldClaim, autoClaimDone, claimBusy, postClaim, refreshClaim])

  // AUTO-RELEASE on unmount (tab close / navigate away).
  useEffect(() => {
    if (!iHoldClaim) return
    return () => { postClaim('release').catch(() => {}) }
  }, [iHoldClaim, postClaim])

  const doClaim = useCallback(async () => {
    setClaimBusy(true); setClaimError(null)
    try {
      const resp = await postClaim('claim')
      if (resp.status === 409) {
        const d = await resp.json().catch(() => ({}))
        setClaimError(`Held by ${d.held_by_name || 'someone else'}`)
        await refreshClaim()
        return
      }
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Claim failed')
      await refreshClaim(); await refreshHistory()
    } catch (e) { setClaimError(e instanceof Error ? e.message : 'Claim failed') }
    finally { setClaimBusy(false) }
  }, [postClaim, refreshClaim, refreshHistory])

  const doRelease = useCallback(async () => {
    setClaimBusy(true); setClaimError(null)
    try {
      const resp = await postClaim('release')
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Release failed')
      await refreshClaim(); await refreshHistory()
    } catch (e) { setClaimError(e instanceof Error ? e.message : 'Release failed') }
    finally { setClaimBusy(false) }
  }, [postClaim, refreshClaim, refreshHistory])

  // ── TAKEOVER step 1 — open the confirm and gather what we surface (R-UX4): the holder's name,
  // when they were last active (last_heartbeat), and whether they have UNPUSHED changes (a live AI
  // recommendation exists but the field hasn't been pushed since). We probe unpushed-state cheaply:
  // an aiRecs draft exists AND there's no push log newer than its generated_at.
  const openTakeover = useCallback(async () => {
    setTakeoverOpen(true)
    setTakeoverInfo({ holderName: claim?.claimed_by_name ?? null, lastActiveIso: claim?.last_heartbeat ?? null, hasUnpushedChanges: false, loading: true })
    let hasUnpushed = false
    try {
      // Unpushed = a generated recommendation newer than the latest push for this parent.
      const supabase = createClient()
      const { data: pushRow } = await supabase
        .from('keyword_push_log')
        .select('pushed_at')
        .eq('parent_asin', asin)
        .order('pushed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const lastPush = (pushRow as { pushed_at: string } | null)?.pushed_at ?? null
      const genAt = aiRecs?.generated_at ?? null
      if (genAt && (!lastPush || Date.parse(genAt) > Date.parse(lastPush))) hasUnpushed = true
    } catch { /* best-effort; default false */ }
    setTakeoverInfo({ holderName: claim?.claimed_by_name ?? null, lastActiveIso: claim?.last_heartbeat ?? null, hasUnpushedChanges: hasUnpushed, loading: false })
  }, [asin, claim, aiRecs])

  // ── TAKEOVER step 2 — force-reassign. Logs BOTH ids server-side (claim route action='takeover').
  const confirmTakeover = useCallback(async () => {
    setClaimBusy(true); setClaimError(null)
    try {
      const resp = await postClaim('takeover')
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Takeover failed')
      setTakeoverOpen(false); setTakeoverInfo(null)
      await refreshClaim(); await refreshHistory()
    } catch (e) { setClaimError(e instanceof Error ? e.message : 'Takeover failed') }
    finally { setClaimBusy(false) }
  }, [postClaim, refreshClaim, refreshHistory])

  const copy = (text: string, label: string) => {
    copyToClipboard(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const toggle = (key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Fetch score data
  useEffect(() => {
    (async () => {
      try {
        // Load the FULL index (capped at 200) AND ask the route to ensure THIS listing is scored
        // (&ensure=): the optimizer only auto-scores the top-50-by-sales, so a low-traffic listing has
        // no score row and would "disappear" when opened by direct URL (B0GCPHGN4J / B0FKDDN44Z 404'd,
        // 2026-06-15/16). ensure= scores it on demand from existing content so the find() below resolves.
        const resp = await fetch(`/api/fba/listing-optimizer?limit=200&ensure=${encodeURIComponent(asin)}`)
        if (!resp.ok) throw new Error('Failed to load')
        const data = await resp.json()
        const found = data.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
        if (found) setScore(found)
      } catch { /* ignore */ }
      setLoading(false)
    })()
  }, [asin])

  // If the synced score has no product image, fetch it on-demand from the Amazon catalog.
  useEffect(() => {
    if (!score || score.image_url) return
    const imgAsin = score.top_child_asin || asin
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/product-image?asin=${imgAsin}`)
        if (resp.ok) { const d = await resp.json(); if (d.image_url) setFetchedImage(d.image_url) }
      } catch { /* ignore — placeholder stays */ }
    })()
  }, [score, asin])

  // Orphan check — flag children whose live Amazon variation link to this parent is broken
  // (was part of the family, got disconnected). Best-effort; never blocks the page.
  const runOrphanCheck = useCallback(async () => {
    if (!asin) return
    try {
      const r = await fetch(`/api/fba/listing-optimizer/orphan-check?parent_asin=${asin}`)
      if (r.ok) { const d = await r.json(); if (d && typeof d.orphanCount === 'number') setOrphans(d) }
    } catch { /* best-effort */ }
  }, [asin])
  useEffect(() => { runOrphanCheck() }, [runOrphanCheck])

  // ─── Related orphans — orphan SKUs (no live parent) that share a SKU prefix with this
  // parent's children. Surfaces "this orphan probably belongs HERE — re-link it" prompts on the
  // CORRECT parent's page, not on the stale one where the orphan currently sits. Includes this
  // parent's seller SKU so the Re-link modal pre-fills the target. Best-effort.
  type RelatedOrphans = { parent_sku: string | null; prefix: string; candidates: { sku: string; asin: string; storedParent: string | null }[] }
  const [relatedOrphans, setRelatedOrphans] = useState<RelatedOrphans | null>(null)
  const runRelatedOrphans = useCallback(async () => {
    if (!asin) return
    try {
      const r = await fetch(`/api/fba/listing-optimizer/related-orphans?parent_asin=${asin}`)
      if (r.ok) { const d = await r.json(); if (d && Array.isArray(d.candidates)) setRelatedOrphans(d) }
    } catch { /* best-effort */ }
  }, [asin])
  useEffect(() => { runRelatedOrphans() }, [runRelatedOrphans])

  // (Re-link submission status state + helper live AFTER openRelink is declared — see below.)

  // ─── Capacity attribute check — detect children whose live capacity disagrees with SKU ──
  type CapRow = {
    sku: string; asin: string; productType: string | null
    attributeName: string | null
    live: { value: number; unit: string } | null
    expected: { value: number; unit: string } | null
    liveLabel: string; expectedLabel: string
    mismatch: boolean
    reason: 'no_attribute' | 'no_sku_capacity' | 'match' | 'mismatch' | 'fetch_failed'
  }
  const [capacityCheck, setCapacityCheck] = useState<{ mismatchCount: number; children: CapRow[] } | null>(null)
  const runCapacityCheck = useCallback(async () => {
    if (!asin) return
    try {
      const r = await fetch(`/api/fba/listing-optimizer/capacity-check?parent_asin=${asin}`)
      if (r.ok) { const d = await r.json(); if (d && typeof d.mismatchCount === 'number') setCapacityCheck(d) }
    } catch { /* best-effort */ }
  }, [asin])
  useEffect(() => { runCapacityCheck() }, [runCapacityCheck])

  // ─── Fix a single child's capacity attribute (preview → confirm → live) ──────────
  type CapIssue = { code?: string; message?: string; severity?: string }
  const [fixCapTarget, setFixCapTarget] = useState<{ row: CapRow } | null>(null)
  const [fixCapLoading, setFixCapLoading] = useState(false)
  const [fixCapError, setFixCapError] = useState<string | null>(null)
  const [fixCapPreview, setFixCapPreview] = useState<{ ok: boolean; attributeName: string; current: { value: number | string | undefined; unit: string | undefined }; proposed: { value: number; unit: string }; issues: CapIssue[] } | null>(null)
  const [fixCapResult, setFixCapResult] = useState<{ submitted: boolean; status: string | null; submissionId: string | null; issues: CapIssue[]; message: string } | null>(null)
  const openFixCap = useCallback((row: CapRow) => {
    setFixCapTarget({ row }); setFixCapPreview(null); setFixCapResult(null); setFixCapError(null)
  }, [])
  const previewFixCap = useCallback(async () => {
    const row = fixCapTarget?.row; if (!row?.expected) return
    setFixCapLoading(true); setFixCapError(null); setFixCapPreview(null); setFixCapResult(null)
    try {
      const r = await fetch(`/api/fba/listing-optimizer/fix-capacity?child_sku=${encodeURIComponent(row.sku)}&value=${row.expected.value}&unit=${encodeURIComponent(row.expected.unit)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Preview failed')
      setFixCapPreview(d)
    } catch (e) { setFixCapError(e instanceof Error ? e.message : 'Preview failed') }
    setFixCapLoading(false)
  }, [fixCapTarget])
  const confirmFixCap = useCallback(async () => {
    const row = fixCapTarget?.row; if (!row?.expected) return
    setFixCapLoading(true); setFixCapError(null)
    try {
      const r = await fetch('/api/fba/listing-optimizer/fix-capacity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ child_sku: row.sku, value: row.expected.value, unit: row.expected.unit, confirm: true }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Fix failed')
      setFixCapResult(d); setFixCapPreview(null)
    } catch (e) { setFixCapError(e instanceof Error ? e.message : 'Fix failed') }
    setFixCapLoading(false)
  }, [fixCapTarget])

  // ─── Re-link an orphan/re-parented child into a target parent SKU ────────────────
  type RelinkIssue = { code?: string; message?: string; severity?: string }
  const [relinkTarget, setRelinkTarget] = useState<{ childSku: string; childAsin: string } | null>(null)
  const [relinkParentSku, setRelinkParentSku] = useState<string>('')
  const [relinkPreview, setRelinkPreview] = useState<{ ok: boolean; productType: string; variation_theme: string | null; issues: RelinkIssue[] } | null>(null)
  const [relinkLoading, setRelinkLoading] = useState(false)
  const [relinkError, setRelinkError] = useState<string | null>(null)
  const [relinkResult, setRelinkResult] = useState<{ submitted: boolean; status: string | null; submissionId: string | null; issues: RelinkIssue[]; message: string } | null>(null)
  const openRelink = useCallback((childSku: string, childAsin: string, parentSku?: string) => {
    setRelinkTarget({ childSku, childAsin })
    // Pre-fill with the caller's parent SKU when known (Related Orphans on a parent page),
    // otherwise leave blank so the user must enter it (no more hard-coded "Memory-Card-P").
    setRelinkParentSku(parentSku || '')
    setRelinkPreview(null); setRelinkResult(null); setRelinkError(null)
  }, [])

  // ─── Re-link submission status — track pending Amazon submissions so we don't keep offering
  //  the Re-link button on a SKU the seller already pushed. The /relink-status endpoint also
  //  lazily auto-resolves pending rows to applied when Amazon's catalog reports the new parent.
  type RelinkStatusRow = { child_sku: string; target_parent_sku: string; status: 'pending' | 'applied' | 'failed'; submitted_at: string; applied_at: string | null; submission_id: string | null }
  const [relinkStatus, setRelinkStatus] = useState<Record<string, RelinkStatusRow>>({})
  const runRelinkStatus = useCallback(async () => {
    const skus = new Set<string>()
    for (const c of orphans?.children ?? []) skus.add(c.sku)
    for (const c of relatedOrphans?.candidates ?? []) skus.add(c.sku)
    if (skus.size === 0) return
    try {
      const r = await fetch(`/api/fba/listing-optimizer/relink-status?child_skus=${[...skus].join(',')}`)
      if (!r.ok) return
      const d = await r.json() as { statuses?: RelinkStatusRow[] }
      const map: Record<string, RelinkStatusRow> = {}
      for (const s of d.statuses ?? []) map[s.child_sku] = s
      setRelinkStatus(map)
    } catch { /* best-effort */ }
  }, [orphans, relatedOrphans])
  useEffect(() => { runRelinkStatus() }, [runRelinkStatus])
  const renderRelinkAction = useCallback((c: { sku: string; asin: string }, parentSku: string | undefined, style: 'amber' | 'sky' | 'violet') => {
    const status = relinkStatus[c.sku]
    if (status?.status === 'pending') {
      const mins = Math.max(1, Math.floor((Date.now() - new Date(status.submitted_at).getTime()) / 60000))
      return (
        <span className="ml-auto inline-flex items-center gap-2 text-[11px]">
          <span className="px-2 py-0.5 rounded bg-slate-700 text-white font-semibold">Submitted {mins}m ago</span>
          <button onClick={runRelinkStatus} className="text-[11px] underline text-slate-600 hover:text-slate-900 cursor-pointer" title="Re-check Amazon for the applied state">Re-check</button>
        </span>
      )
    }
    if (status?.status === 'applied') {
      return <span className="ml-auto text-[11px] font-semibold text-green-700">✓ Applied on Amazon</span>
    }
    const cls = style === 'amber' ? 'bg-amber-700 hover:bg-amber-800 text-white'
      : style === 'sky' ? 'bg-white border border-sky-300 hover:bg-sky-100 text-sky-700'
      : 'bg-violet-700 hover:bg-violet-800 text-white'
    return (
      <button onClick={() => openRelink(c.sku, c.asin, parentSku)} disabled={style === 'violet' && !parentSku}
        className={`ml-auto inline-flex items-center gap-1 text-[11px] font-semibold ${cls} px-2.5 py-1 rounded-md transition-colors cursor-pointer disabled:opacity-50`}>
        {style === 'sky' ? 'Move to this parent' : style === 'violet' ? 'Re-link to this parent' : 'Re-link'}
      </button>
    )
  }, [relinkStatus, runRelinkStatus, openRelink])
  const previewRelink = useCallback(async () => {
    if (!relinkTarget || !relinkParentSku) return
    setRelinkLoading(true); setRelinkError(null); setRelinkPreview(null); setRelinkResult(null)
    try {
      const r = await fetch(`/api/fba/listing-optimizer/relink?child_sku=${encodeURIComponent(relinkTarget.childSku)}&parent_sku=${encodeURIComponent(relinkParentSku)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Preview failed')
      setRelinkPreview(d)
    } catch (e) { setRelinkError(e instanceof Error ? e.message : 'Preview failed') }
    setRelinkLoading(false)
  }, [relinkTarget, relinkParentSku])
  const confirmRelink = useCallback(async () => {
    if (!relinkTarget || !relinkParentSku) return
    setRelinkLoading(true); setRelinkError(null)
    try {
      const r = await fetch('/api/fba/listing-optimizer/relink', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ child_sku: relinkTarget.childSku, parent_sku: relinkParentSku, confirm: true }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Re-link failed')
      setRelinkResult(d); setRelinkPreview(null)
    } catch (e) { setRelinkError(e instanceof Error ? e.message : 'Re-link failed') }
    setRelinkLoading(false)
  }, [relinkTarget, relinkParentSku])

  // Fetch AI recommendations (cached)
  useEffect(() => {
    if (!asin) return
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/listing-optimizer/ai-recommendations?parent_asin=${asin}`)
        if (resp.ok) {
          const data = await resp.json()
          if (data.recommendations) setAiRecs(data.recommendations)
        }
      } catch { /* ignore */ }
    })()
  }, [asin])

  // Fetch family SKUs (FBA + FBM twins + variation parent) — used by the TITLES card to show
  // every SKU the push will hit, not just what's in the DB cache. Read-only, best-effort.
  useEffect(() => {
    if (!asin) return
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/listing-optimizer/family-skus?parent_asin=${asin}`)
        if (resp.ok) {
          const data = await resp.json()
          if (data?.children) setFamilySkus(data)
        }
      } catch { /* ignore — UI falls back to per_child_titles only */ }
    })()
  }, [asin])

  // 👻 GHOST-PARENT HARD REDIRECT (PR #89). B0F8WYNVPJ-class ASINs are "half-ghosts":
  // they still carry stale recommendations + score (so the #83 empty-recs banner never
  // fires) but have ZERO live children on Amazon (the variation family migrated to a twin
  // parent, e.g. B0GCF11RKL). Landing here is a dead end — the seller's repeated "clicking
  // a card doesn't open the parent". The authoritative signal is orphan-check (live catalog
  // relationships). If it returns 0 live children AND twin-parent resolves a DIFFERENT real
  // ASIN, hard-redirect to the live parent. Deterministic, runs on load, independent of
  // stale recs / rollup child_count / async dashboard staleStatus. Loop-guarded.
  const [ghostRedirecting, setGhostRedirecting] = useState(false)
  useEffect(() => {
    if (!asin) return
    let cancelled = false
    ;(async () => {
      try {
        const oc = await fetch(`/api/fba/listing-optimizer/orphan-check?parent_asin=${asin}`)
        if (!oc.ok || cancelled) return
        const ocd = await oc.json()
        const liveChildren = (ocd.children ?? []).filter((c: { status?: string }) => c.status !== 'orphan')
        if (liveChildren.length > 0) return // genuine parent — never redirect
        // 0 live children → ghost. Resolve the live twin and route there.
        const tr = await fetch(`/api/fba/listing-optimizer/twin-parent?parent_asin=${asin}`)
        if (!tr.ok || cancelled) return
        const td = await tr.json()
        if (td.twinParent && td.twinParent !== asin) {
          setGhostRedirecting(true)
          router.replace(`/fba/listing/${td.twinParent}`)
        }
      } catch { /* best-effort — page renders normally if checks fail */ }
    })()
    return () => { cancelled = true }
  }, [asin, router])

  // Refetch the parent SEO score row → refreshes `variants` (= score.children) so the VARIANT COHESION
  // panel re-derives its per-SKU live-vs-recommended "needs update" counts. The SERVER already grounds
  // listing_content to Amazon's verified value + re-scores on every verify (heal-on-verify, verify-push
  // route) and write-through on push; this pulls that fresh truth into the client so the panel flips
  // WITHOUT a hard refresh (the bug: verify + the auto-verify poll healed server-side but the page kept
  // rendering the stale score). Best-effort — the next full load serves the same truth.
  const refreshScore = useCallback(async () => {
    if (!asin) return
    try {
      // MUST mirror the initial load's URL (?limit=200&ensure=asin): the bare LIST is the top-50-by-sales
      // page, so a LOW-TRAFFIC listing (e.g. 11 units/30d) is ABSENT → find() returns undefined → setScore
      // never runs → score.children stays stale → the cohesion counts + per-design chips don't move until a
      // manual reload (PO: "41 need update didn't disappear until I refreshed"). ensure= re-scores THIS asin
      // on-demand from the just-written listing_content, so the refetch always resolves with fresh children.
      const sresp = await fetch(`/api/fba/listing-optimizer?limit=200&ensure=${encodeURIComponent(asin)}`, { cache: 'no-store' })
      const sdata = await sresp.json()
      const found = sdata.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
      if (found) setScore(found)
    } catch { /* best-effort — next load shows it */ }
  }, [asin])

  // A+ "Scan now" (PO 2026-07-16): A+ status is otherwise refreshed ONLY by the heavy top-50 sync, so
  // a low-traffic parent that gains A+ shows 0/16 forever. Re-check Amazon for A+ on THIS listing,
  // then refetch the score so the tile/ring/child table reflect it.
  const [aplusScanning, setAplusScanning] = useState(false)
  const [aplusScanMsg, setAplusScanMsg] = useState<string | null>(null)
  const scanAplus = useCallback(async () => {
    if (!asin || aplusScanning) return
    setAplusScanning(true); setAplusScanMsg(null)
    try {
      const resp = await fetch('/api/fba/aplus-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asin }),
      })
      const data = await resp.json()
      if (data.scanned) {
        setAplusScanMsg(data.has_aplus
          ? `A+ found — ${data.aplus_module_count} module${data.aplus_module_count === 1 ? '' : 's'} detected.`
          : 'Still no live A+ detected. If you just submitted it, Amazon may still be reviewing — re-scan shortly.')
        await refreshScore()
      } else {
        setAplusScanMsg(data.reason || 'Could not scan A+.')
      }
    } catch {
      setAplusScanMsg('A+ scan failed — try again.')
    } finally {
      setAplusScanning(false)
    }
  }, [asin, aplusScanning, refreshScore])

  // Verification-queue status: pending + healing + needs_attention for THIS parent. Polled every
  // 60s so a freshly-enqueued push appears in the banner and a cron flip from pending → completed →
  // needs_attention reflects without a manual refresh. Best-effort: a missing migration 030
  // returns 0/0 (the endpoint handles it), so this never errors. Exposed as a callback (not
  // effect-local) so confirmPush can refresh the banner IMMEDIATELY when a push finishes — a
  // just-scheduled self-heal must be visible before the seller can re-push, not up to 60s later.
  const prevVerifyPendingRef = useRef<number | null>(null)
  const refreshVerifyQueue = useCallback(async () => {
    if (!asin) return
    try {
      const resp = await fetch(`/api/fba/verification-status?parent_asin=${asin}`, { cache: 'no-store' })
      if (resp.ok) {
        const j = await resp.json() as { pending?: number; healing?: number; needs_attention?: number; tasks?: VerifyQueueTask[] }
        const pending = j.pending ?? 0
        setVerifyQueue({ pending, healing: j.healing ?? 0, needs_attention: j.needs_attention ?? 0, tasks: j.tasks ?? [] })
        // When the auto-verify cron DRAINS the queue (pending drops), it just grounded listing_content +
        // re-scored server-side — pull that so the cohesion "needs update" counts flip without a hard
        // refresh (the bug: this poll refreshed only the banner, never the per-field cohesion).
        if (prevVerifyPendingRef.current !== null && pending < prevVerifyPendingRef.current) refreshScore()
        prevVerifyPendingRef.current = pending
      }
    } catch { /* silent — the banner just shows 0 */ }
  }, [asin, refreshScore])
  useEffect(() => {
    if (!asin) return
    refreshVerifyQueue()
    const id = setInterval(refreshVerifyQueue, 60_000)
    return () => clearInterval(id)
  }, [asin, refreshVerifyQueue])

  const refreshKwData = useCallback(async (opts?: { triggerSync?: boolean }) => {
    if (!asin) return
    try {
      if (opts?.triggerSync) {
        await fetch(`/api/fba/intelligence/${asin}`, { method: 'POST', cache: 'no-store' }).catch(() => {})
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 3000))
          const resp = await fetch(`/api/fba/intelligence/${asin}?stored=true`, { cache: 'no-store' })
          if (resp.ok) {
            const data = await resp.json()
            if (data.totalKeywordsAnalyzed > 0) { setKwData(data); return }
          }
        }
      }
      const resp = await fetch(`/api/fba/intelligence/${asin}?stored=true`, { cache: 'no-store' })
      if (resp.ok) { setKwData(await resp.json()) }
    } catch { /* ignore */ }
  }, [asin])
  useEffect(() => { refreshKwData() }, [refreshKwData])

  // Fetch rank analysis (0-cost free core) for the Apply-tab verdict banner. Endpoint accepts the
  // PARENT asin and resolves to the top child internally; renders only server-authored, validated copy.
  useEffect(() => {
    if (!asin) return
    let cancelled = false
    setRankData(null) // clear on ASIN change so the banner can't flash the previous listing's verdict
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/rank-analysis/${asin}`)
        if (resp.ok) {
          const data = await resp.json()
          if (!cancelled && !data.error) setRankData(data)
        }
      } catch { /* ignore — Apply tab works without rank context */ }
    })()
    return () => { cancelled = true }
  }, [asin])

  // Tab-close guard: the push/Auto-Push stream lives in THIS tab's JS — modal close and SPA
  // navigation are safe, but closing/refreshing the browser tab kills the stream mid-push.
  // Ask the browser to confirm so an employee can't lose a half-sent push by accident.
  useEffect(() => {
    if (!pushLoading && !bulkRunning) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pushLoading, bulkRunning])

  // Escape closes the two streaming modals (Auto Push / Ship). Like their X, this only HIDES
  // the modal — the push keeps running in this tab and the floating pill reopens it. The three
  // ModalShell dialogs handle their own Escape (gated on their in-flight guard).
  useEffect(() => {
    if (!bulkOpen && !showPushModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showPushModal) setShowPushModal(false)
      else if (bulkOpen) setBulkOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bulkOpen, showPushModal])

  // FREE rank re-check (the banner's stale chip is a BUTTON now, not a dead-end): recomputes
  // live keyword coverage server-side (0 JS credits, 0 OpenAI — pure DB + coverage math),
  // un-stales the banner, and the actionable work-list (Ship/Regenerate per gap keyword)
  // comes back immediately. Paid SOV data is carried forward server-side, never wiped.
  const refreshRankFree = useCallback(async () => {
    if (!asin) return
    setRankRefreshing(true)
    try {
      const resp = await fetch(`/api/fba/rank-analysis/${asin}?refresh=free`, { cache: 'no-store' })
      if (resp.ok) {
        const data = await resp.json()
        if (!data.error) setRankData(data)
      }
    } catch { /* best-effort — the stale-flagged data stays visible */ }
    setRankRefreshing(false)
  }, [asin])

  // Fetch competitor ASIN
  useEffect(() => {
    if (!asin) return
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/competitor-asin?parentAsin=${asin}`)
        if (resp.ok) {
          const data = await resp.json()
          if (data.competitorAsin) setCompetitorAsin(data.competitorAsin)
        }
      } catch { /* ignore */ }
    })()
  }, [asin])

  // Fetch seller-set design name override (migration 031). Best-effort: a missing column on a
  // pre-migration env returns null → input stays empty → legacy LLM/heuristic extraction runs.
  useEffect(() => {
    if (!asin) return
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/design-name-override?parentAsin=${asin}`)
        if (resp.ok) {
          const data = await resp.json() as { designNameOverride?: string | null; designNameOverrides?: Record<string, string> | null; isMultiDesignOverride?: boolean | null }
          if (data.designNameOverride) setDesignNameOverride(data.designNameOverride)
          if (data.designNameOverrides) setDesignNameOverrides(data.designNameOverrides)
          if (data.isMultiDesignOverride !== undefined) setIsMultiDesignOverride(data.isMultiDesignOverride)
        }
      } catch { /* ignore */ }
    })()
  }, [asin])

  const saveDesignNameOverride = async () => {
    setDesignOverrideSaving(true)
    try {
      await fetch('/api/fba/design-name-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentAsin: asin, designNameOverride: designNameOverride.trim() || null }),
      })
      setDesignOverrideSavedAt(Date.now())
    } catch { /* ignore */ }
    setDesignOverrideSaving(false)
  }

  // Seed the lock input from the current recommended title until the seller edits it.
  useEffect(() => {
    if (!titleLockTouched && aiRecs?.recommended_title) setTitleLockInput(aiRecs.recommended_title)
  }, [aiRecs?.recommended_title, titleLockTouched])

  // Lock the seller's exact title as the authority (title_source='manual') WITHOUT an Amazon push, or
  // unlock to let the next Regenerate rewrite it. A locked title survives every AI Audit/Regenerate.
  const saveTitleLock = async (action: 'lock' | 'unlock') => {
    setTitleLockSaving(true)
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/listing-optimizer/lock-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ parent_asin: asin, action, title: titleLockInput.trim() }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) { alert(data.error || 'Lock update failed'); setTitleLockSaving(false); return }
      setAiRecs((prev) => prev ? {
        ...prev,
        title_source: data.title_source ?? (action === 'lock' ? 'manual' : 'ai'),
        recommended_title: action === 'lock' && titleLockInput.trim() ? titleLockInput.trim() : prev.recommended_title,
      } : prev)
    } catch (e) { alert(e instanceof Error ? e.message : 'Lock update failed') }
    setTitleLockSaving(false)
  }

  // Per-design rename (migration 034). DB-only: POST the {designKey: name} override, then update the
  // local map so groupByDesign relabels the card INSTANTLY (no regen). Blank value clears the key.
  // The next regen reads design_name_overrides and anchors that design's title/bullets/desc on it.
  const onRenameDesign = async (designKey: string, value: string) => {
    const next = { ...designNameOverrides }
    if (value.trim()) next[designKey] = value.trim()
    else delete next[designKey]
    setDesignNameOverrides(next) // optimistic instant relabel
    try {
      const resp = await fetch('/api/fba/design-name-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentAsin: asin, designKey, designNameOverride: value.trim() || null }),
      })
      if (!resp.ok) setDesignNameOverrides(designNameOverrides) // revert on failure
    } catch {
      setDesignNameOverrides(designNameOverrides) // revert on failure
    }
  }

  const saveCompetitorAsin = async () => {
    if (!competitorAsin || !/^[A-Z0-9]{10}$/.test(competitorAsin.toUpperCase())) return
    setCompetitorSaving(true)
    try {
      await fetch('/api/fba/competitor-asin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentAsin: asin, competitorAsin: competitorAsin.toUpperCase() }),
      })
    } catch { /* ignore */ }
    setCompetitorSaving(false)
  }

  // Generate AI recommendations (streaming). `regenerateSection` ('title'|'bullets'|'description'|
  // 'keywords'|'all') overrides the 7-day cooling lock for that one section so the seller can iterate
  // before the settling window is up.
  const generateAiRecs = useCallback(async (regenerateSection?: string) => {
    setAiLoading(true)
    setRegenSection(regenerateSection ?? null)
    setAiError(null)
    setAiWarning(null)
    setAiProgress(regenerateSection ? `Regenerating ${regenerateSection}…` : 'Starting AI audit...')
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/listing-optimizer/ai-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ parent_asin: asin, ...(regenerateSection ? { regenerate_section: regenerateSection } : {}) }),
      })
      if (!resp.ok) throw new Error('AI generation failed')

      // Handle NDJSON streaming response
      const reader = resp.body?.getReader()
      if (!reader) throw new Error('No response stream')

      const decoder = new TextDecoder()
      let buffer = ''
      let finalResult: { recommendations?: AiRecommendations } | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'progress') {
              setAiProgress(msg.message || 'Processing...')
            } else if (msg.type === 'result') {
              finalResult = msg
            } else if (msg.type === 'warning') {
              // Non-blocking degradation notice (2026-07-08): the run succeeded but something inside
              // degraded (e.g. backend keywords preserved, or a quota hit on an enrichment call).
              setAiWarning({ kind: msg.kind || 'degraded', message: msg.message || 'Part of this AI run degraded.' })
            } else if (msg.type === 'error') {
              // TAG the stream error (2026-07-08): the parse-catch below used to filter rethrows by
              // MESSAGE TEXT — any server message that didn't literally equal 'AI generation failed'
              // (e.g. the new "AI credit exhausted…" ) was SWALLOWED as a malformed line and the quota
              // outage rendered as a generic timeout. The tag makes the filter exact.
              const e = new Error(msg.error || 'AI generation failed') as Error & { aiKind?: string; fromStream?: boolean }
              e.aiKind = msg.kind || 'transient'
              e.fromStream = true
              throw e
            }
          } catch (parseErr) {
            // Skip malformed lines — but ALWAYS rethrow a tagged stream error.
            if ((parseErr as { fromStream?: boolean })?.fromStream) throw parseErr
            continue
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer)
          if (msg.type === 'result') finalResult = msg
          else if (msg.type === 'error') {
            const e = new Error(msg.error || 'AI generation failed') as Error & { aiKind?: string; fromStream?: boolean }
            e.aiKind = msg.kind || 'transient'
            e.fromStream = true
            throw e
          }
        } catch (tailErr) {
          // Same tag rule as the loop: a JSON-parse miss on a truncated tail is ignorable,
          // a decoded stream error is NOT (the old bare catch swallowed it).
          if ((tailErr as { fromStream?: boolean })?.fromStream) throw tailErr
        }
      }

      if (finalResult?.recommendations) {
        // Defense-in-depth (2026-07-08): the server now gates degraded content before persisting,
        // but if a result somehow arrives with EVERY core field empty (legacy row, mid-deploy skew),
        // treat it as a degraded failure instead of rendering an empty page as success.
        const rr = finalResult.recommendations as { recommended_title?: string; recommended_bullets?: string[]; recommended_description?: string }
        const coreAllEmpty = !String(rr.recommended_title ?? '').trim()
          && !(Array.isArray(rr.recommended_bullets) && rr.recommended_bullets.some((b) => b && b.trim()))
          && !String(rr.recommended_description ?? '').trim()
        // FULL audits only (adversarial): a partial regen's merged result can legitimately carry an
        // all-empty core when the STORED row was wiped pre-fix — e.g. a successful keywords-only
        // regen on a wiped row DID persist its keywords; failing it here would be factually false
        // and block the exact recovery flow. The pipeline gates each partial's own section.
        if (coreAllEmpty && !(finalResult as { regenerated_section?: string }).regenerated_section) {
          const e = new Error('The AI result came back empty (no title, bullets, or description). Nothing usable was generated — your stored content is unchanged. Retry in a minute.') as Error & { aiKind?: string }
          e.aiKind = 'degraded'
          throw e
        }
        setAiRecs(finalResult.recommendations)
        // The regen route just re-scored server-side (LIVE SCORE block) — refetch so the
        // score cards update in place. Without this the PO saw the PRE-audit scores until
        // a hard refresh (the push handlers already do this; the regen handler never did).
        try {
          const sresp = await fetch('/api/fba/listing-optimizer', { cache: 'no-store' })
          const sdata = await sresp.json()
          const found = sdata.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
          if (found) setScore(found)
        } catch { /* best-effort — next load shows it */ }
        // Recompute the Rank-Top card off CURRENT content + the LATEST rank logic (free, no credits).
        // Without this the card kept showing the rank analysis cached BEFORE this regen — stale
        // coverage, already-covered "gaps", and opposite-gender keywords the #210 lean filter now
        // excludes (PO: "after regen still showing gaps + mens + asking to weave in things already in bullets").
        refreshRankFree()
        refreshKwData({ triggerSync: true })
        // Phase B: a regen is a mutation — bump my claim's heartbeat (so an actively-worked listing
        // never goes stale mid-edit) and refresh the merged change-history so the AI-regen row shows.
        bumpHeartbeat()
        refreshHistory()
      } else {
        // Stream ended with no result AND no error event — almost always the request hit the
        // container mid-redeploy (a merge just deployed) or timed out. Nothing was changed.
        throw new Error('The audit didn’t come back — the server may have been redeploying or the request timed out. Nothing was changed; wait ~1 minute and Regenerate again.')
      }
    } catch (e: unknown) {
      // `section` remembers WHICH regen failed so Retry repeats exactly that (adversarial: a
      // failed bullets-only regen must not retry as a full audit that rewrites title/keywords).
      setAiError(e instanceof Error
        ? { kind: (e as { aiKind?: string }).aiKind ?? 'transient', message: e.message, section: regenerateSection }
        : { kind: 'transient', message: 'Failed', section: regenerateSection })
    }
    setAiLoading(false)
    setRegenSection(null)
    setAiProgress('')
  }, [asin, refreshRankFree, getToken, bumpHeartbeat, refreshHistory])

  /** Read a JSON response defensively. Coolify/nginx returns plain-text '502 Bad Gateway'
   *  HTML when the upstream Next process times out, restarts, or OOMs mid-request — calling
   *  `await resp.json()` on that throws the classic 'Unexpected token "B" is not valid JSON'.
   *  This wraps the read so we surface a clean, actionable message instead. */
  const readJsonOrThrowGateway = async (resp: Response, when: 'preview' | 'push'): Promise<unknown> => {
    const ct = resp.headers.get('content-type') || ''
    const text = await resp.text()
    if (!ct.includes('application/json') || /^\s*<|^\s*5\d{2}\s+|Bad Gateway|Gateway Time-?out/i.test(text)) {
      // It's HTML / plain text — a gateway / proxy error from Coolify, NOT a JSON response.
      const code = resp.status || 502
      const hint = when === 'push'
        ? `Server returned ${code} mid-push. The submission likely still reached Amazon — use Verify on Amazon to confirm before retrying (a retry could submit a duplicate patch).`
        : `Server returned ${code}. The app may be restarting (Coolify deploy?) — retry in ~30 seconds.`
      throw new Error(hint)
    }
    try { return JSON.parse(text) }
    catch {
      throw new Error(`Server returned malformed JSON (${resp.status}). ${when === 'push' ? 'Check Verify on Amazon before retrying.' : 'Retry shortly.'}`)
    }
  }

  // ─── Ship a content section to Amazon (preview → confirm) ─────────────────
  // detailField is only used for field='details' (one detail per click).
  const openPushPreview = useCallback(async (field: PushField, detailField?: string, presetSkus?: string[]) => {
    // CONCURRENT-PUSH GUARD: this function RESETS all shared push state below. Opening a
    // second Ship modal while a push streams would clobber the running push's tracking
    // (PO lost the title push's pill mid-146-SKU send by clicking Push keywords — the
    // server still finished it, but the UI lost it and both streams raced the same state).
    if (pushActiveRef.current) {
      window.alert('A push is still running (see the progress pill, bottom-right). Let it finish, or use "Queue in background" next time — queued pushes run server-side and can overlap safely.')
      return
    }
    setPushField(field)
    setPushDetailField(field === 'details' ? (detailField ?? null) : null)
    // Per-design scope for THIS push (PR-C): set when a per-design "Ship →" passes presetSkus, else
    // null so every existing full-listing Ship button keeps its unscoped behavior.
    setPushPresetSkus(presetSkus && presetSkus.length > 0 ? presetSkus : null)
    setPushError(null); setPushResults(null); setPushPreview(null); setDetailOverride(''); setVerifyResults(null); setVerifyError(null); setPushProgress([]); setPushPhase('idle'); setCancelRequested(false); pushCancelTokenRef.current = null; setShowPushModal(true); setPushLoading(true)
    try {
      const qs = field === 'details' && detailField
        ? `&detail_field=${encodeURIComponent(detailField)}`
        : ''
      const resp = await fetch(`/api/fba/listing-optimizer/push-content?parent_asin=${asin}&field=${field}${qs}`)
      const data = await readJsonOrThrowGateway(resp, 'preview') as { error?: string }
      if (!resp.ok) throw new Error(data.error || 'Preview failed')
      setPushPreview(data as PushPreview)
      if (field === 'title') {
        // Seed the editable title box with the AI's proposed title — ONLY for broadcast-title products.
        // Capacity families (per-child titles) keep their per-GB titles; a single typed string would
        // clobber them, so the editor is disabled there and editTitle stays empty (adversarial review).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any
        setEditTitle(d?.broadcast && typeof d.proposedValue === 'string' ? d.proposedValue : '')
        setTitleScore(null)
      }
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'Preview failed')
    }
    setPushLoading(false)
  }, [asin])

  /** Score the seller's TYPED title with the real engine (same scoreListingContent + validateTitle
   *  the dashboard uses) so they see the score + Amazon-rule violations BEFORE pushing their own title. */
  const scoreTitle = useCallback(async (text: string) => {
    if (!text.trim()) { setTitleScore(null); return }
    setTitleScoreLoading(true)
    try {
      const resp = await fetch('/api/fba/listing-optimizer/score-title', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_asin: asin, title: text.trim() }),
      })
      const data = await resp.json()
      setTitleScore(resp.ok ? data : null)
    } catch { setTitleScore(null) }
    setTitleScoreLoading(false)
  }, [asin])

  /** Build the exact push-content POST body — shared by the streaming push (confirmPush)
   *  and the server-side queue (queueBackgroundPush) so the two paths can never drift. */
  const buildPushBody = useCallback((onlySkus?: string[], detailOverrideArg?: string): Record<string, unknown> => {
    const body: Record<string, unknown> = { parent_asin: asin, field: pushField, confirm: true }
    if (pushField === 'details' && pushDetailField) body.detail_field = pushDetailField
    // Part 2b: the seller's pick for an uncoercible dropdown — push this exact accepted value.
    if (pushField === 'details' && (detailOverrideArg ?? '').trim()) body.detail_value_override = (detailOverrideArg ?? '').trim()
    // SKU scope: an explicit re-push subset (onlySkus, e.g. "push just the stale ones") wins; else the
    // per-design Ship preset (pushPresetSkus). Null/empty ⇒ full-listing push (every existing caller).
    const skus = onlySkus ?? pushPresetSkus
    if (skus && skus.length > 0) body.skus = skus
    // Manual title override: push the seller's TYPED title (from the editable box) instead of the AI's.
    if (pushField === 'title' && editTitle.trim()) body.title_override = editTitle.trim()
    return body
  }, [asin, pushField, pushDetailField, editTitle, pushPresetSkus])

  /** Ask the server to stop the running streaming push between SKUs (PO: "NO way to
   *  cancel when it starts"). Already-accepted SKUs stay pushed — Amazon has them. */
  const stopPush = useCallback(async () => {
    const token = pushCancelTokenRef.current
    if (!token) return
    setCancelRequested(true)
    try {
      await fetch('/api/fba/listing-optimizer/push-content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', cancel_token: token }),
      })
    } catch { /* loop keeps going; the button stays pressed and the user can retry */ }
  }, [])

  /** Queue the push as a SERVER-side job (PR #184): it survives tab close and deploys.
   *  The global status bar (every portal page) tracks it; nothing is streamed back here. */
  const [queueLoading, setQueueLoading] = useState(false)
  const queueBackgroundPush = useCallback(async (detailOverrideArg?: string) => {
    setPushError(null); setQueueLoading(true)
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/push-jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(buildPushBody(undefined, detailOverrideArg)),
      })
      const data = await resp.json() as { id?: string; error?: string }
      if (!resp.ok || !data.id) throw new Error(data.error || 'Failed to queue the push')
      // Hand off to the status bar: poke it so the job appears IMMEDIATELY (no silent
      // gap between the modal closing and the next poll tick).
      window.dispatchEvent(new Event('push-jobs-changed'))
      setShowPushModal(false)
      setPushPreview(null)
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'Failed to queue the push')
    }
    setQueueLoading(false)
  }, [buildPushBody, getToken])

  /**
   * Stream-consume the NDJSON push response. Each emit() from the server arrives as a
   * newline-delimited JSON line; we accumulate the read buffer until a newline, parse,
   * dispatch, then continue. The per-SKU 'progress' events keep the proxy connection
   * warm so the push survives container restarts and nginx idle-timeouts (the original
   * 502 Bad Gateway failure mode).
   */
  const confirmPush = useCallback(async (onlySkus?: string[], detailOverrideArg?: string) => {
    setPushError(null); setPushLoading(true); setPushPhase('starting')
    // Clear the PREVIOUS push's results + verify panel so a selective re-push ("push just the stale
    // ones") shows its OWN loading + per-SKU progress, instead of silently sitting behind the old
    // results — the PO saw it "close without action" because the re-push ran but stayed hidden.
    setPushProgress([]); setVerifyResults(null); setPushResults(null)
    // Cancel support (PO: "NO way to cancel when it starts") — a per-push token; the Stop
    // button POSTs {action:'cancel', cancel_token} and the server loop stops between SKUs.
    const cancelToken = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    pushCancelTokenRef.current = cancelToken
    setCancelRequested(false)
    let finalResult: { pushed: number; failed: number; total: number; message: string; results: PushResultRow[]; field?: PushField; healScheduled?: boolean; healAttrs?: string[] } | null = null
    let streamError: string | null = null
    const skuStatus = new Map<string, string>()   // latest status per SKU — rebuilds a partial result if the stream drops
    let serverTotal = 0                            // real diff size from the 'started' event (NOT just SKUs-seen-before-drop)
    try {
      const body = { ...buildPushBody(onlySkus, detailOverrideArg), cancel_token: cancelToken }
      const token = await getToken()
      const resp = await fetch('/api/fba/listing-optimizer/push-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      })

      // Non-OK BEFORE the stream opens means a body-validation error (we still send JSON
      // for those — see route.ts). Read it the defensive way to also catch 502 HTML in
      // the rare case the proxy throws before the stream gets going.
      if (!resp.ok) {
        const data = await readJsonOrThrowGateway(resp, 'push') as { error?: string }
        throw new Error(data.error || `Push failed (HTTP ${resp.status})`)
      }
      if (!resp.body) throw new Error('Server returned no body — connection dropped before stream.')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const handleLine = (line: string) => {
        if (!line.trim()) return
        let msg: { type?: string; sku?: string; status?: string; error?: string; submissionId?: string | null; pushed?: number; failed?: number; total?: number; message?: string; results?: PushResultRow[]; field?: PushField; healScheduled?: boolean; healAttrs?: string[] }
        try { msg = JSON.parse(line) } catch { return }
        if (msg.type === 'started') {
          setPushPhase('pushing')
          if (typeof msg.total === 'number') serverTotal = msg.total
        } else if (msg.type === 'progress' && msg.sku && msg.status) {
          skuStatus.set(msg.sku, msg.status)   // for the partial-result rebuild if the stream drops
          // Upsert per-SKU progress row. Validating overwritten by accepted/failed as the
          // SKU moves through the loop.
          setPushProgress((prev) => {
            const idx = prev.findIndex((p) => p.sku === msg.sku)
            const row: PushProgressRow = { sku: msg.sku!, status: msg.status as PushProgressRow['status'], error: msg.error, submissionId: msg.submissionId }
            if (idx === -1) return [...prev, row]
            const next = prev.slice(); next[idx] = row; return next
          })
        } else if (msg.type === 'rescore') {
          setPushPhase('rescoring')
        } else if (msg.type === 'result') {
          finalResult = {
            field: msg.field,
            pushed: msg.pushed ?? 0,
            failed: msg.failed ?? 0,
            total: msg.total ?? 0,
            message: msg.message ?? 'Push completed.',
            results: msg.results ?? [],
            healScheduled: msg.healScheduled,
            healAttrs: msg.healAttrs,
          }
        } else if (msg.type === 'error') {
          streamError = msg.error || 'Push failed mid-stream.'
        }
      }
      // Read pump: decode, split on newlines, dispatch each complete line, keep the
      // partial tail in the buffer for the next read.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      }
      // Flush whatever's left (server should always terminate with a newline, but defend).
      if (buffer.trim()) handleLine(buffer)

      if (streamError) throw new Error(streamError)
      // TS loses narrowing across the closure-mutated `finalResult` — re-assert the shape.
      let data: { pushed: number; failed: number; total: number; message: string; results: PushResultRow[]; field?: PushField; healScheduled?: boolean; healAttrs?: string[] }
      if (finalResult) {
        data = finalResult
      } else {
        // The stream dropped BEFORE the final result event — the proxy window on a long 100+ SKU push.
        // The writes that already ACCEPTED are real, so don't throw a scary error: rebuild a partial
        // result from the per-SKU statuses so the seller sees what landed and can re-check + push ONLY
        // the stragglers (instead of re-shipping everything and re-triggering the same drop).
        const statuses = [...skuStatus.values()]
        const accepted = statuses.filter((s) => s === 'accepted').length
        const failed = statuses.filter((s) => s === 'failed').length
        if (accepted === 0) throw new Error('Stream ended without a result event.')
        // Use the REAL diff size from the 'started' event, not just SKUs-seen-before-the-drop, so the
        // seller isn't told "20 of 25" when 131 were queued (adversarial review caught this).
        const realTotal = serverTotal || statuses.length
        const pending = Math.max(0, realTotal - accepted - failed)
        data = { field: pushField, pushed: accepted, failed, total: realTotal, message: `Push interrupted — ${accepted} of ${realTotal} SKU(s) reached Amazon${pending > 0 ? `, ${pending} not yet sent` : ''}. The connection dropped mid-stream. Re-check live below, then push just the stale ones.`, results: [] }
      }
      // A field is only "fully shipped" when a COMPLETE stream landed every SKU with zero failures.
      // A partial/interrupted push (rebuilt result) or any failure must NOT collapse the card to DONE —
      // that would tell the seller the field is shipped while SKUs are still stale (adversarial review).
      const fullyShipped = !!finalResult && data.failed === 0 && data.total > 0 && data.pushed === data.total

      setPushResults(data)
      setPushPreview(null)
      setPushPhase('done')

      // Refresh score (push re-scored server-side).
      if (data.pushed > 0) {
        try {
          // no-store + ensure=: a push just mutated listing_content; the refetch MUST be fresh AND must
          // include THIS asin so the cohesion rows + per-design chips flip without a manual reload. The bare
          // LIST is top-50-by-sales, so a low-traffic listing was absent → the flip only happened on reload
          // (PO-reported). ensure= re-scores this asin on demand from the fresh cache.
          const sresp = await fetch(`/api/fba/listing-optimizer?limit=200&ensure=${encodeURIComponent(asin)}`, { cache: 'no-store' })
          const sdata = await sresp.json()
          const found = sdata.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
          if (found) setScore(found)
        } catch { /* best-effort — the score still updates on next load */ }
        // A content push (title/bullets/description/keywords) changed live coverage → recompute the
        // Rank-Top card so it stops showing now-covered "gaps" (details don't affect keyword coverage).
        if (pushField !== 'details') refreshRankFree()

        // After a FULL ship the card verdicts change server-side (derived) — refetch below. A
        // partial/interrupted push refetches too; the derived plan stays REPLACE for stragglers
        // (the deriver compares every cached child, so a half-pushed field can never read DONE).
        if (fullyShipped) {
        // Mirror the server write-through locally for the pushed DETAIL row, so its panel card
        // flips to "✓ On Amazon" immediately (PO: "no notice after PUSH") — same mirror Auto Push
        // does. The server already persisted current_value = pushed value; this avoids a refetch.
        if (pushField === 'details' && pushDetailField) {
          const pushedValue = (detailOverrideArg ?? '').trim()
          setAiRecs((prev) => prev ? {
            ...prev,
            product_details_improvements: (prev.product_details_improvements ?? []).map((pd) =>
              pd.field_name === pushDetailField
                ? { ...pd, current_value: pushedValue || pd.recommended_value, ...(pushedValue ? { recommended_value: pushedValue } : {}), enum_valid: pd.is_enum ? true : pd.enum_valid }
                : pd),
          } : prev)
        }
        } // end if (fullyShipped)
        // SHIP-TRUTH (2026-07-09): the local DONE-stamp mirror is GONE — the server derives card
        // verdicts from rec-vs-cache, and the push write-through already updated the cache, so a
        // refetch of the GET returns the truthful plan. Runs on PARTIAL pushes too (adversarial):
        // the derived plan correctly stays REPLACE while stragglers remain, and the accepted SKUs'
        // write-through still moves the cohesion counts.
        void (async () => {
          try {
            const r = await fetch(`/api/fba/listing-optimizer/ai-recommendations?parent_asin=${asin}&_t=${Date.now()}`, { cache: 'no-store' })
            const j = await r.json() as { recommendations?: AiRecommendations | null }
            if (j?.recommendations) setAiRecs(j.recommendations)
          } catch { /* refetch is best-effort — the next page load serves derived truth */ }
        })()
      }
      // Phase B: a push is a mutation that the server also mirrors into the change-log + may
      // auto-release the claim (release_reason='push'). Bump the heartbeat (covers a partial push
      // that KEEPS the claim) and re-sync both the claim chip and the merged change-history.
      bumpHeartbeat()
      refreshClaim()
      refreshHistory()
      // Phase C: a full-accept push stamps the measuring epoch in listing_outcome_state — re-pull the
      // ledger + sparkline so the Outcome panel flips to "Measuring 0/2" right away (best-effort).
      refreshOutcome()
      // Live-notice: the push may have just enqueued a verify AND/OR a self-heal task — refresh the
      // verification banner NOW so a scheduled heal is visible before the seller can re-push,
      // instead of waiting up to 60s for the next poll tick.
      refreshVerifyQueue()
    } catch (e) {
      // If we have any progress rows, the seller knows what landed (the stream told them
      // per-SKU). We do NOT clear them on error — they're the rollback evidence.
      setPushError(e instanceof Error ? e.message : 'Push failed')
      setPushPhase('idle')
    }
    setPushLoading(false)
  }, [asin, pushField, pushDetailField, buildPushBody, refreshRankFree, getToken, bumpHeartbeat, refreshClaim, refreshHistory, refreshOutcome, refreshVerifyQueue])

  // Ready = pushable (schema-mapped or static), not enum-INVALID, has a value, and differs from live.
  const bulkEligibleDetails = useMemo(() => {
    const rows = aiRecs?.product_details_improvements ?? []
    const ihWritable = aiRecs?.item_highlights_writable   // boolean | undefined
    // STYLE LEAK GATE (B) — the seller's manual override is authoritative over the auto-detector (both
    // directions); falls back to per_child_titles when unset. Same predicate the per-row + server gates use.
    const multi = resolveMultiDesign(aiRecs?.per_child_titles, isMultiDesignOverride)
    return rows.filter((pd) =>
      (pd.pushable ?? isPushableDetail(pd.field_name)) &&
      pd.enum_valid !== false &&
      (pd.recommended_value ?? '').trim() !== '' &&
      (pd.current_value ?? '').trim() !== pd.recommended_value.trim() &&
      // Item Highlights: excluded from Auto Push while Amazon's API refuses writes. Driven by the
      // server probe flag (item_highlights_writable), NOT a hardcoded date. undefined (legacy GET)
      // → treat as blocked so old cached responses stay safe. Only an explicit `true` unblocks.
      !(isItemHighlightsField(pd.field_name, pd.sp_api_key) && ihWritable !== true) &&
      // STYLE LEAK GATE (B): never bulk-push style/style_name on a multi-design family — one value would
      // overwrite each design's distinct style. Mirrors the per-row gate + the server block (loadDetailContext).
      !(multi && (isSingleDesignOnlyKey(pd.sp_api_key) || isSingleDesignOnlyDetail(pd.field_name))),
    )
  }, [aiRecs, isMultiDesignOverride])

  const openBulkPush = useCallback(() => {
    // Same concurrent-push guard as openPushPreview — Auto Push must not start while a
    // single push streams (two streams race the UI and double the SP-API rate).
    // Re-opening WHILE Auto Push is running must NOT reset the rows — show the live progress
    // (PO: "can I close the modal mid-process?" — yes, it keeps running; reopening resumes the view).
    if (bulkRunning) { setBulkOpen(true); return }
    if (pushActiveRef.current) {
      window.alert('A push is still running (see the progress pill, bottom-right). Let it finish before starting Auto Push.')
      return
    }
    setBulkItems(bulkEligibleDetails.map((pd) => ({ field: pd.field_name, value: prettyDetailValue(pd.recommended_value, pd.enum_accepted), status: 'ready' as const, accepted: pd.enum_accepted })))
    setBulkFinished(false)
    setBulkProgress({ done: 0, total: 0 })
    setBulkOpen(true)
  }, [bulkEligibleDetails, bulkRunning])

  /** ONE batched call: all selected detail attributes pushed PER SKU (each SKU gets a single
   *  multi-attribute PATCH) — ~7× fewer Amazon calls than field-at-a-time. The server batches
   *  the changed fields per SKU and falls back to per-field for any SKU whose batch is rejected,
   *  so failure isolation is preserved. We map the final per-field tally back onto the rows. */
  const runBulkPush = useCallback(async () => {
    if (bulkRunning) return
    setBulkRunning(true)
    const items = bulkItems
    const fields = items.filter((it) => !it.skip).map((it) => it.field)
    const setByField = (field: string, patch: Partial<BulkPushItem>) =>
      setBulkItems((prev) => prev.map((it) => (it.field === field ? { ...it, ...patch } : it)))
    for (const it of items) if (!it.skip) setByField(it.field, { status: 'pushing' })
    const cancelToken = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `b${Math.random().toString(36).slice(2)}`
    bulkCancelTokenRef.current = cancelToken
    setCancelRequested(false)
    setBulkProgress({ done: 0, total: 0 })
    bulkStreamInterruptedRef.current = false
    let anyPushed = false
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/listing-optimizer/push-content', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // Send each (possibly-edited) value as a per-field override — the server re-validates/
        // coerces it (a wrong manual value is flagged + skipped, never pushed). PO: edit before bulk.
        body: JSON.stringify({ parent_asin: asin, field: 'details_bulk', detail_fields: fields, detail_overrides: Object.fromEntries(items.filter((it) => !it.skip).map((it) => [it.field, it.value])), confirm: true, cancel_token: cancelToken }),
      })
      if (!resp.ok) { const data = await readJsonOrThrowGateway(resp, 'push') as { error?: string }; throw new Error(data.error || `HTTP ${resp.status}`) }
      if (!resp.body) throw new Error('Connection dropped before stream.')
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result: { perField?: { field: string; accepted: number; failed: number; skippedReason?: string }[]; message?: string } | null = null
      let streamError: string | null = null
      const handleLine = (line: string) => {
        if (!line.trim()) return
        try {
          const msg = JSON.parse(line) as { type?: string; sku?: string; status?: string; total?: number; fields?: string[]; perField?: { field: string; accepted: number; failed: number; skippedReason?: string }[]; message?: string; error?: string; skipped?: { field: string; reason: string }[] }
          if (msg.type === 'started') {
            if (typeof msg.total === 'number') setBulkProgress({ done: 0, total: msg.total })
            if (Array.isArray(msg.skipped)) for (const s of msg.skipped) setByField(s.field, { status: 'failed', note: s.reason })
          } else if (msg.type === 'progress' && msg.status && msg.status !== 'validating') {
            // one terminal event per SKU (accepted/failed/partial/skipped) → advance the bar
            setBulkProgress((p) => ({ ...p, done: Math.min(p.done + 1, p.total || p.done + 1) }))
          } else if (msg.type === 'result') result = msg
          else if (msg.type === 'error') streamError = msg.error || 'Auto Push failed mid-stream.'
        } catch { /* keepalive/partial line */ }
      }
      // WATCHDOG: a dropped stream (Coolify/Cloudflare kill long requests ~100s; the server keeps
      // running + finishes) used to leave reader.read() hanging forever → the modal showed "Pushing…"
      // for 40+ minutes though the push had ALREADY completed (live-confirmed: Sleeve applied on all
      // 65 SKUs). If no chunk arrives for STALL_MS, stop waiting and tell the seller to Verify
      // (accepted SKUs stay — the run is idempotent). Resets on every chunk.
      const STALL_MS = 60_000
      let streamStalled = false
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const stall = new Promise<'stall'>((res) => { timer = setTimeout(() => res('stall'), STALL_MS) })
        const next = await Promise.race([reader.read(), stall])
        if (timer) clearTimeout(timer)
        if (next === 'stall') { streamStalled = true; try { await reader.cancel() } catch { /* already closed */ } break }
        const { done, value } = next as ReadableStreamReadResult<Uint8Array>
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      }
      if (streamStalled && !result && !streamError) {
        streamError = 'Connection dropped (likely a deploy or network blip). The push usually finishes on the server regardless — click Verify live on a field to confirm; already-accepted SKUs stay pushed. Re-run Auto Push to finish any that are still missing.'
      }
      if (buffer.trim()) handleLine(buffer)
      if (streamError) throw new Error(streamError)
      if (!result) throw new Error('Stream ended without a result.')
      const r = result as { perField?: { field: string; accepted: number; failed: number; skippedReason?: string }[] }
      for (const pf of r.perField ?? []) {
        if (pf.skippedReason) { setByField(pf.field, { status: 'failed', note: pf.skippedReason }); continue }
        const ok = pf.failed === 0 && pf.accepted > 0
        const upToDate = pf.failed === 0 && pf.accepted === 0   // every SKU already correct
        if (ok) anyPushed = true
        setByField(pf.field, {
          status: ok || upToDate ? 'done' : 'failed',
          note: upToDate ? 'Already up to date on all SKUs' : `${pf.accepted} pushed${pf.failed ? `, ${pf.failed} failed` : ''}`,
        })
        if ((ok || upToDate)) {
          const value = items.find((it) => it.field === pf.field)?.value
          setAiRecs((prev) => prev ? {
            ...prev,
            product_details_improvements: (prev.product_details_improvements ?? []).map((pd) =>
              pd.field_name === pf.field ? { ...pd, current_value: value ?? pd.current_value, enum_valid: pd.is_enum ? true : pd.enum_valid } : pd),
          } : prev)
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Auto Push failed'
      // Gateway-class (deploy restart / stream stalled): the server keeps processing already-started
      // SKUs, and the whole run is idempotent — re-running only touches still-wrong SKUs.
      const gateway = /502|Bad Gateway|Stream ended|Connection dropped|gateway/i.test(msg)
      // CLOSURE BUG FIX (live: Auto Push showed "Complete" with all rows stuck on "Pushing…" because
      // `items[i].status === 'pushing'` checked the ORIGINAL captured array which still had
      // status:'ready'). Read CURRENT state via functional setBulkItems and mark every not-yet-terminal
      // row as failed with the actionable message.
      setBulkItems((prev) => prev.map((it) =>
        it.skip || it.status === 'done' || it.status === 'failed' ? it :
        { ...it, status: 'failed', note: gateway ? 'Stream interrupted before completion. Already-accepted SKUs stay pushed — re-run Auto Push to finish the rest (idempotent: only still-wrong SKUs re-push).' : msg }
      ))
      // Record that we DID NOT receive a clean result so the header message tells the truth.
      bulkStreamInterruptedRef.current = true
    }
    if (anyPushed) {
      try {
        const sresp = await fetch('/api/fba/listing-optimizer', { cache: 'no-store' })
        const sdata = await sresp.json()
        const found = sdata.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
        if (found) setScore(found)
      } catch { /* best-effort */ }
    }
    bulkCancelTokenRef.current = null
    setBulkRunning(false)
    setBulkFinished(true)
  }, [asin, bulkItems, bulkRunning, getToken])

  /** Stop a running Auto Push between SKUs (same server cancel as the single-push Stop). */
  const stopBulkPush = useCallback(async () => {
    const token = bulkCancelTokenRef.current
    if (!token) return
    setCancelRequested(true)
    try {
      await fetch('/api/fba/listing-optimizer/push-content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', cancel_token: token }),
      })
    } catch { /* the run still stops between SKUs on its own if the flag landed */ }
  }, [])

  /** "Ship all confirmed core": Title + Bullets + Description + Keywords in ONE PATCH per SKU via the
   *  core_bulk executor. Cloned from runBulkPush — same NDJSON stream reader + stall watchdog. On a
   *  result it refetches the score, recomputes the free rank card, and re-pulls the derived plan
   *  (ship-truth). Gated by the shared concurrent-push guard so it never races another stream. */
  const runCoreBulkPush = useCallback(async () => {
    if (coreBulkRunning) return
    if (pushActiveRef.current) {
      window.alert('A push is still running (see the progress pill, bottom-right). Let it finish before shipping all core.')
      return
    }
    setCoreBulkRunning(true)
    setCoreBulkFinished(false)
    setCoreBulkOpen(true)
    setCoreBulkMessage('')
    setCoreBulkPerField([])
    setCoreBulkProgress({ done: 0, total: 0 })
    const cancelToken = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `c${Math.random().toString(36).slice(2)}`
    coreBulkCancelTokenRef.current = cancelToken
    coreBulkInterruptedRef.current = false
    setCancelRequested(false)
    let anyPushed = false
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/listing-optimizer/push-content', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ parent_asin: asin, field: 'core_bulk', core_fields: ['title', 'bullets', 'description', 'keywords'], confirm: true, cancel_token: cancelToken }),
      })
      if (!resp.ok) { const data = await readJsonOrThrowGateway(resp, 'push') as { error?: string }; throw new Error(data.error || `HTTP ${resp.status}`) }
      if (!resp.body) throw new Error('Connection dropped before stream.')
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result: { perField?: { field: string; accepted: number; failed: number }[]; message?: string; pushed?: number } | null = null
      let streamError: string | null = null
      const handleLine = (line: string) => {
        if (!line.trim()) return
        try {
          const msg = JSON.parse(line) as { type?: string; status?: string; total?: number; perField?: { field: string; accepted: number; failed: number }[]; message?: string; error?: string; pushed?: number }
          if (msg.type === 'started') { if (typeof msg.total === 'number') setCoreBulkProgress({ done: 0, total: msg.total }) }
          else if (msg.type === 'progress' && msg.status && msg.status !== 'validating') {
            // one terminal event per SKU (accepted/failed/partial) → advance the bar
            setCoreBulkProgress((p) => ({ ...p, done: Math.min(p.done + 1, p.total || p.done + 1) }))
          }
          else if (msg.type === 'result') result = msg
          else if (msg.type === 'error') streamError = msg.error || 'Ship all core failed mid-stream.'
        } catch { /* keepalive/partial line */ }
      }
      // WATCHDOG: a dropped stream (Coolify/Cloudflare kill long requests ~100s; the server keeps
      // running + finishes) must not leave reader.read() hanging forever. If no chunk arrives for
      // STALL_MS, stop waiting and tell the seller to Verify (accepted SKUs stay — the run is idempotent).
      const STALL_MS = 60_000
      let streamStalled = false
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const stall = new Promise<'stall'>((res) => { timer = setTimeout(() => res('stall'), STALL_MS) })
        const next = await Promise.race([reader.read(), stall])
        if (timer) clearTimeout(timer)
        if (next === 'stall') { streamStalled = true; try { await reader.cancel() } catch { /* already closed */ } break }
        const { done, value } = next as ReadableStreamReadResult<Uint8Array>
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      }
      if (streamStalled && !result && !streamError) {
        streamError = 'Connection dropped (likely a deploy or network blip). The push usually finishes on the server regardless — click Verify live to confirm; already-accepted SKUs stay pushed. Re-run Ship all core to finish any that are still missing.'
      }
      if (buffer.trim()) handleLine(buffer)
      if (streamError) throw new Error(streamError)
      if (!result) throw new Error('Stream ended without a result.')
      const r = result as { perField?: { field: string; accepted: number; failed: number }[]; message?: string; pushed?: number }
      setCoreBulkPerField(r.perField ?? [])
      setCoreBulkMessage(r.message ?? 'Done.')
      anyPushed = (r.pushed ?? 0) > 0
    } catch (e) {
      coreBulkInterruptedRef.current = true
      setCoreBulkMessage(e instanceof Error ? e.message : 'Ship all core failed')
    }
    // On a result that shipped something: refetch score + recompute the free rank card + re-pull the
    // derived action plan (ship-truth — the server write-through + re-score already ran).
    if (anyPushed) {
      try {
        const sresp = await fetch('/api/fba/listing-optimizer', { cache: 'no-store' })
        const sdata = await sresp.json()
        const found = sdata.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
        if (found) setScore(found)
      } catch { /* best-effort — the score still updates on next load */ }
      refreshRankFree()
      void (async () => {
        try {
          const rr = await fetch(`/api/fba/listing-optimizer/ai-recommendations?parent_asin=${asin}&_t=${Date.now()}`, { cache: 'no-store' })
          const jj = await rr.json() as { recommendations?: AiRecommendations | null }
          if (jj?.recommendations) setAiRecs(jj.recommendations)
        } catch { /* refetch is best-effort — the next page load serves derived truth */ }
      })()
    }
    coreBulkCancelTokenRef.current = null
    setCoreBulkRunning(false)
    setCoreBulkFinished(true)
  }, [asin, coreBulkRunning, getToken, refreshRankFree])

  /** Stop a running Ship-all-core between SKUs (same server cancel as the other pushes). */
  const stopCoreBulkPush = useCallback(async () => {
    const token = coreBulkCancelTokenRef.current
    if (!token) return
    setCancelRequested(true)
    try {
      await fetch('/api/fba/listing-optimizer/push-content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', cancel_token: token }),
      })
    } catch { /* the run still stops between SKUs on its own if the flag landed */ }
  }, [])

  /** Verify what Amazon ACTUALLY has live right now for the just-pushed field.
   *  Useful when a push was Accepted but the seller doesn't see it on Seller Central
   *  or the PDP — answers "is Amazon still processing, or did the push silently fail?". */
  const runVerify = useCallback(async () => {
    setVerifyError(null); setVerifyResults(null); setVerifyLoading(true)
    try {
      const qs = pushField === 'details' && pushDetailField
        ? `&detail_field=${encodeURIComponent(pushDetailField)}`
        : ''
      const resp = await fetch(`/api/fba/listing-optimizer/verify-push?parent_asin=${asin}&field=${pushField}${qs}`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Verify failed')
      setVerifyResults(data)
      // verify-push GROUNDED listing_content to Amazon's live value + re-scored (heal-on-verify) — pull
      // the fresh score so the VARIANT COHESION "needs update" counts reflect it without a hard refresh.
      await refreshScore()
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : 'Verify failed')
    }
    setVerifyLoading(false)
  }, [asin, pushField, pushDetailField, refreshScore])

  // Honest "will change" count for a MANUAL title override: the preview's `changed` is computed vs the
  // AI recommendation, but the seller may have typed something else. Compare each SKU's LIVE title to
  // the TYPED title so the modal shows only the variants that genuinely differ — the rest are skipped
  // server-side (loadDiff filters changed===false), so we must not claim they'll all change.
  const titleOverrideChanged = (pushField === 'title' && pushPreview?.broadcast && editTitle.trim())
    ? pushPreview.diff.filter((d) => (d.current ?? '') !== editTitle.trim().slice(0, 200)).length
    : null
  const displayChanged = titleOverrideChanged ?? pushPreview?.changed ?? 0

  // C1 — ADVISORY ONLY (never gates the Confirm button). A backend-keyword push is "mostly lateral"
  // when every changing child is ALREADY full (≥200 chars, ≤250 bytes, comma-free → no length/byte/
  // comma penalty left to fix) AND its recommended terms overlap heavily with the live terms (few new
  // tokens → the ranking terms are already indexed). We surface only a SOFT hint — we do NOT hide the
  // push or claim a guarantee — because client-side we can't see the opportunity-keyword list. If the
  // live field is short/over-cap, we show nothing (that push can genuinely raise the score).
  const lateralKeywordAdvisory = (() => {
    if (!pushPreview || pushPreview.field !== 'keywords') return null
    const rows = pushPreview.diff.filter((d) => d.changed && !d.isParent)
    if (rows.length === 0) return null
    const enc = new TextEncoder()
    const toks = (s: string) => new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))
    const jaccard = (a: string, b: string) => {
      const A = toks(a), B = toks(b)
      if (!A.size || !B.size) return 0
      let inter = 0; A.forEach((t) => { if (B.has(t)) inter++ })
      return inter / (A.size + B.size - inter)
    }
    const allMaxed = rows.every((d) => (d.current || '').length >= 200 && enc.encode(d.current || '').length <= 250 && !(d.current || '').includes(','))
    if (!allMaxed) return null
    const overlaps = rows.map((d) => jaccard(d.current || '', d.proposed || ''))
    if (!overlaps.every((o) => o >= 0.70)) return null
    return { pct: Math.round((100 * overlaps.reduce((s, o) => s + o, 0)) / overlaps.length) }
  })()

  // ─── Grouped Reconciliation Logic ─────────────────────────────────────────

  const placementGroups = (() => {
    if (!aiRecs?.keyword_reconciliation?.length) return null
    const groups: Record<string, { text: string; keywords: { keyword: string; action_type: string; search_volume: number; why: string }[] }> = {}
    for (const kr of aiRecs.keyword_reconciliation) {
      const key = [...kr.placed_in].sort().join(' + ')
      if (!groups[key]) groups[key] = { text: kr.exact_text, keywords: [] }
      groups[key].keywords.push({ keyword: kr.keyword, action_type: kr.action_type, search_volume: kr.search_volume, why: kr.why })
    }
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a.includes('title') && !b.includes('title')) return -1
      if (!a.includes('title') && b.includes('title')) return 1
      if (a.includes('bullet') && !b.includes('bullet')) return -1
      if (!a.includes('bullet') && b.includes('bullet')) return 1
      return a.localeCompare(b)
    })
    return { groups, sortedKeys, total: aiRecs.keyword_reconciliation.length }
  })()

  // ─── Loading / Not Found ──────────────────────────────────────────────────

  // Ghost-parent redirect in flight (PR #89) — show a clear message instead of flashing
  // the dead listing's stale content before router.replace swaps the page.
  if (ghostRedirecting) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-sm text-slate-600">This ASIN&apos;s variation family moved — opening the live parent…</p>
      </div>
    </div>
  )

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-sm text-slate-500">Loading listing data...</p>
      </div>
    </div>
  )

  if (!score) return (
    <div className="max-w-4xl mx-auto p-8 text-center">
      <p className="text-lg text-slate-600 mb-4">Listing not found: {asin}</p>
      <button onClick={() => router.push('/fba')} className="text-violet-600 hover:underline text-sm">
        &larr; Back to Listing Optimizer
      </button>
    </div>
  )

  const displayImage = score.image_url || fetchedImage
  // Capacity-family parents (e.g. SD cards by GB): the stored product_title is the best-seller
  // CHILD's title, so it carries that child's capacity ("...64GB..."). The parent / variation-hub
  // header must be capacity-AGNOSTIC — strip the GB token, mirroring the TITLES card's PARENT row.
  // multiDesign (>=2 distinct designKeys) is computed FIRST because it suppresses the capacity
  // per-child UI for multi-design apparel — which ALSO has per_child_titles.length > 1, so without
  // this guard a multi-design family double-renders the (mislabeled) capacity title table + header.
  const multiDesign = isMultiDesign(aiRecs?.per_child_titles)
  // Gated on per_child_titles.length > 1 (only built for non-apparel capacity families), so apparel
  // and single-capacity products are untouched.
  const isCapacityFamily = Array.isArray(aiRecs?.per_child_titles) && (aiRecs?.per_child_titles?.length ?? 0) > 1 && !multiDesign
  const headerTitle = isCapacityFamily
    ? stripCapacityToken(stripVariantSuffix(score.product_title))
    : stripVariantSuffix(score.product_title)

  // ── Per-design editor cards (multi-design apparel families like FHOSH/FRAF/OF fishing tees) ──
  // designGroups is computed ABOVE the early returns (hook-order safety — defined with the other
  // hooks). multiDesign (above) gates the new section AND suppresses the old capacity per-child table.

  // True iff the seller has begun editing this design (its entry exists in designEdits).
  const designDirty = (k: string) => !!designEdits[k]
  // Immutable edit-state updaters — seed from the design's resolved content (group's own per-child
  // set, else the broadcast recommended_* fallback) on the first touch so a partial edit doesn't
  // wipe the untouched fields. Keyed by designKey.
  const seedFromGroup = (k: string) => {
    const g = designGroups.find((x) => x.designKey === k)
    return {
      title: g?.title ?? '',
      bullets: g && g.bullets.length ? g.bullets : (aiRecs?.recommended_bullets ?? []),
      description: g ? (g.description || (aiRecs?.recommended_description ?? '')) : (aiRecs?.recommended_description ?? ''),
    }
  }
  const onEditDesignTitle = (k: string, v: string) =>
    setDesignEdits((prev) => ({ ...prev, [k]: { ...(prev[k] ?? seedFromGroup(k)), title: v } }))
  const onEditDesignBullet = (k: string, i: number, v: string) =>
    setDesignEdits((prev) => {
      const cur = prev[k] ?? seedFromGroup(k)
      const bullets = [...(cur.bullets ?? [])]
      bullets[i] = v
      return { ...prev, [k]: { ...cur, bullets } }
    })
  const onEditDesignDescription = (k: string, v: string) =>
    setDesignEdits((prev) => ({ ...prev, [k]: { ...(prev[k] ?? seedFromGroup(k)), description: v } }))

  // ── Save: persist this design's edited title/bullets/description to OUR DB (PR-C). DB-only —
  // never touches Amazon. On success, merge the server's updated arrays into aiRecs (so the card
  // re-renders from saved content without a reload) and clear this design's pending edits.
  const onSaveDesign = async (group: PerDesignGroup): Promise<boolean> => {
    const edits = designEdits[group.designKey]
    if (!edits) return true // nothing to save → treat as success (ship can proceed)
    setDesignBusy((p) => ({ ...p, [group.designKey]: true }))
    try {
      const resp = await fetch('/api/fba/listing-optimizer/ai-recommendations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_asin: asin, skus: group.skus, ...edits }),
      })
      const data = await resp.json() as {
        error?: string
        per_child_titles?: AiRecommendations['per_child_titles']
        per_child_bullets?: AiRecommendations['per_child_bullets']
        per_child_descriptions?: AiRecommendations['per_child_descriptions']
      }
      if (!resp.ok) throw new Error(data.error || 'Save failed')
      setAiRecs((prev) => prev ? {
        ...prev,
        per_child_titles: data.per_child_titles ?? prev.per_child_titles,
        per_child_bullets: data.per_child_bullets ?? prev.per_child_bullets,
        per_child_descriptions: data.per_child_descriptions ?? prev.per_child_descriptions,
      } : prev)
      setDesignEdits((prev) => { const n = { ...prev }; delete n[group.designKey]; return n })
      // Saved content may now differ from live → drop any stale "matches" so the chip isn't misleading.
      setDesignVerifyStatus((prev) => { const n = { ...prev }; delete n[group.designKey]; return n })
      return true
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Save failed')
      return false
    } finally {
      setDesignBusy((p) => ({ ...p, [group.designKey]: false }))
    }
  }

  // ── Verify: read Amazon's LIVE content for THIS design's SKUs only (verify-push skus subset, PR-C).
  // Title is the per-design discriminator (bullets/description are broadcast), so verify on the title
  // field. 'matches' iff every scored SKU live-matches; otherwise 'needs-update'.
  const onVerifyDesign = async (group: PerDesignGroup): Promise<void> => {
    setDesignBusy((p) => ({ ...p, [group.designKey]: true }))
    try {
      const resp = await fetch(
        `/api/fba/listing-optimizer/verify-push?parent_asin=${asin}&field=title&skus=${encodeURIComponent(group.skus.join(','))}`,
      )
      const data = await resp.json() as { error?: string; total?: number; matched?: number }
      if (!resp.ok) throw new Error(data.error || 'Verify failed')
      const total = data.total ?? 0
      const matched = data.matched ?? 0
      const status: 'matches' | 'needs-update' = total > 0 && matched === total ? 'matches' : 'needs-update'
      setDesignVerifyStatus((prev) => ({ ...prev, [group.designKey]: status }))
      // Same heal-on-verify pull as runVerify: grounded listing_content + re-scored server-side, so
      // refresh the client score → the cohesion counts flip without a hard refresh.
      await refreshScore()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Verify failed')
    } finally {
      setDesignBusy((p) => ({ ...p, [group.designKey]: false }))
    }
  }

  // ── Ship one field of one design (PR-C): save first if dirty, then OPEN the existing push preview
  // modal scoped to this design's SKUs. SECURITY: this only OPENS the modal — the seller confirms the
  // push there (confirmPush runs only from the modal's Confirm button). No live push is auto-fired.
  const onShipDesignField = async (group: PerDesignGroup, field: 'title' | 'bullets' | 'description') => {
    if (designDirty(group.designKey)) {
      const ok = await onSaveDesign(group)
      if (!ok) return // save failed — don't open a Ship preview over unsaved content
    }
    openPushPreview(field, undefined, group.skus)
  }
  // Tab definitions for the dashboard-style section nav (one section visible at a time).
  const TABS = [
    { id: 'apply', label: 'Apply Changes', count: (aiRecs?.action_plan ?? []).filter(a => a.verdict !== 'DONE' && a.verdict !== 'SKIP').length },
    { id: 'placement', label: 'Keyword Plan', count: aiRecs?.keyword_reconciliation?.length ?? 0 },
    { id: 'issues', label: 'Diagnostics', count: score.issues.length },
    { id: 'variants', label: 'Variants', count: dedupByAsin(score.children).length },
    ...(kwData ? [{ id: 'kwintel', label: 'Intelligence', count: kwData.totalKeywordsAnalyzed }] : []),
  ]
  // Each card shows its IMPORTANCE-WEIGHTED points (max = the section's weight). The six maxes
  // sum to 100, so the cards add up to the listing score — and a perfect listing reads 100, not
  // 150. The % (points/weight) still reflects how good the section is. Weights: scoreWeights.ts.
  const bars = [
    { label: 'Title', score: weightedPoints(score.title_score, SECTION_WEIGHTS.title), max: SECTION_WEIGHTS.title },
    { label: 'Bullets', score: weightedPoints(score.bullet_score, SECTION_WEIGHTS.bullets), max: SECTION_WEIGHTS.bullets },
    { label: 'Keywords', score: weightedPoints(score.keyword_score, SECTION_WEIGHTS.keyword), max: SECTION_WEIGHTS.keyword },
    // Description + Features are NULL on older rows until re-scored — show the cards only once
    // populated so we never render a phantom 0%.
    ...(score.description_score != null ? [{ label: 'Description', score: weightedPoints(score.description_score, SECTION_WEIGHTS.description), max: SECTION_WEIGHTS.description }] : []),
    ...(score.features_score != null ? [{ label: 'Features', score: weightedPoints(score.features_score, SECTION_WEIGHTS.features), max: SECTION_WEIGHTS.features }] : []),
    { label: 'A+', score: weightedPoints(score.aplus_score, SECTION_WEIGHTS.aplus), max: SECTION_WEIGHTS.aplus },
  ]

  // ─── Render ───────────────────────────────────────────────────────────────

  // Someone else holds the claim (not stale) — block editing with dark overlay.
  const blockedByOther = !!claim && !claim.stale && !iHoldClaim

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-100 via-slate-50 to-slate-50 relative">

    {/* ══ LOCK OVERLAY — WooCommerce-style dark screen when someone else is editing ═══════ */}
    {blockedByOther && (
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-2xl p-8 text-center max-w-sm mx-4">
          <div className="w-14 h-14 rounded-full bg-violet-100 flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 24 24" className="w-7 h-7 text-violet-600" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
          </div>
          <h2 className="text-lg font-bold text-slate-900 mb-1">
            {claim?.claimed_by_name || 'Someone'} is editing this listing
          </h2>
          <p className="text-sm text-slate-500 mb-5">
            Active {claim?.last_heartbeat ? relDate(claim.last_heartbeat) : 'recently'}. You can take over if they&rsquo;re done.
          </p>
          <button
            onClick={openTakeover}
            disabled={claimBusy}
            className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-5 py-2.5 disabled:opacity-50 transition-colors cursor-pointer shadow-sm">
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M14 10l7-7M9 21H3v-6M10 14l-7 7" /></svg>
            {claimBusy ? 'Taking over…' : 'Take Over'}
          </button>
        </div>
      </div>
    )}

    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">

      {/* ── Back link ── */}
      <button onClick={() => router.push('/fba')} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors cursor-pointer">
        <Icon.ArrowLeft className="w-4 h-4" /> Back to Listing Optimizer
      </button>

      {/* ══════════════════════════════════════════════════════════════════════
          HEADER — Product info + Score
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row gap-5">
          {/* Image */}
          <div className="flex-shrink-0 w-20 h-20 bg-slate-100 rounded-2xl overflow-hidden ring-1 ring-slate-200 flex items-center justify-center">
            {displayImage ? (
              <img src={displayImage} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg viewBox="0 0 24 24" className="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
            )}
          </div>

          {/* Title + meta chips */}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-slate-900 leading-snug line-clamp-2">{headerTitle || asin}</h1>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="font-mono text-[11px] text-slate-600 bg-slate-100 rounded-md px-2 py-0.5">{asin}</span>
              <span className="text-[11px] font-medium text-slate-600 bg-slate-100 rounded-md px-2 py-0.5">{score.child_count} variant{score.child_count !== 1 ? 's' : ''}</span>
              <span className="text-[11px] font-medium text-slate-600 bg-slate-100 rounded-md px-2 py-0.5">{score.total_units_30d.toLocaleString()} units / 30d</span>
            </div>
          </div>

          {/* Overall score ring */}
          <div className="flex-shrink-0 flex flex-row sm:flex-col items-center justify-center gap-2 sm:gap-1">
            <ScoreRing score={score.overall_score} />
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Listing score</span>
          </div>
        </div>

        {/* Primary actions */}
        <div className="flex flex-wrap items-center gap-2 mt-5 pt-4 border-t border-slate-100">
          <a href={`https://sellercentral.amazon.com/abis/listing/edit?asin=${asin}&ref_=xx_addlisting_dnav_xx`}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors cursor-pointer">
            <Icon.External className="w-3.5 h-3.5" /> Edit in Seller Central
          </a>
          {/* Branch on whether A+ actually exists: /edit?asin= lands on an EMPTY editor for a listing
              with no A+ (reads as broken) — send those to /content-manager (the create surface, the
              same URL used on the dashboard + in the audit issue copy). */}
          <a href={score.aplus_score > 0
              ? `https://sellercentral.amazon.com/enhanced-content/edit?asin=${asin}`
              : `https://sellercentral.amazon.com/enhanced-content/content-manager`}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg px-3 py-2 transition-colors cursor-pointer">
            <Icon.External className="w-3.5 h-3.5" /> {score.aplus_score > 0 ? 'Edit A+ Content' : 'Create A+ Content'}
          </a>
          {/* PR #195 — seller-declared audience lean. Persisted on the score row; the next
              Regenerate reads it: re-weights gendered keywords across every pool and sets the
              title tail ("for Women" / "for Men and Women"). The seller knows the design's
              audience better than keyword statistics (Darlin' reads female). */}
          <select
            value={score?.audience_lean ?? ''}
            onChange={async (e) => {
              const v = e.target.value || null
              const prev = score?.audience_lean ?? null
              setScore((s) => (s ? { ...s, audience_lean: v } : s))
              try {
                const resp = await fetch('/api/fba/audience-lean', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ parent_asin: asin, audience_lean: v }),
                })
                const data = await resp.json()
                if (!resp.ok) throw new Error(data.error || 'Save failed')
              } catch (err) {
                setScore((s) => (s ? { ...s, audience_lean: prev } : s))
                setAiError({ kind: 'transient', message: err instanceof Error ? err.message : 'Failed to save audience' })
              }
            }}
            title="Who is this design for? Influences the ENTIRE next audit: gendered keywords are boosted/demoted across title, bullets, description and backend, and the title ends with the matching audience. Lean = unisex listing weighted toward that audience; Male/Female = narrow the title outright."
            className="ml-auto text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 rounded-lg px-2 py-2 cursor-pointer">
            <option value="">Audience: Auto</option>
            <option value="unisex">Unisex</option>
            <option value="lean_female">Lean Female</option>
            <option value="lean_male">Lean Male</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
          <button
            onClick={() => generateAiRecs()}
            disabled={aiLoading}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-4 py-2 disabled:opacity-50 transition-colors cursor-pointer shadow-sm shadow-violet-200">
            <Icon.Sparkles className="w-3.5 h-3.5" /> {aiLoading ? 'Generating…' : aiRecs ? 'Regenerate AI Audit' : 'Run AI Audit'}
          </button>
        </div>

        {/* ══ COLLABORATION BAR (Phase B → auto-lock) ════════════════════════════
            Auto-claims on page load. Shows green "You're editing" when I hold it,
            or a small amber chip when someone else has it (the dark overlay below
            blocks interaction). No manual "Claim" button — opening = claiming. */}
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-slate-100">
          {iHoldClaim ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
                You&rsquo;re editing{claim?.claimed_at ? ` · since ${relDate(claim.claimed_at)}` : ''}
              </span>
              <button
                onClick={doRelease}
                disabled={claimBusy}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 rounded-lg px-3 py-2 disabled:opacity-50 transition-colors cursor-pointer">
                {claimBusy ? 'Releasing…' : 'Release'}
              </button>
            </>
          ) : claim && !claim.stale ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
              {claim.claimed_by_name || 'Someone'} is editing{claim.last_heartbeat ? ` · active ${relDate(claim.last_heartbeat)}` : ''}
            </span>
          ) : null}
        </div>
        {claimError && <p className="text-xs text-red-600 mt-2">{claimError}</p>}

        {/* Kind-keyed AI failure banner (2026-07-08): quota/auth = red + actionable (no Retry — it
            can't help until billing/key is fixed); degraded/transient = amber WITH Retry. Replaces
            the one-line red text the PO could miss ("why doesn't the system let me know?"). */}
        {aiError && (
          <div className={`mt-3 rounded-xl border-l-4 p-3 ${aiError.kind === 'quota' || aiError.kind === 'auth' ? 'border-red-500 bg-red-50' : 'border-amber-500 bg-amber-50'}`}>
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 24 24" className={`w-4 h-4 mt-0.5 shrink-0 ${aiError.kind === 'quota' || aiError.kind === 'auth' ? 'text-red-600' : 'text-amber-600'}`} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              <div className="min-w-0">
                <p className={`text-xs font-bold ${aiError.kind === 'quota' || aiError.kind === 'auth' ? 'text-red-800' : 'text-amber-800'}`}>
                  {aiError.kind === 'quota' ? 'AI credit exhausted' : aiError.kind === 'auth' ? 'AI key rejected' : aiError.kind === 'degraded' ? 'AI output degraded — content preserved' : 'AI generation failed'}
                </p>
                <p className={`text-xs mt-0.5 ${aiError.kind === 'quota' || aiError.kind === 'auth' ? 'text-red-700' : 'text-amber-700'}`}>{aiError.message}</p>
                {aiError.kind !== 'quota' && aiError.kind !== 'auth' && (
                  <button onClick={() => generateAiRecs(aiError.section)} disabled={aiLoading}
                    className="mt-1.5 text-xs font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg px-3 py-1 transition-colors cursor-pointer disabled:opacity-50">
                    Retry
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {aiWarning && !aiError && (
          <div className="mt-3 rounded-xl border-l-4 border-amber-500 bg-amber-50 p-3">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 24 24" className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              <div className="min-w-0">
                <p className="text-xs font-bold text-amber-800">{aiWarning.kind === 'quota' ? 'OpenAI credit warning' : 'Partial AI degradation'}</p>
                <p className="text-xs mt-0.5 text-amber-700">{aiWarning.message}</p>
              </div>
            </div>
          </div>
        )}
        {aiRecs?.generated_at && !aiLoading && (
          <p className="text-xs text-slate-600 mt-2 font-medium" title={new Date(aiRecs.generated_at).toLocaleString()}>
            Last AI audit: <span className="font-semibold text-slate-800">{relDate(aiRecs.generated_at)}</span>
            <span className="text-slate-400 font-normal"> · {new Date(aiRecs.generated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </p>
        )}

        {/* Competitor ASIN input for reverse keyword lookup */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-slate-500 whitespace-nowrap">Competitor ASIN</label>
          <input
            type="text"
            value={competitorAsin}
            onChange={(e) => setCompetitorAsin(e.target.value.toUpperCase())}
            placeholder="B0XXXXXXXXX"
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 w-36 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-400 transition-shadow"
            maxLength={10}
          />
          <button
            onClick={saveCompetitorAsin}
            disabled={competitorSaving || !competitorAsin || competitorAsin.length !== 10}
            className="text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors cursor-pointer">
            {competitorSaving ? 'Saving…' : 'Save'}
          </button>
          <span className="text-[11px] text-slate-400">Used for Jungle Scout lookup when your ASIN has no data</span>
        </div>

        {/* DESIGN NAME OVERRIDE (PO 2026-06-14: "how do we prevent stuck design again") — when set,
            the regen uses this VERBATIM as the design anchor; bypasses LLM/vision/heuristic entirely.
            Highest-leverage deterministic control for POD families where the printed artwork's
            slogan differs from the listing title text. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-slate-500 whitespace-nowrap">Design Name</label>
          <input
            type="text"
            value={designNameOverride}
            onChange={(e) => setDesignNameOverride(e.target.value)}
            placeholder="(auto-detect — only override if regen picks the wrong slogan)"
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 w-80 focus:outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-400 transition-shadow"
            maxLength={80}
          />
          <button
            onClick={saveDesignNameOverride}
            disabled={designOverrideSaving}
            className="text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors cursor-pointer">
            {designOverrideSaving ? 'Saving…' : 'Save'}
          </button>
          <span className="text-[11px] text-slate-400">
            {designOverrideSavedAt && Date.now() - designOverrideSavedAt < 5000
              ? 'Saved — regenerate to use it'
              : 'Locks the design phrase so the title agent can\'t pick a slogan-like keyword from the pool'}
          </span>
        </div>

        {/* GOLD-TITLE LOCK — the discoverable "lock my title" control. Stores the seller's EXACT title as
            the authority (title_source='manual') so an AI Audit/Regenerate never rewrites it, with NO
            Amazon push. Fixes the modal-seeds-the-AI-title trap that buried the seller's title on B0FRYMM56C. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-slate-500 whitespace-nowrap">
            {aiRecs?.title_source === 'manual' ? '🔒 Locked Title' : '🔓 Lock Title'}
          </label>
          <input
            type="text"
            value={titleLockInput}
            onChange={(e) => { setTitleLockInput(e.target.value); setTitleLockTouched(true) }}
            placeholder="Your exact title — locked from AI rewrites"
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 flex-1 min-w-[20rem] focus:outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-400 transition-shadow"
            maxLength={200}
          />
          <span className={`text-[10px] ${titleLockInput.trim().length > 75 ? 'text-amber-600' : 'text-slate-400'}`}>{titleLockInput.trim().length}/75</span>
          <button
            onClick={() => saveTitleLock('lock')}
            disabled={titleLockSaving || !titleLockInput.trim()}
            className="text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors cursor-pointer">
            {titleLockSaving ? 'Saving…' : '🔒 Lock this title'}
          </button>
          {aiRecs?.title_source === 'manual' && (
            <button
              onClick={() => saveTitleLock('unlock')}
              disabled={titleLockSaving}
              className="text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors cursor-pointer">
              Unlock
            </button>
          )}
          <span className="text-[11px] text-slate-400">
            {aiRecs?.title_source === 'manual'
              ? 'Locked — an AI Audit or Regenerate keeps this exact title. Unlock to let AI rewrite it.'
              : 'Locks your exact title so an AI Audit or Regenerate cannot replace it (no Amazon push).'}
          </span>
        </div>

        {/* MULTI-DESIGN CLASSIFICATION OVERRIDE (migration 041) — lets the seller force single or
            multi-design when the auto-detection (SKU structure) gets it wrong (e.g. BC3001 Bella Canvas). */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-slate-500 whitespace-nowrap">Design Mode</label>
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
            {([
              { value: null, label: 'Auto' },
              { value: false, label: 'Single Design' },
              { value: true, label: 'Multi Design' },
            ] as { value: boolean | null; label: string }[]).map((opt) => (
              <button
                key={String(opt.value)}
                onClick={async () => {
                  const prev = isMultiDesignOverride
                  setIsMultiDesignOverride(opt.value)
                  try {
                    const resp = await fetch('/api/fba/design-name-override', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ parentAsin: asin, isMultiDesignOverride: opt.value }),
                    })
                    if (!resp.ok) setIsMultiDesignOverride(prev)
                  } catch { setIsMultiDesignOverride(prev) }
                }}
                className={`text-xs font-medium px-3 py-1.5 transition-colors cursor-pointer ${
                  isMultiDesignOverride === opt.value
                    ? 'bg-violet-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400">
            {isMultiDesignOverride === null ? 'Detected from SKU structure' : isMultiDesignOverride ? 'Forced: multiple designs per family' : 'Forced: one design for all variants'}
            {' — regenerate to apply'}
          </span>
        </div>
      </div>

      {/* ══ ORPHAN / REPARENTED — split by severity ══
          Orphan: truly disconnected (no parent on Amazon) → Re-link button (writes via SP-API).
          Re-parented: child IS linked, just to a DIFFERENT parent than we have stored. Offering
          a Re-link here would MOVE the child away from its real family, which is wrong. Show
          as "your data is stale" with a low-key "Move to this parent" only if you really meant it. */}
      {orphans && orphans.children.some((c) => c.status === 'orphan') && (() => { const trueOrphans = orphans.children.filter((c) => c.status === 'orphan'); return (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl shadow-sm p-4 flex items-start gap-3">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900">{trueOrphans.length} variant{trueOrphans.length === 1 ? '' : 's'} disconnected from this parent</p>
            <p className="text-xs text-amber-800 mt-0.5">Stored under this parent, but Amazon has no parent link for them — pooled reviews &amp; ranking are lost. Click <b>Re-link</b> to write the variation relationship back to Amazon.</p>
            <ul className="mt-2 space-y-1">
              {trueOrphans.map((c) => (
                <li key={c.asin} className="text-xs text-amber-900 flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{c.asin}</span>
                  <span className="text-amber-700">({c.sku})</span>
                  <span className="text-amber-900">— no parent link on Amazon</span>
                  {renderRelinkAction(c, undefined, 'amber')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )})()}

      {/* Re-parented — if MOST/ALL children live under the same OTHER parent on Amazon, we have
          the WRONG parent open. Show a clear "you opened the wrong page" prompt that links to the
          right one instead of a vague "Move to this parent" suggestion that's almost always wrong. */}
      {orphans && (() => {
        const reparented = orphans.children.filter((c) => c.status === 'reparented')
        if (reparented.length === 0) return null
        // If a single live parent dominates (≥1 child and ≥half of all detected reparented rows),
        // assume our portal opened the wrong family — point the seller there.
        const counts = new Map<string, number>()
        for (const c of reparented) if (c.liveParent) counts.set(c.liveParent, (counts.get(c.liveParent) ?? 0) + 1)
        const dominantEntry = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
        const dominantParent = dominantEntry?.[0]
        const dominantCount = dominantEntry?.[1] ?? 0
        const looksLikeWrongParent = !!dominantParent && dominantCount >= Math.max(1, Math.ceil(reparented.length / 2))
        return (
          <div className="bg-sky-50 border border-sky-200 rounded-2xl shadow-sm p-4 flex items-start gap-3">
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-sky-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
            <div className="min-w-0 flex-1">
              {looksLikeWrongParent ? (
                <>
                  <p className="text-sm font-semibold text-sky-900">You may have the wrong parent open</p>
                  <p className="text-xs text-sky-800 mt-0.5">
                    On Amazon, these variants live under <span className="font-mono font-semibold">{dominantParent}</span> — that&apos;s likely the real current family.
                    This page (<span className="font-mono">{asin}</span>) is probably a stale grouping in our records.
                  </p>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <button onClick={() => router.push(`/fba/listing/${dominantParent}`)} className="inline-flex items-center gap-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white px-3 py-1.5 rounded-lg transition-colors cursor-pointer">
                      Open {dominantParent}
                    </button>
                    <span className="text-[11px] text-sky-700">Then re-run <b>Sync Now</b> to refresh our records.</span>
                  </div>
                  <details className="mt-2">
                    <summary className="text-[11px] text-sky-700 cursor-pointer hover:underline">show details</summary>
                    <ul className="mt-1 space-y-0.5">
                      {reparented.map((c) => (
                        <li key={c.sku} className="text-[11px] text-sky-900">
                          <span className="font-mono">{c.asin}</span> <span className="text-sky-700">({c.sku})</span> → <span className="font-mono">{c.liveParent}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-sky-900">{reparented.length} variant{reparented.length === 1 ? '' : 's'} live under a different parent on Amazon</p>
                  <p className="text-xs text-sky-800 mt-0.5">Re-run <b>Sync Now</b> to refresh our records. Only <b>Move to this parent</b> if you intend to move the child here.</p>
                  <ul className="mt-2 space-y-1">
                    {reparented.map((c) => (
                      <li key={c.sku} className="text-xs text-sky-900 flex items-center gap-2 flex-wrap">
                        <span className="font-mono">{c.asin}</span>
                        <span className="text-sky-700">({c.sku})</span>
                        <span className="text-sky-900">— linked to <span className="font-mono">{c.liveParent}</span></span>
                        {renderRelinkAction(c, undefined, 'sky')}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* ══ RELATED ORPHANS — orphan SKUs that share this family's SKU prefix and could be linked HERE ══ */}
      {relatedOrphans && relatedOrphans.candidates.length > 0 && (
        <div className="bg-violet-50 border border-violet-200 rounded-2xl shadow-sm p-4 flex items-start gap-3">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-violet-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path d="M12 7v6l3 2" /></svg>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-violet-900">{relatedOrphans.candidates.length} orphan{relatedOrphans.candidates.length === 1 ? '' : 's'} could be linked to this family</p>
            <p className="text-xs text-violet-800 mt-0.5">
              These SKUs share the <span className="font-mono">{relatedOrphans.prefix}</span> prefix and have <b>no parent on Amazon</b>. Re-link them here {relatedOrphans.parent_sku ? <>(target parent SKU: <span className="font-mono">{relatedOrphans.parent_sku}</span>) </> : null}to restore pooled reviews &amp; ranking.
            </p>
            <ul className="mt-2 space-y-1">
              {relatedOrphans.candidates.map((c) => (
                <li key={c.sku} className="text-xs text-violet-900 flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{c.asin}</span>
                  <span className="text-violet-700">({c.sku})</span>
                  <span className="text-violet-900">— no parent link on Amazon</span>
                  {renderRelinkAction(c, relatedOrphans.parent_sku ?? undefined, 'violet')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ══ WRONG CAPACITY ATTRIBUTE — a child's live capacity disagrees with its SKU ══ */}
      {capacityCheck && capacityCheck.mismatchCount > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl shadow-sm p-4 flex items-start gap-3">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900">{capacityCheck.mismatchCount} variant{capacityCheck.mismatchCount === 1 ? '' : 's'} with wrong capacity attribute on Amazon</p>
            <p className="text-xs text-amber-800 mt-0.5">A child SKU encodes one capacity but Amazon stores another (e.g. a 32GB SKU listed as 128GB). Click <b>Fix</b> to write the correct value via SP-API — Amazon validates first, then accepts. <span className="font-medium">Heads-up:</span> changing a variation axis can re-validate the family.</p>
            <ul className="mt-2 space-y-1">
              {capacityCheck.children.filter((c) => c.mismatch).map((c) => (
                <li key={c.sku} className="text-xs text-amber-900 flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{c.asin}</span>
                  <span className="text-amber-700">({c.sku})</span>
                  <span className="text-amber-900">— live <span className="font-mono font-semibold">{c.liveLabel}</span> → should be <span className="font-mono font-semibold">{c.expectedLabel}</span></span>
                  <button onClick={() => openFixCap(c)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold bg-amber-700 hover:bg-amber-800 text-white px-2.5 py-1 rounded-md transition-colors cursor-pointer">
                    Fix
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ══ KPI ROW — the six sub-scores as their own cards ══ */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {bars.map(b => {
          const pct = Math.round((b.score / b.max) * 100)
          const tone = b.score / b.max >= 0.8 ? 'text-green-600' : b.score / b.max >= 0.6 ? 'text-amber-600' : 'text-red-600'
          return (
            <div key={b.label} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 transition-shadow hover:shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{b.label}</span>
                <span className={`text-[11px] font-bold ${tone}`}>{pct}%</span>
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold text-slate-900 tabular-nums">{b.score}</span>
                <span className="text-xs text-slate-400">/ {b.max}</span>
              </div>
              <div className="mt-2.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${barColor(b.score, b.max)}`} style={{ width: `${pct}%`, transition: 'width 600ms ease' }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* ══ TAB NAV — defined dashboard sections, one at a time (no infinite scroll) ══ */}
      {aiRecs && (
        <div className="flex items-center gap-1 overflow-x-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-1.5">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`relative inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors cursor-pointer ${activeTab === t.id ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}>
              {t.label}
              {t.count > 0 && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${activeTab === t.id ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{t.count}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Tab content — only the active section renders, so inactive ones add no gap */}
      <div>
      {/* No audit yet — single prompt (tab bar is hidden until an audit exists) */}
      {!aiRecs && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10 text-center">
          <p className="text-sm text-slate-500 mb-4">{aiLoading ? (aiProgress || 'Running AI audit…') : 'Run an AI audit to see the recommended changes for this listing.'}</p>
          {!aiLoading && (
            <button onClick={() => generateAiRecs()} className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-4 py-2 transition-colors cursor-pointer">
              <Icon.Sparkles className="w-3.5 h-3.5" /> Run AI Audit
            </button>
          )}
        </div>
      )}

      {/* Ship all confirmed core (element C): one button ships Title + Bullets + Description + Keywords
          together in a SINGLE PATCH per SKU (executeBulkCorePush), instead of four separate section
          pushes. The server drops the non-buyable variation parent + skips offerless SKUs, and each
          field still gets a full VALIDATION_PREVIEW. Gated by the shared concurrent-push guard. */}
      {aiRecs?.action_plan && aiRecs.action_plan.some((a) => ['title', 'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5', 'description', 'backend_keywords'].includes(a.element) && a.verdict !== 'DONE' && a.verdict !== 'SKIP') && (
        <div className="flex items-center justify-end mb-3">
          <button
            onClick={runCoreBulkPush}
            disabled={coreBulkRunning || pushLoading || bulkRunning}
            className="text-xs bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3.5 py-1.5 rounded-lg font-semibold whitespace-nowrap shadow-sm"
            title="Ship Title, Bullets, Description and Backend Keywords together — one PATCH per SKU. The non-buyable variation parent is skipped; each field still gets full Amazon validation."
          >
            {coreBulkRunning ? 'Shipping all core…' : 'Ship all confirmed core →'}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ACTION PLAN — Comprehensive listing review with verdicts
          ══════════════════════════════════════════════════════════════════════ */}
      {aiRecs?.action_plan && aiRecs.action_plan.length > 0 && (() => {
        // Calm, SaaS-style cards: white with a colored LEFT accent per verdict (no full-bleed fills).
        const verdictStyles: Record<string, string> = {
          REPLACE: 'border-l-red-400',
          EDIT: 'border-l-amber-400',
          CREATE: 'border-l-blue-400',
          DONE: 'border-l-green-400',
          SKIP: 'border-l-slate-300',
        }
        const verdictDot: Record<string, string> = {
          REPLACE: 'bg-red-500', EDIT: 'bg-amber-500', CREATE: 'bg-blue-500', DONE: 'bg-green-500', SKIP: 'bg-slate-400',
        }
        const priorityBadge: Record<string, string> = {
          HIGH: 'bg-red-100 text-red-700',
          MEDIUM: 'bg-amber-100 text-amber-700',
          LOW: 'bg-slate-100 text-slate-600',
          NONE: 'bg-green-100 text-green-700',
        }
        const recs = aiRecs!
        // One row per ASIN (FBA+FBM SKUs of the same ASIN collapse to one) so the page matches
        // the per-ASIN recommendations/push.
        const variants = dedupByAsin(score.children)
        // ── SKU-PRIMARY COUNTS (PO decision 2026-07-09) ──────────────────────────────────────────
        // The page showed "157 need update" / "79" / "Push to 157" / verify "182 applied" and none
        // agreed, because each surface silently counted a DIFFERENT unit. Ground rule: counts LEAD
        // with SKUs (an ASIN's FBA + FBM twins are two real Amazon writes) and name ASINs in parens
        // when they differ. `variants` stays ASIN-deduped for DISPLAY (one row per ASIN) — only the
        // printed numbers change.
        const skusByAsin = new Map<string, number>()
        for (const c of score.children) skusByAsin.set(c.asin, (skusByAsin.get(c.asin) ?? 0) + 1)
        const skuCountFor = (asin: string) => skusByAsin.get(asin) ?? 1
        const totalSkus = score.children.length
        const fmtCount = (skus: number, asins?: number) =>
          asins != null && asins !== skus
            ? `${skus} SKU${skus === 1 ? '' : 's'} (${asins} ASIN${asins === 1 ? '' : 's'})`
            : `${skus} SKU${skus === 1 ? '' : 's'}`
        // GUARANTEE a pushable card for every core field (title, bullets, description) from the
        // RECOMMENDATION — which always has this content — even when the stored action_plan omitted them.
        // The plan can arrive with only title+backend (a partial regen / stored-rec reuse skips the
        // pipeline's synth backstop), which is why Bullets/Description cards vanished on B0FRYMM56C. The
        // seller must ALWAYS be able to push what the optimizer generated, regardless of the audit's list.
        // SHIP-TRUTH (2026-07-09): the server GET/POST now DERIVES verdict / current_status /
        // replacement_content from live truth AND synthesizes any missing core card
        // (deriveActionPlan in pushFields). The #351 client synth below stays ONLY as a backstop
        // for a failed server derive (the GET catch serves the stored plan) — on a healthy serve
        // every core element is already present, so mkCard never fires.
        const rawParent = (recs.action_plan ?? []).filter(a => a.element !== 'backend_keywords')
        type PlanItem = (typeof rawParent)[number]
        const presentEls = new Set(rawParent.map(a => a.element))
        const mkCard = (element: string, content: string, label: string): PlanItem => ({
          element, level: 'parent', verdict: 'REPLACE', priority: 'HIGH',
          current_status: `Your live ${label} may differ from the recommended version below.`,
          instruction: `Replace your current ${label} with the recommended version below, then save in Seller Central.`,
          replacement_content: content,
          seller_central_path: 'Manage Inventory > Edit Listing',
        } as PlanItem)
        const synthParent: PlanItem[] = []
        if (!presentEls.has('title') && recs.recommended_title) synthParent.push(mkCard('title', recs.recommended_title, 'title'))
        if (!presentEls.has('bullets')) (recs.recommended_bullets ?? []).forEach((b, i) => {
          const el = `bullet_${i + 1}`
          if (!presentEls.has(el) && typeof b === 'string' && b.trim()) synthParent.push(mkCard(el, b, `bullet ${i + 1}`))
        })
        if (!presentEls.has('description') && recs.recommended_description) synthParent.push(mkCard('description', recs.recommended_description, 'description'))
        const cardOrder = (el: string) => el === 'title' ? 0 : /^bullet_(\d+)$/.test(el) ? 1 + Number(el.split('_')[1]) : el === 'description' ? 10 : 20
        const parentItems = [...rawParent, ...synthParent].sort((a, b) => cardOrder(String(a.element)) - cardOrder(String(b.element)))
        const backendItem = (recs.action_plan ?? []).find(a => a.element === 'backend_keywords')
        const recMap = new Map((recs.per_child_keywords ?? []).map(p => [p.sku, p.keywords]))
        const perChildRows = variants.map(c => {
          const recommended = (recMap.get(c.sku) ?? '').trim()
          const current = (c.backend_keywords ?? '').trim()
          // squashEquals (ship-truth 2026-07-09): the SAME comparator the server deriver + verify
          // use — byte-exact compare read "changed" on case/punctuation while the card said DONE.
          return { sku: c.sku, asin: c.asin, skus: skuCountFor(c.asin), current, recommended, changed: recommended !== '' && !squashEquals(current, recommended) }
        })
        // SKU-primary (2026-07-09): the rows are one-per-ASIN for display, but a changed ASIN means
        // its FBA+FBM twins BOTH get written — so the count the seller sees matches what ships.
        const needsUpdateAsins = perChildRows.filter(r => r.changed).length
        const needsUpdate = perChildRows.filter(r => r.changed).reduce((n, r) => n + r.skus, 0)
        // ── Per-field variant cohesion (client-side; "should-match" fields only) ──
        // Groups each child's CURRENT value to show whether the variants are consistent or split,
        // how many need updating, and which SKUs hold which version.
        const normV = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
        const fieldCohesion = (getCurrent: (c: ChildContentRow) => string | null | undefined, recommended: string, optimal: boolean, recFor?: (c: ChildContentRow) => string, perDesign?: boolean) => {
          const groups = new Map<string, string[]>()
          for (const c of variants) {
            const v = normV(getCurrent(c))
            if (!groups.has(v)) groups.set(v, [])
            groups.get(v)!.push(c.sku)
          }
          const versions = [...groups.entries()].map(([value, skus]) => ({ value, skus })).sort((a, b) => b.skus.length - a.skus.length)
          // When the section already scores MAX it's optimal — don't flag "N need update" against a
          // fresh AI draft that's never byte-identical (same reason the action item becomes DONE not
          // REPLACE). Keeps this row consistent with a 25/25 score instead of contradicting it.
          // recFor (capacity families): compare each child to ITS OWN per-child target (its own GB), not
          // one broadcast value — otherwise the divergent 128/32 GB titles read as "need update".
          // squashEquals for the COUNT (ship-truth 2026-07-09 — same comparator as the cards/verify);
          // the versions grouping above stays normV so visually-different casings still list separately.
          // Guarded on a non-empty recommendation (adversarial: squashEquals returns false on an empty
          // expected, which would count both-empty variants as "needs update").
          // PER-DESIGN fields skip the optimal short-circuit: a multi-design section can score title-optimal
          // (good title QUALITY) while its live titles still differ from the fresh per-design recommendations
          // (nothing shipped yet) — the byte-truth "N need update" must then show, matching the per-design
          // verify chip (derivedDesignStatus, which has no optimal gate). Capacity/broadcast fields keep the
          // optimal suppression so a 25/25 section isn't contradicted by a never-byte-identical fresh draft.
          const stale = (optimal && !perDesign) ? [] : variants.filter(c => {
            const recV = normV(recFor ? recFor(c) : recommended)
            return recV !== '' && !squashEquals(normV(getCurrent(c)), recV)
          })
          // SKU-primary: an ASIN needing an update means BOTH its FBA and FBM SKUs get written.
          const needUpdate = stale.reduce((n, c) => n + skuCountFor(c.asin), 0)
          const needUpdateAsins = stale.length
          return { versions, distinct: versions.length, needUpdate, needUpdateAsins, total: totalSkus, totalAsins: variants.length, recommended, optimal, perChild: !!recFor }
        }
        // Per-section RANK CONTEXT for the suggestions (integration A, increment 1b). Combines the rank
        // COVERAGE truth (rankData.rows: youCover + coveredIn) with the AI's PLACEMENT plan
        // (keyword_reconciliation: placed_in + action_type) so an UNCOVERED keyword maps to the section it
        // should go in (an uncovered keyword has empty coveredIn — placed_in is what fixes that). Honest +
        // bias-to-show: 'winnable' only for a genuinely-uncovered high-opp keyword planned for that section
        // (cross-checked against rank coverage so we never tag an already-covered term); 'done' only when the
        // section holds covered top keywords AND has none uncovered planned; otherwise null (no chip).
        const rankSectionChip: Record<'title' | 'bullets' | 'backend', 'winnable' | 'done' | null> = (() => {
          const out = { title: null, bullets: null, backend: null } as Record<'title' | 'bullets' | 'backend', 'winnable' | 'done' | null>
          if (!rankData?.analyzed || !Array.isArray(rankData.rows) || rankData.rows.length === 0) return out
          const norm = (p: string): 'title' | 'bullets' | 'backend' | null =>
            p === 'title' ? 'title' : /^bullet/.test(p) ? 'bullets' : (p === 'backend_keywords' || p === 'backend') ? 'backend' : null
          const nk = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()   // normalize case + whitespace; tolerates a missing keyword
          const coveredKw = new Set<string>()
          const covered = { title: false, bullets: false, backend: false }
          for (const r of rankData.rows) {
            if (!r.youCover) continue
            coveredKw.add(nk(r.keyword))
            for (const s of r.coveredIn ?? []) { const n = norm(s); if (n) covered[n] = true }
          }
          const winnable = { title: false, bullets: false, backend: false }
          for (const kr of aiRecs?.keyword_reconciliation ?? []) {
            if (kr.action_type !== 'CRITICAL' && kr.action_type !== 'UPGRADE') continue
            if (!kr.keyword || coveredKw.has(nk(kr.keyword))) continue   // missing keyword OR rank already covers it → not a content move
            for (const p of kr.placed_in ?? []) { const n = norm(p); if (n) winnable[n] = true }
          }
          for (const s of ['title', 'bullets', 'backend'] as const) out[s] = winnable[s] ? 'winnable' : covered[s] ? 'done' : null
          return out
        })()
        // ACTIONABLE RANK WORK-LIST (PO point #2: "rank was meant to provide actual actionable tasks the
        // portal can do," not beauty/information). Maps each genuinely-uncovered high-opportunity keyword to
        // the ONE portal action that closes it: SHIP the drafted section if the fresh AI draft ALREADY weaves
        // the keyword (token-coverage via the SAME predicate the scorer/generator use — R5, never .includes()),
        // else REGENERATE to get a draft that does. Honest: covered keywords never appear as "work".
        const rankWorkList: { section: 'title' | 'bullets' | 'backend'; label: string; keywords: string[]; drafted: boolean }[] = (() => {
          // Suppress the actionable work-list when the rank analysis is STALE (live content changed since it
          // ran) — otherwise it shows "Ship — draft already covers them" / "Regenerate" off outdated coverage
          // (PO saw it suggest re-shipping bullets just pushed). The banner's "re-check in Intelligence" is the
          // honest next step; the buttons return after a fresh analysis.
          if (!rankData?.analyzed || rankData.stale || !Array.isArray(rankData.rows) || rankData.rows.length === 0) return []
          const norm = (p: string): 'title' | 'bullets' | 'backend' | null =>
            p === 'title' ? 'title' : /^bullet/.test(p) ? 'bullets' : (p === 'backend_keywords' || p === 'backend') ? 'backend' : null
          const nk = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
          const coveredKw = new Set<string>()
          for (const r of rankData.rows) if (r.youCover) coveredKw.add(nk(r.keyword))
          const bySection: Record<'title' | 'bullets' | 'backend', Set<string>> = { title: new Set(), bullets: new Set(), backend: new Set() }
          for (const kr of aiRecs?.keyword_reconciliation ?? []) {
            if (kr.action_type !== 'CRITICAL' && kr.action_type !== 'UPGRADE') continue
            if (!kr.keyword || coveredKw.has(nk(kr.keyword))) continue   // missing keyword OR rank already covers it → not a task
            for (const p of kr.placed_in ?? []) { const n = norm(p); if (n) bySection[n].add(kr.keyword) }
          }
          // "drafted" must be judged against EXACTLY what a Ship writes live. Bullets ship the one broadcast
          // recommended_bullets. Title is the trap: for a capacity family the Ship distributes a DIFFERENT
          // per-child title per SKU, so it's only honest to claim "draft covers it" when EVERY child's title
          // covers the keyword — a capacity-specific term living in just one child's title would otherwise
          // falsely promise coverage for the other SKUs (adversarial-review finding). Backend is per-child with
          // no single broadcast draft to diff, so it always routes to Regenerate (drafted=false).
          const perChildTitles = recs.per_child_titles ?? []
          const titleCovers = (kws: string[]): boolean =>
            perChildTitles.length > 1
              ? perChildTitles.every((t) => missingBulletKeywords([t.title ?? ''], kws).length === 0)
              : (recs.recommended_title ?? '').trim().length > 0 && missingBulletKeywords([recs.recommended_title ?? ''], kws).length === 0
          const out: { section: 'title' | 'bullets' | 'backend'; label: string; keywords: string[]; drafted: boolean }[] = []
          // Backend-first (Step 3): a keyword the plan tagged for bullets may have been routed to backend
          // by the generator (Content step 2). Judge "drafted" against the FULL live-shippable draft —
          // title + bullets + backend (per-child) — so a keyword already indexed in the backend draft is
          // shippable, NOT a false "regenerate to weave it into the bullets" promise the pipeline undoes.
          const backendDraft = [recs.recommended_keywords ?? '', ...(recs.per_child_keywords ?? []).map((k) => k.keywords)].join(' ')
          const fullDraft = [recs.recommended_title ?? '', (recs.recommended_bullets ?? []).join(' '), backendDraft].join(' ')
          for (const sec of ['title', 'bullets', 'backend'] as const) {
            const kws = [...bySection[sec]]
            if (kws.length === 0) continue
            const drafted =
              sec === 'title' ? titleCovers(kws)
              : (fullDraft.trim().length > 0 && missingBulletKeywords([fullDraft], kws).length === 0)
            out.push({ section: sec, label: sec === 'title' ? 'Title' : sec === 'bullets' ? 'Bullets' : 'Backend keywords', keywords: kws, drafted })
          }
          return out
        })()
        // Chip never hides/disables Ship or Copy — it only reframes WHY the lever is shifting. Both labels +
        // tooltips are asserted honest in scripts/verify-rank-honesty.mjs (no rank over-promise).
        const rankChip = (v: 'winnable' | 'done' | null) =>
          v === 'winnable'
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 flex-shrink-0 hidden sm:inline" title="High-opportunity keyword(s) to add here — this is where content can still move you.">Content-winnable</span>
            : v === 'done'
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 flex-shrink-0 hidden sm:inline" title="Top keywords already covered here — rank now depends on reviews, price, and sales velocity, not more copy.">Content done here</span>
              : null

        // PER-CHILD families (capacity OR multi-design): title/bullets/description are NOT one broadcast
        // "should match" value — each SKU keeps its own (capacity = its GB; multi-design = its design's
        // copy). Compare each child to ITS OWN per-child target via the SAME resolver the ship engine uses
        // (perChildValueResolver mirrors pushFields.resolveProposed's per_child preference, incl. the ASIN
        // fallback for FBM twins). Single-design families → resolver null → recFor undefined → the exact
        // old broadcast behavior. This is the display/count fix that stops "41 need update / all identical"
        // on a multi-design family and makes the COHESION panel agree with the ship + PER-DESIGN cards.
        const titleResolve = perChildValueResolver(recs.per_child_titles, t => t.title)
        const bulletsResolve = perChildValueResolver(recs.per_child_bullets, b => (b.bullets ?? []).filter(Boolean).join('\n'))
        const descResolve = perChildValueResolver(recs.per_child_descriptions, d => d.description)
        const mkRecFor = (resolve: ((sku: string, asin?: string | null) => string | undefined) | null, broadcast: string): ((c: ChildContentRow) => string) | undefined =>
          resolve ? (c) => resolve(c.sku, c.asin) ?? broadcast : undefined
        // perDesign is PER-FIELD: multi-design AND this field actually has per-design data (resolver non-null).
        // Coupling to the resolver keeps the chip, body, count, EDIT-ONCE label, and ship engine all consistent
        // even when a field's per-design fan-out didn't populate (e.g. titles fanned out but bullets/desc absent).
        const titlePerDesign = multiDesign && !!titleResolve
        const bulletsPerDesign = multiDesign && !!bulletsResolve
        const descPerDesign = multiDesign && !!descResolve
        const cohFields = [
          { key: 'title', label: 'Title', perDesign: titlePerDesign, coh: fieldCohesion(c => stripVariantSuffix(c.title), recs.recommended_title, score.title_score >= 23, mkRecFor(titleResolve, recs.recommended_title), titlePerDesign), copyVal: recs.recommended_title, perChildEntries: titleResolve ? perDesignEntries(recs.per_child_titles, t => t.title) : null },
          { key: 'bullets', label: 'Bullets', perDesign: bulletsPerDesign, coh: fieldCohesion(c => [c.bullet_1, c.bullet_2, c.bullet_3, c.bullet_4, c.bullet_5].filter(Boolean).join('\n'), (recs.recommended_bullets ?? []).join('\n'), score.bullet_score >= 23, mkRecFor(bulletsResolve, (recs.recommended_bullets ?? []).join('\n')), bulletsPerDesign), copyVal: (recs.recommended_bullets ?? []).join('\n'), perChildEntries: bulletsResolve ? perDesignEntries(recs.per_child_bullets, b => (b.bullets ?? []).filter(Boolean).join('\n')) : null },
          { key: 'description', label: 'Description', perDesign: descPerDesign, coh: fieldCohesion(c => c.description, recs.recommended_description, (score.description_score ?? 0) >= 23, mkRecFor(descResolve, recs.recommended_description), descPerDesign), copyVal: recs.recommended_description, perChildEntries: descResolve ? perDesignEntries(recs.per_child_descriptions, d => d.description) : null },
        ]
        return (
        <section>
          {activeTab === 'apply' && (
            <div className="space-y-6">
              {/* ── PER-DESIGN CONTENT — one editable, collapsible card per design for multi-design
                  apparel families (each design has its own title/bullets/description, today stored
                  but invisible). Gated on multiDesign (>=2 distinct designKeys); single-design /
                  capacity / non-apparel families never render this and keep the old UI verbatim.
                  Save/Ship/Verify are stubbed here — PR-C wires the persistence + pushes. ── */}
              {multiDesign && designGroups.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Icon.Layers className="w-4 h-4 text-violet-600" />
                    <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide">Per-Design Content</h3>
                    <span className="text-[10px] text-slate-500">{designGroups.length} designs in this family — each gets its own title, bullets &amp; description</span>
                  </div>
                  {designGroups.map((g) => (
                    <PerDesignCard
                      key={g.designKey}
                      group={g}
                      fallbackBullets={aiRecs?.recommended_bullets ?? []}
                      fallbackDescription={aiRecs?.recommended_description ?? ''}
                      expanded={expandedSections.has('design-' + g.designKey)}
                      onToggle={() => toggle('design-' + g.designKey)}
                      edit={designEdits[g.designKey]}
                      dirty={designDirty(g.designKey)}
                      busy={!!designBusy[g.designKey]}
                      status={designVerifyStatus[g.designKey] ?? derivedDesignStatus[g.designKey] ?? 'unknown'}
                      onEditTitle={(v) => onEditDesignTitle(g.designKey, v)}
                      onEditBullet={(i, v) => onEditDesignBullet(g.designKey, i, v)}
                      onEditDescription={(v) => onEditDesignDescription(g.designKey, v)}
                      onSave={() => onSaveDesign(g)}
                      onShipField={(field) => onShipDesignField(g, field)}
                      onVerify={() => onVerifyDesign(g)}
                      onRenameDesign={onRenameDesign}
                    />
                  ))}
                </div>
              )}
              {/* ── RANK VERDICT — honest "what content can/can't do for rank" atop the suggestions.
                  Renders ONLY server-authored, validator-clamped strings from /api/fba/rank-analysis
                  (verdict.*). Full playbook + competitor analysis stays in the Intelligence tab. ── */}
              {rankData?.analyzed && rankData.verdict && (
                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden border-l-4 border-l-violet-500">
                  <button onClick={() => toggle('rank-verdict')} className="w-full flex items-start gap-2 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">Rank Top of Amazon</span>
                        <span className="text-[10px] bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full">{rankData.verdict.indexedCoverage}</span>
                        {rankData.verdict.criticalGaps > 0 && <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{rankData.verdict.criticalGaps} high-opportunity gap{rankData.verdict.criticalGaps === 1 ? '' : 's'}</span>}
                        {rankData.stale && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); void refreshRankFree() }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); void refreshRankFree() } }}
                            title="Your content changed since this analysis ran. Re-checks keyword coverage now — free, no credits."
                            className={`text-[10px] px-2 py-0.5 rounded-full cursor-pointer ${rankRefreshing ? 'bg-violet-100 text-violet-700 animate-pulse' : 'bg-amber-100 text-amber-700 hover:bg-amber-200 underline decoration-dotted underline-offset-2'}`}
                          >
                            {rankRefreshing ? 'Re-checking coverage…' : 'Content changed — Re-check now (free)'}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-800 mt-1">{rankData.verdict.headline}</p>
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">{expandedSections.has('rank-verdict') ? '▾' : '▸'}</span>
                  </button>
                  {expandedSections.has('rank-verdict') && (
                    <div className="px-4 pb-3 pt-1 bg-slate-50/60 border-t border-slate-100">
                      <div className="grid sm:grid-cols-2 gap-3 mt-2">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">Close these gaps — do it here</p>
                          {rankWorkList.length > 0 ? (
                            <ul className="space-y-2">
                              {rankWorkList.map((w) => (
                                <li key={w.section} className="text-[11px] text-slate-700">
                                  <div className="flex gap-1.5">
                                    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                    <span className="min-w-0"><span className="font-semibold">{w.label}</span> — add {w.keywords.slice(0, 3).map((k) => `“${k}”`).join(', ')}{w.keywords.length > 3 ? ` +${w.keywords.length - 3} more` : ''}</span>
                                  </div>
                                  <div className="mt-1 ml-5">
                                    {(() => {
                                      // Backend-first (Step 3): the backend row can SHIP (its PushField is 'keywords'),
                                      // and the regenerate verb is "index" — backend is indexed, not woven into prose.
                                      const pushField = (w.section === 'backend' ? 'keywords' : w.section) as PushField
                                      const verb = w.section === 'backend' ? 'index' : 'weave'
                                      const home = w.section === 'backend' ? 'the backend keywords' : `the ${w.label.toLowerCase()}`
                                      return w.drafted ? (
                                        <button onClick={() => openPushPreview(pushField)} disabled={pushLoading}
                                          title={`The fresh AI draft already carries ${w.keywords.length === 1 ? 'this keyword' : 'these keywords'} — ship it live to close the gap.`}
                                          className="inline-flex items-center gap-1 text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded font-semibold disabled:opacity-50 transition-colors cursor-pointer">
                                          <Icon.Send className="w-3 h-3" /> Ship {w.label.toLowerCase()} — draft already covers {w.keywords.length === 1 ? 'it' : 'them'}
                                        </button>
                                      ) : (
                                        <button onClick={() => generateAiRecs()} disabled={aiLoading}
                                          title={`The current draft doesn’t cover ${w.keywords.length === 1 ? 'this keyword' : 'these keywords'} yet — regenerate to ${verb} ${w.keywords.length === 1 ? 'it' : 'them'} into ${home}.`}
                                          className="inline-flex items-center gap-1 text-[10px] bg-violet-600 hover:bg-violet-700 text-white px-2 py-1 rounded font-semibold disabled:opacity-50 transition-colors cursor-pointer">
                                          <Icon.Sparkles className="w-3 h-3" /> Regenerate to {verb} {w.keywords.length === 1 ? 'it' : 'them'} in
                                        </button>
                                      )
                                    })()}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <>
                              {/* The chip says "N high-opportunity gaps" — NAME them here even when the
                                  actionable work-list is suppressed (stale analysis), so the banner is
                                  never a dead-end (PO: "doesn't tell me what the 1 gap IS"). */}
                              {(() => {
                                const gapNames = (rankData.rows ?? []).filter((r) => !r.youCover).map((r) => r.keyword)
                                if (gapNames.length === 0) return null
                                return (
                                  <div className="mb-2 bg-red-50/60 border border-red-100 rounded-lg p-2">
                                    <p className="text-[11px] text-slate-800">
                                      <span className="font-semibold">Gap keyword{gapNames.length === 1 ? '' : 's'}{rankData.stale ? ' (as of last check)' : ''}:</span>{' '}
                                      {gapNames.slice(0, 5).map((k) => `“${k}”`).join(', ')}{gapNames.length > 5 ? ` +${gapNames.length - 5} more` : ''}
                                    </p>
                                    {rankData.stale && (
                                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                        <button
                                          onClick={() => void refreshRankFree()}
                                          disabled={rankRefreshing}
                                          className="text-[10px] bg-amber-500 hover:bg-amber-600 text-white px-2.5 py-1 rounded font-semibold disabled:opacity-50"
                                          title="Recomputes keyword coverage against your CURRENT content — free, no credits. The one-click Ship/Regenerate actions for each gap return right after."
                                        >
                                          {rankRefreshing ? 'Re-checking…' : 'Re-check now (free)'}
                                        </button>
                                        <span className="text-[10px] text-slate-500">Your content changed since this ran — re-check to refresh coverage and unlock the one-click Ship/Regenerate actions per gap.</span>
                                      </div>
                                    )}
                                  </div>
                                )
                              })()}
                              <ul className="space-y-1">
                                {(rankData.verdict.contentCanDo ?? []).map((c, i) => (
                                  <li key={i} className="flex gap-1.5 text-[11px] text-slate-700">
                                    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>{c}
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Content CAN&apos;T do (needs other levers)</p>
                          <ul className="space-y-1">
                            {(rankData.verdict.contentCannotDo ?? []).map((c, i) => (
                              <li key={i} className="flex gap-1.5 text-[11px] text-slate-600">
                                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>{c}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <p className="text-[11px] italic text-slate-500 mt-2">{rankData.verdict.honestNote}</p>
                      <p className="text-[10px] text-slate-400 mt-1">Full keyword playbook + competitor analysis in the <span className="font-medium">Intelligence</span> tab.</p>
                    </div>
                  )}
                </div>
              )}
              {/* SELF-HEAL banner (live-notice): a kind='heal' task is pending/running — the system is
                  auto-inheriting the parent hub's missing values from a live child. Rendered as its OWN
                  banner (not folded into the verify banner below) so an actionable needs_attention is
                  never hidden behind it; its whole point is "do not re-push while this runs" (a re-push
                  can't speed it up — the active-task guard just skips the re-enqueue). */}
              {verifyQueue.healing > 0 && (() => {
                const healTask = verifyQueue.tasks.find((t) => t.kind === 'heal' && (t.status === 'pending' || t.status === 'running'))
                const attrs = (healTask?.heal_payload?.missingAttrKeys ?? []).join(', ')
                const eta = healTask?.next_check_at ? new Date(healTask.next_check_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
                return (
                  <div className="rounded-lg p-2.5 mb-3 text-[11px] flex items-center gap-2 bg-violet-50 border border-violet-200 text-violet-900">
                    <span className="font-semibold">🩹 Self-heal in progress</span>
                    <span>- the variation parent hub is missing {attrs || 'required attribute values'}; the system will inherit the values from a live child automatically.{eta ? <> Next attempt ~<b>{eta}</b>.</> : null} No action needed - re-pushing won&apos;t speed it up.</span>
                  </div>
                )
              })()}
              {/* AUTO-VERIFY banner: shows when the cron is watching pushes for this listing
                  (PO directive 2026-06-13: "shipping verification should be an automatic cron").
                  Pending = a verify is scheduled (heal tasks are counted separately above);
                  needs_attention = the cron tried max_attempts and SKUs are still stale — the
                  seller should look (a heal:manual task carries its own seller-facing last_error). */}
              {(verifyQueue.pending > 0 || verifyQueue.needs_attention > 0) && (
                <div className={`rounded-lg p-2.5 mb-3 text-[11px] flex items-center gap-2 ${verifyQueue.needs_attention > 0 ? 'bg-amber-50 border border-amber-200 text-amber-900' : 'bg-emerald-50 border border-emerald-200 text-emerald-900'}`}>
                  {verifyQueue.needs_attention > 0 ? (
                    <>
                      <span className="font-semibold">⚠ {verifyQueue.needs_attention} push{verifyQueue.needs_attention === 1 ? '' : 'es'} need your attention</span>
                      {(() => {
                        // A heal:manual row carries its own seller-facing message ("Parent hub needs
                        // ... Complete it in Seller Central") — show it verbatim; same for a
                        // heal:family-check row ("family integrity changed after complete-write heal
                        // ..." — adversarial review 2026-07-02, fix 3). The generic stale-SKU
                        // guidance still renders when any NON-heal task also needs attention.
                        const manualHeal = verifyQueue.tasks.find((t) => (t.field === 'heal:manual' || t.field === 'heal:family-check') && t.status === 'needs_attention' && t.last_error)
                        const hasVerifyAttention = verifyQueue.tasks.some((t) => t.status === 'needs_attention' && t.field !== 'heal:manual' && t.field !== 'heal:family-check')
                        return (
                          <>
                            {manualHeal && <span>— {manualHeal.last_error}</span>}
                            {(hasVerifyAttention || !manualHeal) && <span>— the auto-verify cron tried multiple times and some SKUs are still stale on Amazon. Click <b>Verify live</b> on the affected field to see which SKUs and re-push manually.</span>}
                          </>
                        )
                      })()}
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">✓ {verifyQueue.pending} push{verifyQueue.pending === 1 ? '' : 'es'} being auto-verified</span>
                      <span>— the cron will re-check live on Amazon ~20 min after each push and re-push any stale SKUs automatically until 100% applied. No action needed.</span>
                    </>
                  )}
                </div>
              )}
              {/* ── VARIANT COHESION — how the variants compare per field ── */}
              <div className="border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-baseline gap-2">
                  <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">Variant Cohesion</span>
                  <span className="text-[11px] text-slate-400">how your {variants.length} variants compare today</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {cohFields.map(f => {
                    const split = f.coh.distinct > 1
                    const open = expandedSections.has(`coh-${f.key}`)
                    return (
                      <div key={f.key}>
                        {/* Header is a flex row (not a single button) so the always-present "Verify live"
                            button isn't nested inside the toggle — PO: needs Verify on EVERY field incl.
                            up-to-date ones, to confirm Amazon applied it and re-push stragglers. */}
                        <div className="w-full flex items-center gap-2 px-4 py-2 hover:bg-slate-50 transition-colors">
                          <button onClick={() => toggle(`coh-${f.key}`)} className="flex items-center gap-2 text-left flex-1 min-w-0">
                            <span className="text-xs font-semibold text-slate-800 w-20 flex-shrink-0">{f.label}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 hidden sm:inline ${f.perDesign ? 'bg-violet-50 text-violet-600' : f.coh.perChild ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>{f.perDesign ? 'per design' : f.coh.perChild ? 'unique each' : 'should match'}</span>
                            {(f.key === 'title' || f.key === 'bullets') && rankChip(rankSectionChip[f.key])}
                            {split
                              ? <span className="text-[11px] text-purple-700 flex items-center gap-1">{f.coh.distinct} versions live</span>
                              : <span className="text-[11px] text-green-700 flex items-center gap-1" title={`${f.coh.total} SKUs across ${f.coh.totalAsins} ASINs (FBA + FBM twins count separately).`}><span aria-hidden>✓</span>all {f.coh.total} identical</span>}
                          </button>
                          {aiRecs?.field_pushed_at?.[f.key] && (
                            <span className="text-[10px] text-slate-400 flex-shrink-0 hidden md:inline" title={`Last shipped to Amazon ${new Date(aiRecs.field_pushed_at[f.key]).toLocaleString()}`}>shipped {relDate(aiRecs.field_pushed_at[f.key])}</span>
                          )}
                          <span className="text-[11px] flex-shrink-0">
                            {f.coh.needUpdate > 0
                              ? <span className="text-amber-700 flex items-center gap-1" title={`${f.coh.needUpdate} SKUs (across ${f.coh.needUpdateAsins} ASINs) have CACHED content that differs from the current recommendation. Counts are SKU-primary: an ASIN's FBA + FBM twins are two separate Amazon writes, so this now uses the SAME unit as the Ship modal and the Verify panel. Cached comparison — live FBM twins not yet in the cache are discovered at push time.`}>{f.coh.needUpdate} SKUs need update</span>
                              : (f.coh.distinct > 1 && !f.coh.perChild)
                                ? <span className="text-amber-700">variants differ — unify</span>
                                : <span className="text-green-700">up to date</span>}
                          </span>
                          <button onClick={() => openPushPreview(f.key as 'title' | 'bullets' | 'description')} className="text-[10px] px-2 py-0.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-medium flex-shrink-0" title="Read the LIVE value on Amazon for every SKU — confirms what actually applied, and offers to re-push any that are still stale.">Verify live</button>
                          <button onClick={() => toggle(`coh-${f.key}`)} className="text-xs text-slate-400 flex-shrink-0">{open ? '▾' : '▸'}</button>
                        </div>
                        {open && (
                          <div className="px-4 pb-3 pt-1 bg-slate-50/60 space-y-2">
                            {f.perChildEntries ? (
                              // PER-CHILD family (capacity = each variant's own GB; multi-design = each design's
                              // own copy). Show each per-child/per-design target — never one broadcast value.
                              // The Ship push already resolves per-SKU (pushFields.resolveProposed), so a
                              // family-wide Ship correctly writes each design's own value to its own SKUs.
                              <div className="bg-indigo-50 border border-indigo-200 rounded p-2">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-[10px] font-bold text-indigo-800 uppercase">{f.perDesign ? `Per design — each design keeps its own ${f.label.toLowerCase()}:` : 'Per-variant — each keeps its own capacity:'}</p>
                                  {f.coh.needUpdate > 0 && (
                                    <button onClick={() => openPushPreview(f.key as 'title' | 'bullets' | 'description')} className="text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-0.5 rounded font-medium whitespace-nowrap flex-shrink-0">Ship →</button>
                                  )}
                                </div>
                                <div className="mt-1.5 space-y-1.5">
                                  {f.perChildEntries.map((e, ti) => (
                                    <div key={ti} className="bg-white border border-slate-200 rounded px-2 py-1">
                                      <p className="text-[10px] font-mono text-slate-400 break-words">{e.label}</p>
                                      <p className="text-xs text-slate-800 break-words whitespace-pre-wrap">{e.value.length > 220 ? e.value.slice(0, 220) + '…' : e.value}</p>
                                    </div>
                                  ))}
                                </div>
                                {f.perDesign && <p className="text-[10px] text-slate-500 mt-1.5">Edit each design individually in <span className="font-semibold">Per-Design Content</span> above.</p>}
                              </div>
                            ) : (
                            <div className="flex items-start justify-between gap-2 bg-green-50 border border-green-200 rounded p-2">
                              <div className="min-w-0">
                                <p className="text-[10px] font-bold text-green-800 uppercase">
                                  Update all {f.coh.total} variants to:
                                  {f.key === 'title' && f.copyVal ? (
                                    <span className={`ml-2 normal-case font-semibold ${f.copyVal.length > 75 ? 'text-amber-600' : 'text-green-700'}`}>
                                      {f.copyVal.length}/75 chars{f.copyVal.length > 75 ? ' — over Amazon’s new limit' : ' ✓'}
                                    </span>
                                  ) : null}
                                </p>
                                <p className="text-xs text-slate-800 whitespace-pre-wrap break-words mt-0.5">{f.copyVal || '(none)'}</p>
                              </div>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <button onClick={() => copy(f.copyVal || '', `coh-${f.key}`)} className="text-[10px] bg-green-600 hover:bg-green-700 text-white px-2 py-0.5 rounded">{copied === `coh-${f.key}` ? 'Copied!' : 'Copy'}</button>
                                {/* Ship the broadcast value to Amazon — same push the Edit-Once card uses, surfaced here
                                    so "N need update" always has a one-click path (the seller's "no way to update it").
                                    Also fires when the variants DIVERGE (distinct>1) even if the score is "optimal" — the
                                    optimal gate zeroes needUpdate, but diverging variants still need unifying. */}
                                {(f.coh.needUpdate > 0 || (f.coh.distinct > 1 && !f.coh.perChild)) && (
                                  <button onClick={() => openPushPreview(f.key as 'title' | 'bullets' | 'description')} className="text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-0.5 rounded font-medium whitespace-nowrap">Ship →</button>
                                )}
                              </div>
                            </div>
                            )}
                            <p className="text-[10px] font-medium text-slate-500 uppercase">{f.coh.perChild ? 'Current per-variant titles:' : `Current values across your variants${split ? ' — these diverge:' : ':'}`}</p>
                            {f.coh.versions.map((v, vi) => (
                              <details key={vi} className="bg-white border border-slate-200 rounded">
                                <summary className="cursor-pointer px-2 py-1 text-[11px] flex items-center gap-2">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 flex-shrink-0">{v.skus.length} variant{v.skus.length === 1 ? '' : 's'}</span>
                                  {f.key === 'title' && v.value ? (
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium ${v.value.length > 75 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{v.value.length}c</span>
                                  ) : null}
                                  <span className="truncate text-slate-500">{v.value ? (v.value.length > 90 ? v.value.slice(0, 90) + '…' : v.value) : '(empty)'}</span>
                                </summary>
                                <p className="px-2 pb-2 text-[10px] text-slate-400 font-mono break-words">{v.skus.join(', ')}</p>
                              </details>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-2 px-4 py-2">
                    <span className="text-xs font-semibold text-slate-800 w-20 flex-shrink-0">Backend</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 flex-shrink-0 hidden sm:inline">unique each</span>
                    {rankChip(rankSectionChip.backend)}
                    <span className="text-[11px] text-slate-500 hidden sm:inline">each variant gets its own color-specific terms</span>
                    <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                      {aiRecs?.field_pushed_at?.keywords && (
                        <span className="text-[10px] text-slate-400 hidden md:inline" title={`Last shipped to Amazon ${new Date(aiRecs.field_pushed_at.keywords).toLocaleString()}`}>shipped {relDate(aiRecs.field_pushed_at.keywords)}</span>
                      )}
                      {needsUpdate > 0
                        ? <span className="text-[11px] text-amber-700" title={`${needsUpdate} SKUs across ${needsUpdateAsins} ASINs (FBA + FBM count separately — each is its own Amazon write).`}>{needsUpdate} SKUs need update</span>
                        : <span className="text-[11px] text-emerald-600 font-medium">✓ up to date</span>}
                      <button onClick={() => openPushPreview('keywords')} className="text-[10px] px-2 py-0.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-medium" title="Read the LIVE backend value on Amazon for every SKU — confirms what applied and re-pushes stragglers.">Verify live</button>
                      {needsUpdate > 0 && (
                        <button onClick={() => openPushPreview('keywords')} className="text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-0.5 rounded-md font-medium">Ship →</button>
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── TIER 1 — Edit Once (Parent Level) ── */}
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-700 uppercase tracking-wide"><Icon.Layers className="w-3.5 h-3.5 text-violet-500" /> Edit Once</h3>
                  <span className="text-[11px] text-slate-400">Parent level — applies to all {variants.length} variants</span>
                </div>
                <div className="space-y-2">
                  {parentItems.map((item, idx) => {
                    const style = verdictStyles[item.verdict] || verdictStyles.SKIP
                    return (
                  <div key={idx} className={`rounded-2xl border border-slate-200 border-l-4 bg-white shadow-sm p-4 ${style}`}>
                    {/* Row 1: Element + Verdict + Priority + Level */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${verdictDot[item.verdict] || verdictDot.SKIP}`} />
                      <span className="font-semibold text-sm uppercase text-slate-900">{item.element.replace(/_/g, ' ')}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${priorityBadge[item.priority] || ''}`}>
                        {item.priority}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-600 font-medium">
                        {item.level === 'parent' ? 'Parent Level' : 'Per Child'}
                      </span>
                      {/* #79 per-section regen: re-run JUST this section's agent (~30-60s, a
                          fraction of the cost) anchored on the stored title — the full audit
                          button above is untouched for whole-listing refreshes. */}
                      {(() => {
                        const sectionOf: Record<string, string> = { title: 'title', description: 'description', backend_keywords: 'keywords', bullet_1: 'bullets' }
                        const section = sectionOf[item.element]
                        if (!section) return null
                        return (
                          <button
                            onClick={() => generateAiRecs(section)}
                            disabled={aiLoading}
                            title={`Regenerate only the ${section === 'keywords' ? 'backend keywords' : section} — title/bullets/description keep their full quality council AND the editorial + fit truth gates (~1-2 min); backend keywords ~30-60s. Either way a fraction of the full 3-4 min audit. Other sections keep your stored recommendation; everything stays anchored on the stored title.`}
                            className="ml-auto text-[10px] px-2 py-0.5 rounded border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-50 font-medium">
                            {aiLoading && regenSection === section ? '⏳ Regenerating… hold on' : `↻ Regenerate ${section === 'keywords' ? 'backend' : section === 'bullets' ? 'all 5 bullets' : section}`}
                          </button>
                        )
                      })()}
                      <span className={`${['title', 'description', 'backend_keywords', 'bullet_1'].includes(item.element) ? '' : 'ml-auto '}text-[10px] font-mono text-slate-400`}>{item.verdict}</span>
                    </div>

                    {/* Row 2: Current Status */}
                    <p className="text-xs mt-1.5 text-slate-500">
                      <span className="font-medium text-slate-600">Current:</span> {item.current_status}
                    </p>

                    {/* Cooling lock: a recently-shipped section is "settling" (locked ~7 days so Amazon
                        applies + ranks it before we change it again). Let the seller override and
                        regenerate JUST this section before the window is up. */}
                    {item.verdict === 'DONE' && typeof item.current_status === 'string' && item.current_status.includes('settling') && (() => {
                      const coolSec = item.element === 'title' ? 'title' : item.element === 'description' ? 'description' : item.element === 'backend_keywords' ? 'keywords' : /^bullet_\d+$/.test(item.element) ? 'bullets' : ''
                      return coolSec ? (
                        <button onClick={() => generateAiRecs(coolSec)} disabled={aiLoading}
                          className="mt-1.5 text-[11px] text-violet-700 hover:text-violet-900 underline disabled:opacity-50">
                          ↻ Regenerate this section now (override the 7-day lock)
                        </button>
                      ) : null
                    })()}

                    {/* Row 3: Instruction */}
                    {item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (
                      <div className="mt-2 bg-slate-50 rounded-lg p-2.5 border border-slate-200">
                        <p className="text-xs font-medium mb-0.5 text-slate-700">What to do:</p>
                        <p className="text-xs leading-relaxed text-slate-600">{item.instruction}</p>
                      </div>
                    )}

                    {/* Row 4: Seller Central Path */}
                    {item.seller_central_path && item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (
                      <p className="text-[10px] mt-1.5 text-slate-400">
                        {item.seller_central_path}
                      </p>
                    )}

                    {/* A+ hand-off deep-link. A+ can't be pushed via SP-API, so the CREATE verdict on the
                        A+ card was a dead badge with no way to act. Give it a real link into A+ Content
                        Manager (the create/list surface — same URL as the dashboard + the audit issue copy).
                        Identifies the A+ item by its aplus_modules brief; also covers the brand-story card. */}
                    {(((item.aplus_modules && item.aplus_modules.length > 0)) || item.element === 'brand_story') && item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <a
                          href="https://sellercentral.amazon.com/enhanced-content/content-manager"
                          target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg px-3 py-2 transition-colors cursor-pointer"
                        >
                          <Icon.External className="w-3.5 h-3.5" /> {score.aplus_score > 0 ? 'Open A+ Content Manager' : 'Create A+ in Content Manager'} →
                        </a>
                        <button
                          onClick={scanAplus}
                          disabled={aplusScanning}
                          title="Re-check Amazon for A+ on this listing (e.g. right after you submit it) — updates the score without a full re-sync"
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg px-3 py-2 disabled:opacity-50 cursor-pointer"
                        >
                          {aplusScanning ? 'Scanning Amazon…' : '↻ Scan now'}
                        </button>
                        {aplusScanMsg && <span className="w-full text-[11px] text-slate-500">{aplusScanMsg}</span>}
                      </div>
                    )}

                    {/* Row 5a: PER-CHILD title table (capacity families like SD cards) — overrides
                        the single Copy & Paste box for title only. Apparel & single-capacity
                        products keep the broadcast card below (per_child_titles is empty).
                        Display is enriched with FBM TWINS from /family-skus so the seller sees
                        every SKU the push will hit (the audit pipeline only sees FBA in
                        listing_content, but the push discovers FBM twins live). */}
                    {item.element === 'title' && Array.isArray(recs.per_child_titles) && recs.per_child_titles.length > 1 && !multiDesign && item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (() => {
                      // Parent (variation hub) title = capacity-agnostic. Strip any GB/TB/MB
                      // capacity token from the broadcast recommended_title so the parent SKU
                      // (e.g. Memory-Card-P) carries a generic family title without any specific
                      // capacity — that's what shows on the variation hub before a child is picked.
                      const stripSfx = (sku: string) => sku.replace(/[-_](?:FBA|FBM|AFN|MFN|FN)$/i, '')
                      const parentTitle = stripCapacityToken(recs.recommended_title || '') || (recs.per_child_titles[0]?.title ? stripCapacityToken(recs.per_child_titles[0].title) : '')

                      // Compose the display list: every per_child_titles entry, plus every FBM
                      // twin discovered live (inherits its FBA sibling's title — same as push).
                      // Each row carries an `inherited` flag so the UI can show a subtle hint.
                      type DisplayTitleRow = { sku: string; title: string; fulfillment: 'FBA' | 'FBM' | 'unknown'; inherited: boolean }
                      const titlesBySku = new Map<string, string>()
                      for (const t of recs.per_child_titles ?? []) titlesBySku.set(t.sku, t.title)
                      const titlesByBase = new Map<string, string>()
                      for (const t of recs.per_child_titles ?? []) titlesByBase.set(stripSfx(t.sku), t.title)

                      const display: DisplayTitleRow[] = (recs.per_child_titles ?? []).map((t) => ({
                        sku: t.sku, title: t.title,
                        fulfillment: /[-_]FBA$/i.test(t.sku) ? 'FBA' : (/[-_]FBM$/i.test(t.sku) ? 'FBM' : 'unknown'),
                        inherited: false,
                      }))
                      if (familySkus?.children?.length) {
                        for (const f of familySkus.children) {
                          if (titlesBySku.has(f.sku)) continue
                          // Only show a discovered SKU when we have a sibling title to inherit.
                          const inheritedTitle = titlesByBase.get(f.base_name)
                          if (!inheritedTitle) continue
                          display.push({ sku: f.sku, title: inheritedTitle, fulfillment: f.fulfillment, inherited: true })
                        }
                      }
                      // Group by base_name (capacity), FBA before FBM, parent SKU rendered separately.
                      display.sort((a, b) => {
                        const baseA = stripSfx(a.sku), baseB = stripSfx(b.sku)
                        if (baseA !== baseB) return baseA.localeCompare(baseB)
                        const order = { FBA: 0, FBM: 1, unknown: 2 } as const
                        return order[a.fulfillment] - order[b.fulfillment]
                      })

                      return (
                        <div className="mt-2 bg-white rounded-md border-2 border-green-300 p-3">
                          <div className="flex items-center justify-between mb-1.5 flex-wrap gap-1">
                            <span className="flex items-center gap-1 text-[10px] font-bold text-green-800 uppercase">
                              <Icon.Clipboard className="w-3 h-3" /> Titles ({display.length + 1}: parent + {display.length} variants{display.some(d => d.inherited) ? ` incl. FBM twins` : ''}):
                            </span>
                            <span className="text-[10px] text-slate-500">Each child carries its own capacity (Amazon SEO best-practice). FBM twins inherit their FBA sibling&apos;s title.</span>
                          </div>

                          {/* PARENT ROW — the variation hub title, capacity-agnostic */}
                          {parentTitle && (
                            <div className="flex items-center gap-2 bg-violet-50 p-1.5 rounded border border-violet-200 mb-1">
                              <span className="text-[10px] font-bold text-violet-700 uppercase tracking-wide flex-shrink-0 w-24">PARENT</span>
                              <span className="text-xs leading-relaxed text-slate-800 flex-1 min-w-0 break-words">{parentTitle}</span>
                              <button
                                onClick={() => { navigator.clipboard.writeText(parentTitle); setCopied('pct-PARENT'); setTimeout(() => setCopied(null), 2000) }}
                                className="text-[10px] px-2 py-0.5 bg-violet-600 text-white rounded hover:bg-violet-700 font-medium flex-shrink-0">
                                {copied === 'pct-PARENT' ? 'Copied!' : 'Copy'}
                              </button>
                            </div>
                          )}

                          <div className="space-y-1">
                            {display.map((t) => (
                              <div key={t.sku} className={`flex items-center gap-2 p-1.5 rounded border ${t.inherited ? 'bg-sky-50 border-sky-200' : 'bg-green-50 border-green-200'}`}>
                                <span className="text-[10px] font-mono text-slate-500 flex-shrink-0">{t.sku}</span>
                                <span className={`text-[9px] font-semibold px-1 rounded flex-shrink-0 ${t.fulfillment === 'FBA' ? 'bg-emerald-200 text-emerald-800' : t.fulfillment === 'FBM' ? 'bg-sky-200 text-sky-800' : 'bg-slate-200 text-slate-700'}`}>
                                  {t.fulfillment === 'unknown' ? '?' : t.fulfillment}
                                </span>
                                <span className="text-xs leading-relaxed text-slate-800 flex-1 min-w-0 break-words">{t.title}</span>
                                {t.inherited && <span className="text-[9px] text-sky-600 italic flex-shrink-0">inherits FBA twin</span>}
                                <button
                                  onClick={() => { navigator.clipboard.writeText(t.title); setCopied(`pct-${t.sku}`); setTimeout(() => setCopied(null), 2000) }}
                                  className={`text-[10px] px-2 py-0.5 text-white rounded font-medium flex-shrink-0 ${t.inherited ? 'bg-sky-600 hover:bg-sky-700' : 'bg-green-600 hover:bg-green-700'}`}>
                                  {copied === `pct-${t.sku}` ? 'Copied!' : 'Copy'}
                                </button>
                              </div>
                            ))}
                          </div>

                          {parentTitle && (
                            <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                              <span className="font-semibold text-slate-700">Parent</span> is the variation hub title (no specific capacity — it&apos;s the shared family title sellers see in Seller Central before drilling into a variant).
                              <span className="font-semibold text-slate-700"> Variants</span> are the actual buyable child SKUs, each carrying its own capacity.
                              {display.some(d => d.inherited) && <> <span className="font-semibold text-slate-700">FBM twins</span> share the title of their FBA sibling (same product, different fulfillment).</>}
                            </p>
                          )}
                        </div>
                      )
                    })()}

                    {/* Row 5b: Replacement Content (the actual fix) — broadcast card. Hidden when
                        the per-child title table above is showing. Shown even for DONE: a 'DONE' verdict is
                        set at ship-ACCEPTED time (cooling lock), NOT verified-live, so a section can read DONE
                        while cohesion still says it needs updating (bullets/description went hollow/unpushable
                        on B0FRYMM56C). The seller must always be able to copy + re-ship the recommendation. */}
                    {item.replacement_content && item.verdict !== 'SKIP' && !(item.element === 'title' && Array.isArray(recs.per_child_titles) && recs.per_child_titles.length > 1 && !multiDesign) && (
                      <div className="mt-2 bg-white rounded-md border-2 border-green-300 p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="flex items-center gap-1 text-[10px] font-bold text-green-800 uppercase"><Icon.Clipboard className="w-3 h-3" /> Copy & Paste This:</span>
                          <button
                            onClick={() => {
                              const text = Array.isArray(item.replacement_content)
                                ? item.replacement_content.map(line => typeof line === 'string' ? line : (line as Record<string, unknown>).keywords ? `${(line as Record<string, unknown>).sku}: ${(line as Record<string, unknown>).keywords}` : JSON.stringify(line)).join('\n')
                                : (typeof item.replacement_content === 'string' ? item.replacement_content : JSON.stringify(item.replacement_content)) || ''
                              navigator.clipboard.writeText(text)
                            }}
                            className="text-[10px] px-2 py-0.5 bg-green-600 text-white rounded hover:bg-green-700 font-medium"
                          >
                            Copy
                          </button>
                        </div>
                        {Array.isArray(item.replacement_content) ? (
                          <div className="space-y-1">
                            {item.replacement_content.map((line, li) => (
                              <p key={li} className="text-xs leading-relaxed font-mono bg-green-50 p-1.5 rounded border border-green-200">
                                {typeof line === 'string' ? line : (line as Record<string, unknown>).keywords ? `${(line as Record<string, unknown>).sku}: ${(line as Record<string, unknown>).keywords}` : JSON.stringify(line)}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs leading-relaxed font-mono bg-green-50 p-2 rounded border border-green-200 whitespace-pre-wrap">{typeof item.replacement_content === 'string' ? item.replacement_content : JSON.stringify(item.replacement_content)}</p>
                        )}
                      </div>
                    )}

                    {/* Row 5c: Ship this section to Amazon — each section has its own approval.
                        Audit emits element names: 'title' / 'description' / 'bullet_1..5'
                        (one consolidated bullets card, not five). Old code matched the literal
                        'bullet_1' only, which never appears — so the Ship button never showed up
                        on the bullets card. Match anything starting with 'bullet'. */}
                    {(() => {
                      const shipField: PushField | null =
                        item.element === 'title' ? 'title'
                        : item.element === 'description' ? 'description'
                        : /^bullet/.test(item.element) ? 'bullets'
                        : null
                      // Show Ship even for DONE (see Row-5b note): DONE is ship-accepted, not verified-live,
                      // so a bullets/description card must stay pushable while cohesion still says it differs.
                      if (!shipField || item.verdict === 'SKIP') return null
                      // Title is per-child for capacity families; on a MULTI-DESIGN family title, bullets AND
                      // description are each PER-DESIGN — the ship engine resolves per-SKU (resolveProposed),
                      // so the "same value written to all N" broadcast label is FALSE there. Show "Per design".
                      const perChildTitle = shipField === 'title' && Array.isArray(recs.per_child_titles) && recs.per_child_titles.length > 1 && !multiDesign
                      const perDesignField = multiDesign && (
                        (shipField === 'title' && (recs.per_child_titles?.length ?? 0) > 1) ||
                        (shipField === 'bullets' && (recs.per_child_bullets?.length ?? 0) > 1) ||
                        (shipField === 'description' && (recs.per_child_descriptions?.length ?? 0) > 1)
                      )
                      return (
                        <div className="mt-2.5 flex items-center gap-2 flex-wrap border-t border-current/10 pt-2.5">
                          <button
                            onClick={() => openPushPreview(shipField)}
                            disabled={pushLoading}
                            title={perChildTitle ? 'Each variant gets its own capacity-specific title' : perDesignField ? `Each design keeps its own ${FIELD_LABEL[shipField].toLowerCase()} — ships to that design’s SKUs` : `Write the recommended ${FIELD_LABEL[shipField].toLowerCase()} directly to Amazon for every variant`}
                            className="inline-flex items-center gap-1.5 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50 transition-colors cursor-pointer">
                            <Icon.Send className="w-3.5 h-3.5" /> Ship {shipField === 'bullets' ? 'all 5 bullets' : FIELD_LABEL[shipField].toLowerCase()} to Amazon
                          </button>
                          <span className="text-[10px] text-slate-600 inline-flex items-center gap-1 flex-wrap">
                            {perChildTitle ? (
                              <>
                                <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Per child</span>
                                each variant gets its own capacity-specific title
                              </>
                            ) : perDesignField ? (
                              <>
                                <span className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 font-medium">Per design</span>
                                each design keeps its own — ships to that design’s SKUs
                              </>
                            ) : (
                              <>
                                <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">Parent</span>
                                same value written to all {variants.length} variants
                              </>
                            )}
                          </span>
                        </div>
                      )
                    })()}

                    {/* Row 6: Notes */}
                    {item.notes && (
                      <p className="text-[10px] mt-1.5 italic opacity-70">{item.notes}</p>
                    )}

                    {/* A+ Module Details */}
                    {item.aplus_modules && item.aplus_modules.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-[10px] font-medium">A+ Modules to configure:</p>
                        {item.aplus_modules.map((mod, mi) => (
                          <div key={mi} className="text-[10px] bg-white/80 rounded p-1.5 border border-current/10 flex gap-2">
                            <span className="font-mono text-[9px] opacity-50">#{mod.position}</span>
                            <span className={`px-1 rounded text-[9px] ${
                              mod.action === 'ADD' ? 'bg-blue-100 text-blue-700' :
                              mod.action === 'EDIT' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                            }`}>{mod.action}</span>
                            <span className="font-medium">{mod.module_type}</span>
                            <span className="opacity-70">— {mod.content_brief}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                    )
                  })}
                </div>

                {/* Recommended Product Detail values (folded from AI Recommendations) */}
                {/* Each detail ships INDEPENDENTLY (Material, Brand, Fit Type, …). The map in
                    lib/fba/productDetailAttrs.ts decides which friendly names are pushable —
                    parent-shared attributes get a Push button, per-variant ones (Color/Size/
                    Capacity) and unmapped names keep Copy + a tooltip explaining why. */}
                {recs.product_details_improvements && recs.product_details_improvements.length > 0 && (
                  <div className="mt-3 bg-white border border-slate-200 rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <span className="text-xs font-semibold text-slate-700">Recommended Product Detail values</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400">
                          {recs.product_details_improvements.filter((pd) => pd.pushable ?? isPushableDetail(pd.field_name)).length} pushable · {recs.product_details_improvements.length} total
                        </span>
                        {bulkEligibleDetails.length >= 2 && (
                          <button
                            onClick={openBulkPush}
                            className="text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 rounded font-semibold whitespace-nowrap"
                            title="Push every ready field to Amazon in one go — you confirm once, each field still gets full validation"
                          >
                            Auto Push all ready ({bulkEligibleDetails.length}) →
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2">
                      {recs.product_details_improvements.map((pd, i) => {
                        // The regen stores schema-resolved pushability (sp_api_key/pushable) per row — ANY
                        // category's attributes get a Push button, not just the static apparel map. Rows
                        // from before that change have no flag → fall back to the static map.
                        // STYLE LEAK GATE (B): style/style_name read off the specific artwork, so broadcasting
                        // one value across a multi-design family overwrites each design's distinct style. The
                        // seller's manual override is authoritative over the auto-detector (resolveMultiDesign),
                        // so force-single un-suppresses and force-multi suppresses regardless of per_child_titles.
                        // Single-design is untouched. Server re-checks (loadDetailContext).
                        const styleLeak = resolveMultiDesign(aiRecs?.per_child_titles, isMultiDesignOverride) && (isSingleDesignOnlyKey(pd.sp_api_key) || isSingleDesignOnlyDetail(pd.field_name))
                        const pushable = !styleLeak && (pd.pushable ?? isPushableDetail(pd.field_name))
                        const blockedReason = pushable ? null : styleLeak ? SINGLE_DESIGN_ONLY_LEAK_REASON : (pd.attr_scope === 'per-variant' ? 'Differs per variant — set it on each child SKU in Seller Central.' : unpushableReason(pd.field_name))
                        // Pushed/up-to-date state (PO: "no notice after PUSH"): the push write-through
                        // sets current_value = recommended_value (server-side at push; mirrored locally
                        // by the modal + Auto Push), so equality IS the "this is on Amazon" signal.
                        const upToDate = pushable && (pd.recommended_value ?? '').trim() !== '' && (pd.current_value ?? '').trim() === (pd.recommended_value ?? '').trim()
                        return (
                          <div key={i} className={`rounded-lg p-2.5 ${upToDate ? 'bg-emerald-50 border border-emerald-200' : pushable ? 'bg-emerald-50/40 border border-emerald-100' : 'bg-slate-50'}`}>
                            <div className="flex items-center justify-between mb-0.5 gap-2">
                              <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5 min-w-0">
                                <span className="truncate">{pd.field_name}</span>
                                {upToDate && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium whitespace-nowrap" title="The live Amazon value matches this recommendation — pushed (or already correct). Amazon may take 15min–6hr to show it on the product page.">
                                    ✓ On Amazon
                                  </span>
                                )}
                                {/* Pushed-but-processing (PO: "pushed with a change, why not marked done?"): the badge
                                    above reads the LIVE Amazon value, which lags a push by 15min–6hr — and a re-sync in
                                    that window reverts the optimistic flip. The pending auto-verify task is the truth
                                    that a push IS in flight, so surface it and stop the card reading as never-pushed. */}
                                {!upToDate && verifyQueue.tasks.some((t) => (t.status === 'pending' || t.status === 'running') && t.field === `details:${pd.sp_api_key ?? ''}`) && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-medium whitespace-nowrap" title="Pushed — Amazon is processing (typically 15min–6hr). Auto-verify will flip this to ✓ On Amazon when it lands, or alert you if it fails. No need to push again.">
                                    ⏳ Verifying
                                  </span>
                                )}
                              </span>
                              <div className="flex items-center gap-2 shrink-0">
                                <button onClick={() => copy(prettyDetailValue(pd.recommended_value, pd.enum_accepted), `pd-${i}`)} className="text-[10px] text-violet-600 hover:underline">{copied === `pd-${i}` ? 'Copied!' : 'Copy'}</button>
                                {pushable ? (
                                  <button
                                    onClick={() => openPushPreview('details', pd.field_name)}
                                    className={`text-[10px] px-2 py-0.5 rounded font-medium whitespace-nowrap ${upToDate ? 'border border-emerald-300 text-emerald-700 hover:bg-emerald-100' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}
                                    title={upToDate ? `Already on Amazon — opens the modal to re-push or Verify the live value per SKU` : `Push ${pd.field_name} to Amazon for every child SKU`}
                                  >
                                    {upToDate ? 'Verify / Re-push' : 'Push →'}
                                  </button>
                                ) : (
                                  <span
                                    className="text-[10px] text-slate-400 cursor-help"
                                    title={blockedReason ?? 'Set this in Seller Central.'}
                                  >
                                    Manual
                                  </span>
                                )}
                              </div>
                            </div>
                            <p className="text-xs text-slate-700">{prettyDetailValue(pd.recommended_value, pd.enum_accepted)}</p>
                            {pd.current_value && pd.current_value !== pd.recommended_value && (
                              <p className="text-[10px] text-slate-400 line-through mt-1 break-words">{prettyDetailValue(pd.current_value, pd.enum_accepted)}</p>
                            )}
                            {pd.sp_api_key && aiRecs?.field_pushed_at?.[`details:${pd.sp_api_key}`] && (
                              <p className="text-[10px] text-slate-400 mt-1" title={`Last shipped to Amazon ${new Date(aiRecs.field_pushed_at[`details:${pd.sp_api_key}`]).toLocaleString()}`}>shipped {relDate(aiRecs.field_pushed_at[`details:${pd.sp_api_key}`])}</p>
                            )}
                            {!pushable && blockedReason && (
                              <p className="text-[10px] text-slate-500 italic mt-1">{blockedReason}</p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* ── TIER 2 — Edit Per Variant (Per Child) ── */}
              <div>
                <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-700 uppercase tracking-wide"><Icon.Tag className="w-3.5 h-3.5 text-violet-500" /> Edit Per Variant</h3>
                  <span className="text-[11px] text-slate-400">Backend search terms — unique per color/size</span>
                  {needsUpdate > 0
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium" title={`${needsUpdate} SKUs across ${needsUpdateAsins} ASINs differ from the recommendation (each ASIN's FBA + FBM SKUs are separate Amazon writes). Cached comparison — live FBM twins not yet in the cache are discovered at push time.`}>{fmtCount(needsUpdate, needsUpdateAsins)} of {fmtCount(totalSkus, perChildRows.length)} need update</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">all {fmtCount(totalSkus, perChildRows.length)} match</span>}
                  {/* PO: "I don't see a way to regenerate just keywords" — the per-section button
                      lived only on the action-plan card; surface it HERE where the per-variant
                      strings actually display. */}
                  <button
                    onClick={() => generateAiRecs('keywords')}
                    disabled={aiLoading}
                    title="Regenerate only the per-variant backend search terms (~30-60s) — anchored on the stored title + bullets; fills each child to the 250-byte budget."
                    className="text-[10px] px-2 py-0.5 rounded border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-50 font-medium">
                    {aiLoading && regenSection === 'keywords' ? '⏳ Regenerating… hold on' : '↻ Regenerate backend'}
                  </button>
                </div>
                {backendItem?.instruction && <p className="text-xs text-slate-600 mb-2">{backendItem.instruction}</p>}
                {perChildRows.length === 0 ? (
                  <p className="text-xs text-slate-400">No variant data yet.</p>
                ) : (
                  <details className="bg-white border border-slate-200 rounded-2xl overflow-hidden group">
                    <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-2">
                      <span className="text-slate-400 transition-transform group-open:rotate-90" aria-hidden>▸</span>
                      View per-variant backend terms — {perChildRows.length} ASINs ({totalSkus} SKUs incl. FBA+FBM){needsUpdate > 0 ? `, ${fmtCount(needsUpdate, needsUpdateAsins)} need update` : ''}
                    </summary>
                    <div className="overflow-x-auto border-t border-slate-100">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-slate-500">SKU</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-500">Status</th>
                          <th className="text-left px-3 py-2 font-medium text-slate-500">Recommended backend search terms</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {perChildRows.map(r => (
                          <tr key={r.sku} className={r.changed ? 'bg-amber-50/40' : ''}>
                            <td className="px-3 py-2 font-mono text-slate-700 align-top whitespace-nowrap">{r.sku}</td>
                            <td className="px-3 py-2 align-top whitespace-nowrap">
                              {r.recommended === ''
                                ? <span className="text-slate-400">—</span>
                                : r.changed
                                  ? <span className="text-amber-600 font-medium">Update</span>
                                  : <span className="text-green-600">✓ OK</span>}
                            </td>
                            <td className="px-3 py-2 align-top">
                              {r.changed && r.current && <p className="text-[10px] text-slate-400 line-through mb-0.5 whitespace-pre-wrap break-words">{r.current}</p>}
                              <p className="text-slate-700 font-mono leading-relaxed whitespace-pre-wrap break-words">{r.recommended || '(no recommendation)'}</p>
                            </td>
                            <td className="px-3 py-2 align-top">
                              {r.recommended && (
                                <button onClick={() => copy(r.recommended, `kw-${r.sku}`)} className="text-[10px] text-violet-600 hover:underline whitespace-nowrap">{copied === `kw-${r.sku}` ? 'Copied!' : 'Copy'}</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </details>
                )}
                {needsUpdate > 0 && (
                  <button onClick={() => openPushPreview('keywords')} className="mt-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-medium">
                    Push to {needsUpdate} SKU{needsUpdate === 1 ? '' : 's'} on Amazon →
                  </button>
                )}

                {/* Variant-specific corrections (folded from AI Recommendations) */}
                {recs.variant_corrections && recs.variant_corrections.length > 0 && (
                  <div className="mt-3 bg-white border border-slate-200 rounded-2xl p-4">
                    <span className="text-xs font-semibold text-slate-700 block mb-2">Variant-specific corrections</span>
                    <div className="space-y-2">
                      {recs.variant_corrections.map((vc, i) => (
                        <div key={i} className="bg-slate-50 rounded-lg p-3">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono text-slate-600">{vc.sku}</span>
                            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{vc.field}</span>
                          </div>
                          {vc.current && <p className="text-[10px] text-slate-400 line-through">{vc.current.length > 100 ? vc.current.slice(0, 100) + '...' : vc.current}</p>}
                          <p className="text-xs text-slate-800 mt-0.5">{vc.replace_with}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
        )
      })()}

      {/* Apply-tab fallback — recommendations loaded but the audit returned an empty action plan
          (otherwise the tab renders blank — the "not loading" report). */}
      {activeTab === 'apply' && aiRecs && !(aiRecs.action_plan && aiRecs.action_plan.length > 0) && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10 text-center">
          <p className="text-sm text-slate-500 mb-1">The recommendations loaded, but the action plan came back empty.</p>
          <p className="text-xs text-slate-400 mb-4">Regenerate to rebuild the per-section changes.</p>
          <button onClick={() => generateAiRecs()} disabled={aiLoading} className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-4 py-2 transition-colors cursor-pointer disabled:opacity-50">
            <Icon.Sparkles className="w-3.5 h-3.5" /> {aiLoading ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 1 — Keyword Placement Plan (grouped by placement)
          ══════════════════════════════════════════════════════════════════════ */}
      <section>
        {activeTab === 'placement' && (
          <>
            {!aiRecs && !aiLoading && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center">
                <p className="text-sm text-slate-500 mb-3">No AI audit yet. Generate one to see the keyword placement plan.</p>
                <button onClick={() => generateAiRecs()} className="text-xs bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-lg">
                  Run AI Audit
                </button>
              </div>
            )}
            {aiLoading && (
              <div className="bg-violet-50 border border-violet-200 rounded-lg p-6 text-center">
                <div className="animate-spin w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full mx-auto mb-2" />
                <p className="text-sm text-violet-600">{aiProgress || 'Generating keyword placement plan...'}</p>
              </div>
            )}
            {placementGroups && (
              <div className="space-y-4">
                {placementGroups.sortedKeys.map(groupKey => {
                  const group = placementGroups.groups[groupKey]
                  const placements = groupKey.split(' + ')
                  const totalVol = group.keywords.reduce((s, k) => s + (k.search_volume || 0), 0)
                  const hasCritical = group.keywords.some(k => k.action_type === 'CRITICAL')
                  const hasUpgrade = group.keywords.some(k => k.action_type === 'UPGRADE' || k.action_type === 'TITLE UPGRADE')
                  const borderClass = hasCritical ? 'border-red-300 bg-red-50/30' : hasUpgrade ? 'border-amber-300 bg-amber-50/30' : 'border-green-300 bg-green-50/30'
                  const copyLabel = `placement-${groupKey}`

                  return (
                    <div key={groupKey} className={`rounded-2xl border-2 p-4 ${borderClass}`}>
                      {/* Placement header */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex flex-wrap gap-1.5">
                          {placements.map((loc, j) => (
                            <span key={j} className="text-xs font-bold bg-violet-700 text-white px-2.5 py-1 rounded uppercase tracking-wide">
                              {loc.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-slate-500">{group.keywords.length} keywords &middot; {totalVol.toLocaleString()} searches/mo</span>
                          <button
                            onClick={() => copy(group.text, copyLabel)}
                            className="text-[10px] bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-2 py-1 rounded transition-colors">
                            {copied === copyLabel ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>

                      {/* The actual text */}
                      <div className="bg-white rounded-lg border border-slate-200 p-3 mb-3">
                        <p className="text-sm text-slate-800 leading-relaxed">{group.text}</p>
                      </div>

                      {/* Keyword pills */}
                      <div className="flex flex-wrap gap-2">
                        {group.keywords.sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0)).map((kw, i) => (
                          <span key={i} className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${
                            kw.action_type === 'CRITICAL' ? 'bg-red-100 border-red-300 text-red-800'
                            : (kw.action_type === 'UPGRADE' || kw.action_type === 'TITLE UPGRADE') ? 'bg-amber-100 border-amber-300 text-amber-800'
                            : 'bg-green-100 border-green-300 text-green-800'
                          }`}>
                            {kw.keyword}
                            {kw.search_volume > 0 && <span className="opacity-60">({kw.search_volume.toLocaleString()})</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 2 — Issues to Fix
          ══════════════════════════════════════════════════════════════════════ */}
      <section>
        {activeTab === 'issues' && (
          <div className="space-y-2">
            {score.issues.length === 0 ? (
              <p className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg p-3">No issues found. This listing looks great!</p>
            ) : (
              score.issues.map((issue, i) => (
                <div key={i} className={`border-l-4 ${issueBorder(issue.field)} bg-white border border-slate-200 rounded-r-lg p-3`}>
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                      issue.severity === 'error' ? 'bg-red-100 text-red-700'
                      : issue.severity === 'warning' ? 'bg-amber-100 text-amber-700'
                      : 'bg-blue-100 text-blue-700'
                    }`}>{issue.field}</span>
                    <p className="text-sm text-slate-700 leading-relaxed">{issue.message}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 3 — Variant Breakdown
          ══════════════════════════════════════════════════════════════════════ */}
      <section>
        {activeTab === 'variants' && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">SKU</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">A+</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Bullets</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Keywords</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Images</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dedupByAsin(score.children).map(child => (
                  <tr key={child.sku} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="font-mono text-slate-700">{child.sku}</div>
                      <div className="text-[10px] text-slate-400 truncate max-w-[300px]">{child.title}</div>
                    </td>
                    <td className="px-3 py-2">
                      {child.has_aplus ? (
                        <span className="text-green-600">&#10003; ({child.aplus_module_count}m)</span>
                      ) : (
                        <span className="text-red-500">&#10007;</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {[child.bullet_1, child.bullet_2, child.bullet_3, child.bullet_4, child.bullet_5].filter(Boolean).length}/5
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {child.backend_keywords ? `${child.backend_keywords.length}/250` : '0/250'}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{child.image_count}/7</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 4 — (removed: consolidated into "Apply These Changes")
          ══════════════════════════════════════════════════════════════════════ */}
      {/* AI Recommendations consolidated into "Apply These Changes" above (Batch 4). */}

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 5 — Keyword Intelligence (if available)
          ══════════════════════════════════════════════════════════════════════ */}
      {kwData && (
        <section>
          {/* Empty-state: tab persists even with no actionable opportunities (wiped/all-covered/
              never-researched) instead of vanishing — so the seller always sees their keyword state. */}
          {activeTab === 'kwintel' && kwData.topOpportunities.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
              <p className="text-sm font-medium text-slate-700">No keyword opportunities to act on right now</p>
              <p className="text-xs text-slate-500 mt-1.5 max-w-md mx-auto">
                {kwData.totalKeywordsAnalyzed > 0
                  ? `All ${kwData.totalKeywordsAnalyzed} researched keywords are currently covered or low-priority — there's nothing flagged to add. Re-research to refresh the opportunity set.`
                  : 'This listing has no keyword intelligence yet. Run a keyword research (Sync) to populate it.'}
              </p>
            </div>
          )}
          {activeTab === 'kwintel' && kwData.topOpportunities.length > 0 && (
            <>
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              {/* Summary badges + competitor-keyword import (the native sources only query OUR
                  ASIN — they can never discover keywords competitors rank on; H10 Cerebro can). */}
              <div className="flex items-center gap-3 p-3 border-b border-slate-100 bg-slate-50 flex-wrap">
                {kwData.summary.critical > 0 && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{kwData.summary.critical} Critical</span>}
                {kwData.summary.upgrade > 0 && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{kwData.summary.upgrade} Upgrade</span>}
                {kwData.summary.reinforce > 0 && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">{kwData.summary.reinforce} Reinforce</span>}
                {kwData.summary.defended > 0 && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{kwData.summary.defended} Defended</span>}
                {/* G6 — Sponsored Products seed list, built client-side from the keywords already
                    loaded (no endpoint, no credits). Exact match; prioritized by proven sales and
                    LOW title density (few competitors carry the phrase in their title = winnable,
                    typically cheaper clicks). ALL opportunity keywords are included — sorting is
                    the prioritization, nothing is silently dropped. */}
                <button
                  className="ml-auto text-xs px-3 py-1 rounded-lg font-semibold border border-violet-600 text-violet-700 hover:bg-violet-50"
                  title="Download a Sponsored Products seed CSV (exact match) from this keyword set — prioritized by keyword sales + low title density. No credits; builds from data already on screen."
                  onClick={() => {
                    const all = ((kwData as unknown as { allKeywords?: AnalyzedKeyword[] }).allKeywords ?? kwData.topOpportunities)
                      .filter((k) => ['CRITICAL', 'UPGRADE', 'REINFORCE'].includes(k.actionType))
                    // PPC priority: proven purchases dominate, volume assists, low-TD bonus
                    // (TD ≤2 = almost nobody titles the phrase — exact-match gold).
                    const prio = (k: AnalyzedKeyword) =>
                      (k.keywordSales ?? 0) * 2 + (k.searchVolume ?? 0) / 100 + ((k.titleDensity ?? 99) <= 2 ? 50 : 0)
                    const rows = [...all].sort((a, b) => prio(b) - prio(a))
                    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
                    const csv = ['Keyword,Match Type,Search Volume,Keyword Sales,Opportunity,Title Density,Our Rank,Action']
                      .concat(rows.map((k) => [k.keyword, 'Exact', k.searchVolume ?? '', k.keywordSales ?? '', k.opportunityScore ?? '', k.titleDensity ?? '', k.organicRank ?? '', k.actionType].map(esc).join(',')))
                      .join('\n')
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
                    a.download = `ppc-seeds-${asin}.csv`
                    a.click()
                    URL.revokeObjectURL(a.href)
                  }}
                >Export PPC seeds (CSV)</button>
                <label className={`text-xs px-3 py-1 rounded-lg font-semibold cursor-pointer ${kwImportBusy ? 'bg-violet-100 text-violet-700 animate-pulse' : 'bg-violet-600 hover:bg-violet-700 text-white'}`}
                  title="Import competitor-proven keywords from a Helium 10 Cerebro/Xray CSV export — they get the same scoring + presence checks as native keywords, and the next Regenerate weaves them in.">
                  {kwImportBusy ? 'Importing…' : 'Import H10 CSV →'}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    disabled={kwImportBusy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''   // allow re-selecting the same file
                      if (!file) return
                      setKwImportBusy(true); setKwImportMsg(null)
                      try {
                        const csv = await file.text()
                        const resp = await fetch('/api/fba/keywords/import', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ parent_asin: asin, csv }),
                        })
                        const data = await resp.json()
                        if (!resp.ok || data.error) { setKwImportMsg(`✗ ${data.error ?? `HTTP ${resp.status}`}`) }
                        else {
                          setKwImportMsg(`✓ Imported ${data.imported} new keywords (${data.skippedExisting} already known, ${data.skippedLowVolume} under 50/mo volume). Top: ${ (data.topNew ?? []).slice(0, 3).map((t: { keyword: string }) => `“${t.keyword}”`).join(', ') }. Hit Regenerate to weave them into the content.`)
                        }
                      } catch (err) {
                        setKwImportMsg(`✗ ${err instanceof Error ? err.message : 'Import failed'}`)
                      }
                      setKwImportBusy(false)
                    }}
                  />
                </label>
              </div>
              {kwImportMsg && (
                <p className={`px-3 py-2 text-[11px] border-b border-slate-100 ${kwImportMsg.startsWith('✓') ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{kwImportMsg}</p>
              )}
              {/* Re-research with a CATEGORY (or custom) seed — the seed decides the whole keyword
                  universe: niche query + which competitor gets harvested. Blank = auto seed (the
                  product type for non-apparel, the design/title for apparel). Costs 4 JS credits
                  (niche + SOV + competitor harvest + OUR organic ranks for the tracker). */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-violet-50/40 flex-wrap">
                <input
                  type="text"
                  value={kwSeed}
                  onChange={(e) => setKwSeed(e.target.value)}
                  placeholder='Research seed — blank = auto (e.g. "self stick notes")'
                  maxLength={80}
                  className="flex-1 min-w-[220px] text-xs border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-400"
                  disabled={kwResearchBusy}
                />
                <button
                  onClick={async () => {
                    if (kwResearchBusy) return
                    setKwResearchBusy(true); setKwResearchMsg(null)
                    // AUTO-CHAIN (PO 2026-06-15): one click runs the whole logical flow — re-research →
                    // (poll until the new pool lands) → refresh pool + rank → regenerate content. No
                    // manual reload, no separate Regenerate click. Research is fire-and-forget server-side,
                    // so we poll the real research timestamp (researchedAt) until it advances.
                    try {
                      // 1) Snapshot the current research timestamp to detect when the NEW one lands.
                      let prevResearchedAt: string | null = null
                      try {
                        const pre = await fetch(`/api/fba/intelligence/${asin}?stored=true`, { cache: 'no-store' })
                        if (pre.ok) prevResearchedAt = (await pre.json())?.researchedAt ?? null
                      } catch { /* ignore — first-ever research has no prior timestamp */ }

                      // 2) Kick off the background research (4 JS credits).
                      const resp = await fetch(`/api/fba/intelligence/${asin}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ seed: kwSeed.trim() || undefined }),
                      })
                      const data = await resp.json().catch(() => ({}))
                      if (!resp.ok || data.error) { setKwResearchMsg(`✗ ${data.error ?? `HTTP ${resp.status}`}`); setKwResearchBusy(false); return }

                      // 3) Poll until the research timestamp advances (research complete), or time out.
                      setKwResearchMsg(`⏳ Researching keywords${kwSeed.trim() ? ` (seed “${kwSeed.trim()}”)` : ' (auto seed)'}… ~1 min, runs in background.`)
                      const started = Date.now()
                      const TIMEOUT_MS = 180_000
                      let freshPool: KeywordIntelligenceResult | null = null
                      while (Date.now() - started < TIMEOUT_MS) {
                        await new Promise((r) => setTimeout(r, 8000))
                        try {
                          const poll = await fetch(`/api/fba/intelligence/${asin}?stored=true`, { cache: 'no-store' })
                          if (poll.ok) {
                            const pd = await poll.json()
                            if (pd?.researchedAt && pd.researchedAt !== prevResearchedAt && (pd.totalKeywordsAnalyzed ?? 0) > 0) { freshPool = pd; break }
                          }
                        } catch { /* transient — keep polling */ }
                      }
                      if (!freshPool) {
                        setKwResearchMsg('⚠ Research is taking longer than expected. Reload the tab to see the refreshed pool, then Regenerate.')
                        setKwResearchBusy(false); return
                      }

                      // 4) Auto-chain: refresh pool + rank, then regenerate content from the new keywords.
                      setKwData(freshPool)
                      setKwResearchMsg('✓ New keywords in — refreshing rank and rewriting content from them…')
                      refreshRankFree()
                      await generateAiRecs()
                      setKwResearchMsg('✓ Done: pool refreshed, rank updated, and content rewritten from the new keywords. Review the drafts in Apply Changes.')
                    } catch (err) {
                      setKwResearchMsg(`✗ ${err instanceof Error ? err.message : 'Failed to start research'}`)
                    }
                    setKwResearchBusy(false)
                  }}
                  disabled={kwResearchBusy}
                  className="text-xs bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50 whitespace-nowrap"
                  title="Runs the full research pipeline fresh: niche keywords + Share-of-Voice competitor discovery + the #1 competitor's keyword harvest + OUR organic ranks (feeds the Rank column + tracker). Spends 4 Jungle Scout credits."
                >
                  {kwResearchBusy ? 'Working…' : 'Re-research + Rewrite (4 JS credits) →'}
                </button>
              </div>
              {kwResearchMsg && (
                <p className={`px-3 py-2 text-[11px] border-b border-slate-100 ${kwResearchMsg.startsWith('✓') ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{kwResearchMsg}</p>
              )}
              {/* Top 20 keywords table */}
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-slate-500">Keyword</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-500">Vol</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-500" title="Opportunity score 0-100: demand × proven sales × competition × rank momentum × how big the gap in YOUR listing is">Opp</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-500" title="YOUR organic rank for this keyword (Jungle Scout, measured on each Re-research). Arrow = movement vs the previous snapshot. — = not ranking.">Rank</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-500">Action</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-500" title="Where this keyword appears in YOUR listing — T=Title, B=Bullets, D=Description, K=Backend keywords. Checked LIVE against your current content every time this tab loads (push content, reload, and the flags update — no re-research needed).">Present In</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(kwShowAll
                    ? (((kwData as unknown as { allKeywords?: AnalyzedKeyword[] }).allKeywords ?? kwData.topOpportunities))
                    : kwData.topOpportunities.slice(0, 20)).map((kw, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-800">
                        {kw.keyword}
                        {kw.titleDensity != null && kw.titleDensity <= 2 && kw.searchVolume >= 500 && (
                          <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-semibold whitespace-nowrap"
                            title={`Title Density ${kw.titleDensity} (from your H10 import): only ${kw.titleDensity} page-1 competitor${kw.titleDensity === 1 ? ' has' : 's have'} this exact phrase in their TITLE — putting it in your title or Item Highlights is a low-competition win. The title generator already prefers these on ties.`}>
                            TD {kw.titleDensity} · title win
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">{kw.searchVolume.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${kw.opportunityScore >= 70 ? 'text-violet-700' : kw.opportunityScore >= 40 ? 'text-slate-700' : 'text-slate-400'}`}>{Math.round(kw.opportunityScore)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {kw.organicRank != null ? (
                          <span className="text-slate-700 font-medium">
                            #{kw.organicRank}
                            {kw.prevOrganicRank != null && kw.prevOrganicRank !== kw.organicRank && (
                              <span className={`ml-1 text-[10px] font-semibold ${kw.organicRank < kw.prevOrganicRank ? 'text-emerald-600' : 'text-red-500'}`}
                                title={`Was #${kw.prevOrganicRank} at the previous check`}>
                                {kw.organicRank < kw.prevOrganicRank ? '▲' : '▼'}{Math.abs(kw.prevOrganicRank - kw.organicRank)}
                              </span>
                            )}
                            {kw.prevOrganicRank == null && kw.organicRank != null && (
                              <span className="ml-1 text-[10px] font-semibold text-emerald-600" title="Newly ranking — wasn't ranked at the previous check">new</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-300" title={kw.prevOrganicRank != null ? `Dropped out — was #${kw.prevOrganicRank} at the previous check` : 'Not ranking (or not yet measured — ranks come from Jungle Scout research)'}>
                            {kw.prevOrganicRank != null ? `— (was #${kw.prevOrganicRank})` : '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          kw.actionType === 'CRITICAL' ? 'bg-red-100 text-red-700'
                          : kw.actionType === 'UPGRADE' ? 'bg-amber-100 text-amber-700'
                          : kw.actionType === 'REINFORCE' ? 'bg-green-100 text-green-700'
                          : kw.actionType === 'IRRELEVANT' ? 'bg-slate-100 text-slate-500'
                          : 'bg-blue-100 text-blue-700'
                        }`}>{kw.actionType === 'IRRELEVANT' ? 'OFF-PRODUCT' : kw.actionType}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          {kw.inTitle && <span className="text-[9px] bg-blue-50 text-blue-600 px-1 rounded" title="In your Title (checked live against current content)">T</span>}
                          {kw.inBullets && <span className="text-[9px] bg-green-50 text-green-600 px-1 rounded" title="In your Bullets (checked live against current content)">B</span>}
                          {kw.inDescription && <span className="text-[9px] bg-purple-50 text-purple-600 px-1 rounded" title="In your Description (checked live against current content)">D</span>}
                          {kw.inBackend && <span className="text-[9px] bg-slate-100 text-slate-600 px-1 rounded" title="In your Backend search terms (checked live against current content)">K</span>}
                          {!kw.inTitle && !kw.inBullets && !kw.inDescription && !kw.inBackend && (
                            <span className="text-[9px] text-red-500" title="Not found anywhere in your current listing content (checked live) — Regenerate weaves it in, then Ship">nowhere</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100">
                <p className="text-[10px] text-slate-400">Present-In flags are checked live against your current content on every load; Action chips and scores reflect the last research run.</p>
                {(() => {
                  const fullCount = ((kwData as unknown as { allKeywords?: AnalyzedKeyword[] }).allKeywords ?? kwData.topOpportunities).length
                  return fullCount > 20 ? (
                    <button onClick={() => setKwShowAll((v) => !v)}
                      className="shrink-0 text-[11px] font-semibold text-violet-700 hover:text-violet-900 underline underline-offset-2 cursor-pointer"
                      title="The top of this list is sorted by opportunity (gaps first) — your covered niche terms sit further down as DEFENDED.">
                      {kwShowAll ? 'Show top 20' : `Show all ${fullCount} keywords (incl. your covered niche terms)`}
                    </button>
                  ) : null
                })()}
              </div>
            </div>
            <RankAnalysisPanel key={asin} asin={asin} />
            </>
          )}
        </section>
      )}

      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          OUTCOME PANEL (Phase C / spec §5 item 3) — did the pushed copy actually move share?
          Baseline vs current score, snapshots-since-push progress (n/2), the cron's verdict reason,
          a 12-point score-history sparkline, and — for a non_copy_bottleneck — the explicit
          "STOP rewriting — the lever is <reviews/price/ads>" message. Reads listing_outcome_state
          (the single truth, never mirrored) via presentOutcome(). Renders only once there's an epoch.
          ══════════════════════════════════════════════════════════════════════ */}
      {(() => {
        const pres = presentOutcome(outcome)
        const hasTrend = sparkPoints.filter((p) => p.overall_score != null).length >= 2
        if (!pres && !hasTrend) return null // never pushed and no trend → nothing to show
        const baseline = outcome?.baseline_overall_score ?? null
        const current = score?.overall_score ?? null
        const n = Math.min(outcome?.snapshots_since_push ?? 0, MEASURE_TARGET)
        return (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100">
              <Icon.Activity className="w-4 h-4 text-slate-500" />
              <span className="text-sm font-semibold text-slate-900">Outcome</span>
              {pres && (
                <span className={`ml-1 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${pres.chipClass}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${pres.accentClass}`} />
                  {pres.label}
                </span>
              )}
              {outcome?.last_evaluated_at && (
                <span className="ml-auto text-[10px] text-slate-400" title={new Date(outcome.last_evaluated_at).toLocaleString()}>
                  evaluated {relDate(outcome.last_evaluated_at)}
                </span>
              )}
            </div>

            <div className="p-5 space-y-4">
              {/* Top row: baseline vs current + snapshots-since-push progress + sparkline */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Baseline vs current */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Score since push</p>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-bold text-slate-700">{baseline ?? '—'}</span>
                    <span className="text-slate-300">→</span>
                    <span className={`text-lg font-bold ${
                      baseline != null && current != null
                        ? current > baseline ? 'text-emerald-600' : current < baseline ? 'text-red-600' : 'text-slate-700'
                        : 'text-slate-700'
                    }`}>{current ?? '—'}</span>
                    {baseline != null && current != null && current !== baseline && (
                      <span className={`text-[11px] font-semibold ${current > baseline ? 'text-emerald-600' : 'text-red-600'}`}>
                        ({current > baseline ? '+' : ''}{current - baseline})
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">baseline at the epoch → current</p>
                </div>

                {/* Snapshots-since-push progress (n/2) */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Measurement progress</p>
                  <div className="flex items-center gap-1.5 mb-1">
                    {Array.from({ length: MEASURE_TARGET }).map((_, i) => (
                      <span key={i} className={`h-1.5 flex-1 rounded-full ${i < n ? 'bg-sky-500' : 'bg-slate-200'}`} />
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-600 font-medium">{n}/{MEASURE_TARGET} post-push SQP snapshots</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">a new month materializes ~monthly (~2-3mo warm-up)</p>
                </div>

                {/* Sparkline */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Score trend</p>
                  {hasTrend ? (
                    <ScoreSparkline points={sparkPoints} width={180} height={40} showThreshold className="w-full" />
                  ) : (
                    <p className="text-[11px] text-slate-400 mt-2">Not enough history yet — the trend appears after the next score change.</p>
                  )}
                </div>
              </div>

              {/* Verdict reason */}
              {pres && (
                <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                  <p className="text-xs text-slate-700 leading-relaxed">{pres.blurb}</p>
                  {outcome?.verdict_reason && (
                    <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                      <span className="font-semibold text-slate-600">Why:</span> {outcome.verdict_reason}
                    </p>
                  )}
                </div>
              )}

              {/* NON-COPY BOTTLENECK — explicit STOP-rewriting callout naming the lever (spec §5). */}
              {pres?.isNonCopy && (
                <div className="rounded-xl border-2 border-blue-300 bg-blue-50 px-4 py-3 flex items-start gap-3">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-blue-900">
                      STOP rewriting — the lever is <span className="uppercase">{outcome?.non_copy_lever || 'reviews'}</span>
                    </p>
                    <p className="text-xs text-blue-800 mt-1 leading-relaxed">
                      The copy already shipped and keyword share didn&rsquo;t move. More title / bullet / keyword
                      edits won&rsquo;t change the outcome — the bottleneck is{' '}
                      <span className="font-semibold">{outcome?.non_copy_lever || 'reviews'}</span>. Work that lever instead
                      {outcome?.non_copy_lever === 'price' ? ' (price/coupon)' :
                       outcome?.non_copy_lever === 'ads' ? ' (PPC / placement)' :
                       outcome?.non_copy_lever === 'velocity' ? ' (sales velocity / deals)' :
                       ' (reviews / ratings)'}.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ══════════════════════════════════════════════════════════════════════
          CHANGE HISTORY (Phase B / R-UX7) — ONE merged, human-readable timeline:
          listing_change_log ∪ relevant audit_logs ∪ score deltas (when present), time-sorted.
          Each row = actor + plain-English action + when. Legibility is the feature.
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-5 py-3.5 text-left hover:bg-slate-50 transition-colors cursor-pointer">
          <Icon.History className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-semibold text-slate-900">Change history</span>
          {history.length > 0 && (
            <span className="text-[10px] font-medium text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">{history.length}</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); refreshHistory() }}
            className="ml-auto text-[11px] font-medium text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
            title="Refresh">
            Refresh
          </button>
          <Icon.Chevron className={`w-4 h-4 text-slate-400 transition-transform ${historyOpen ? '' : '-rotate-90'}`} />
        </button>
        {historyOpen && (
          <div className="border-t border-slate-100">
            {historyLoading && history.length === 0 ? (
              <p className="px-5 py-6 text-center text-xs text-slate-400">Loading history…</p>
            ) : history.length === 0 ? (
              <p className="px-5 py-6 text-center text-xs text-slate-400">No activity yet. Claims, AI audits, edits, and pushes for this listing will appear here.</p>
            ) : (
              <ol className="divide-y divide-slate-50">
                {history.map((h) => {
                  // Tint the timeline dot by origin: collaboration/edit (violet), push-to-Amazon
                  // (emerald), score delta (amber), compliance/audit (slate).
                  const dot =
                    h.kind === 'audit' ? 'bg-slate-400'
                    : h.kind === 'score' ? 'bg-amber-400'
                    : h.action === 'push' ? 'bg-emerald-500'
                    : 'bg-violet-500'
                  return (
                    <li key={h.id} className="flex items-start gap-3 px-5 py-2.5">
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-slate-700 leading-snug">{h.summary}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5" title={new Date(h.ts).toLocaleString()}>
                          {relDate(h.ts)}
                          <span className="text-slate-300"> · {new Date(h.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          {h.kind === 'audit' && <span className="ml-1.5 text-slate-400">· compliance</span>}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TAKEOVER CONFIRM (Phase B / R-UX4) — 2-step, non-destructive. Step 1 surfaces who is
          active, when, and whether they have UNPUSHED changes; step 2 force-reassigns + logs both ids.
          ══════════════════════════════════════════════════════════════════════ */}
      {takeoverOpen && (
        <ModalShell
          onClose={() => setTakeoverOpen(false)}
          dismissDisabled={claimBusy}
          maxW="max-w-md"
          title={
            <span className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-600 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
              Take over this listing?
            </span>
          }
        >
            <div className="p-5 space-y-3">
              <p className="text-xs text-slate-600">
                <span className="font-semibold text-slate-800">{takeoverInfo?.holderName || 'Someone'}</span>
                {takeoverInfo?.lastActiveIso
                  ? <> was active <span className="font-semibold text-slate-800">{relDate(takeoverInfo.lastActiveIso)}</span>.</>
                  : <> currently holds this claim.</>}
              </p>
              {takeoverInfo?.loading ? (
                <p className="text-xs text-slate-400">Checking for unpushed changes…</p>
              ) : takeoverInfo?.hasUnpushedChanges ? (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                  <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
                  <p className="text-xs text-amber-800">They have <span className="font-semibold">unpushed AI changes</span> (a draft generated since the last push). Taking over does not discard the draft, but coordinate so their work isn&rsquo;t lost.</p>
                </div>
              ) : (
                <p className="text-xs text-slate-500">No unpushed AI changes detected since the last push.</p>
              )}
              <p className="text-[11px] text-slate-400">Taking over reassigns the claim to you and records both names in the change history.</p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-slate-100">
              <button onClick={() => setTakeoverOpen(false)} disabled={claimBusy} className="text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg px-3 py-2 disabled:opacity-50 cursor-pointer">Cancel</button>
              <button onClick={confirmTakeover} disabled={claimBusy} className="text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg px-4 py-2 disabled:opacity-50 cursor-pointer">
                {claimBusy ? 'Taking over…' : 'Take over'}
              </button>
            </div>
        </ModalShell>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          FIX CAPACITY ATTRIBUTE — preview → confirm → live PATCH (same chain as re-link)
          ══════════════════════════════════════════════════════════════════════ */}
      {fixCapTarget && (
        <ModalShell
          onClose={() => setFixCapTarget(null)}
          dismissDisabled={fixCapLoading}
          maxW="max-w-2xl"
          scroll
          title={<>Fix capacity for <span className="font-mono">{fixCapTarget.row.sku}</span></>}
        >
            <div className="p-5">
              <p className="text-xs text-slate-600 mb-3">
                This patches the <span className="font-mono">{fixCapTarget.row.attributeName ?? 'capacity'}</span> attribute via SP-API. We <b>validation-preview first</b> — only an Amazon-validated change reaches Live. Amazon returns ACCEPTED before the change is actually visible, so re-run the capacity check after a few minutes. <b>Heads-up:</b> changing a variation axis value can cause Amazon to re-validate the variation family.
              </p>
              <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                <div className="flex justify-between"><span className="text-slate-500">SKU</span><span className="font-mono">{fixCapTarget.row.sku}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">ASIN</span><span className="font-mono">{fixCapTarget.row.asin}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Attribute</span><span className="font-mono">{fixCapTarget.row.attributeName ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Live (wrong)</span><span className="font-mono text-red-600">{fixCapTarget.row.liveLabel}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Will become</span><span className="font-mono text-emerald-700 font-semibold">{fixCapTarget.row.expectedLabel}</span></div>
              </div>

              {fixCapError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mt-3">{fixCapError}</p>}

              {fixCapPreview && !fixCapResult && (
                <div className={`mt-4 rounded-lg p-3 ${fixCapPreview.ok ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
                  <p className={`text-xs font-semibold ${fixCapPreview.ok ? 'text-emerald-800' : 'text-red-800'}`}>
                    {fixCapPreview.ok ? 'Amazon validated — ready to write.' : 'Amazon rejected the planned change.'}
                  </p>
                  {fixCapPreview.issues.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {fixCapPreview.issues.map((i, idx) => (
                        <li key={idx} className="text-[11px]">
                          <span className={`px-1.5 py-0.5 rounded font-bold mr-1 ${i.severity === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{i.severity}</span>
                          <span className="text-slate-700">{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {fixCapResult && (
                <div className={`mt-4 rounded-lg p-3 ${fixCapResult.submitted ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
                  <p className={`text-xs font-semibold ${fixCapResult.submitted ? 'text-emerald-800' : 'text-red-800'}`}>
                    {fixCapResult.submitted ? 'Submitted to Amazon.' : 'Amazon rejected the capacity fix.'}
                  </p>
                  <p className="text-[11px] text-slate-700 mt-1">{fixCapResult.message}</p>
                  {fixCapResult.submissionId && <p className="text-[11px] text-slate-500 mt-1">submissionId: <span className="font-mono">{fixCapResult.submissionId}</span></p>}
                  {fixCapResult.issues.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {fixCapResult.issues.map((i, idx) => (
                        <li key={idx} className="text-[11px]">
                          <span className={`px-1.5 py-0.5 rounded font-bold mr-1 ${i.severity === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{i.severity}</span>
                          <span className="text-slate-700">{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="mt-5 flex items-center gap-2">
                <button onClick={() => setFixCapTarget(null)} className="text-xs px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer">Cancel</button>
                {!fixCapResult && (
                  <button onClick={previewFixCap} disabled={fixCapLoading}
                    className="text-xs px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-50 cursor-pointer">
                    {fixCapLoading && !fixCapPreview ? 'Validating…' : 'Validate with Amazon'}
                  </button>
                )}
                {fixCapPreview?.ok && !fixCapResult && (
                  <button onClick={confirmFixCap} disabled={fixCapLoading}
                    className="ml-auto text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 cursor-pointer">
                    {fixCapLoading ? 'Writing…' : 'Confirm & Fix'}
                  </button>
                )}
                {fixCapResult && (
                  <button onClick={() => { setFixCapTarget(null); runCapacityCheck() }}
                    className="ml-auto text-xs px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white cursor-pointer">
                    Done (re-check)
                  </button>
                )}
              </div>
            </div>
        </ModalShell>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          RE-LINK ORPHAN — preview (VALIDATION_PREVIEW) → confirm → live PATCH
          ══════════════════════════════════════════════════════════════════════ */}
      {relinkTarget && (
        <ModalShell
          onClose={() => setRelinkTarget(null)}
          dismissDisabled={relinkLoading}
          maxW="max-w-2xl"
          scroll
          title={<>Re-link <span className="font-mono">{relinkTarget.childSku}</span> to a parent</>}
        >
            <div className="p-5">
              <p className="text-xs text-slate-600 mb-3">This writes the variation relationship directly to Amazon. We <b>validation-preview first</b> — only an Amazon-validated change reaches Live. After Live, Amazon returns ACCEPTED before actually applying the change, so confirm via the orphan check again in a few minutes.</p>
              <label className="block text-xs font-medium text-slate-700 mb-1">Target parent SKU</label>
              <input
                type="text" value={relinkParentSku} onChange={(e) => { setRelinkParentSku(e.target.value); setRelinkPreview(null); setRelinkResult(null) }}
                className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono focus:outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-400"
                placeholder="e.g. Memory-Card-P"
              />
              <p className="text-[11px] text-slate-400 mt-1">The parent SKU (not ASIN). Must already exist as a non-buyable variation parent of the same productType.</p>

              {relinkError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mt-3">{relinkError}</p>}

              {/* Preview */}
              {relinkPreview && !relinkResult && (
                <div className={`mt-4 rounded-lg p-3 ${relinkPreview.ok ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
                  <p className={`text-xs font-semibold ${relinkPreview.ok ? 'text-emerald-800' : 'text-red-800'}`}>
                    {relinkPreview.ok ? 'Amazon validated — ready to write.' : 'Amazon rejected the planned change.'}
                  </p>
                  <p className="text-[11px] text-slate-600 mt-1">productType: <span className="font-mono">{relinkPreview.productType}</span> · variation_theme: <span className="font-mono">{relinkPreview.variation_theme ?? '(none from parent)'}</span></p>
                  {relinkPreview.issues.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {relinkPreview.issues.map((i, idx) => (
                        <li key={idx} className="text-[11px]">
                          <span className={`px-1.5 py-0.5 rounded font-bold mr-1 ${i.severity === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{i.severity}</span>
                          <span className="text-slate-700">{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Result */}
              {relinkResult && (
                <div className={`mt-4 rounded-lg p-3 ${relinkResult.submitted ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
                  <p className={`text-xs font-semibold ${relinkResult.submitted ? 'text-emerald-800' : 'text-red-800'}`}>
                    {relinkResult.submitted ? 'Submitted to Amazon.' : 'Amazon rejected the re-link.'}
                  </p>
                  <p className="text-[11px] text-slate-700 mt-1">{relinkResult.message}</p>
                  {relinkResult.submissionId && <p className="text-[11px] text-slate-500 mt-1">submissionId: <span className="font-mono">{relinkResult.submissionId}</span></p>}
                  {relinkResult.issues.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {relinkResult.issues.map((i, idx) => (
                        <li key={idx} className="text-[11px]">
                          <span className={`px-1.5 py-0.5 rounded font-bold mr-1 ${i.severity === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{i.severity}</span>
                          <span className="text-slate-700">{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="mt-5 flex items-center gap-2">
                <button onClick={() => setRelinkTarget(null)} className="text-xs px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer">Cancel</button>
                {!relinkResult && (
                  <button onClick={previewRelink} disabled={relinkLoading || !relinkParentSku}
                    className="text-xs px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-50 cursor-pointer">
                    {relinkLoading && !relinkPreview ? 'Validating…' : 'Validate with Amazon'}
                  </button>
                )}
                {relinkPreview?.ok && !relinkResult && (
                  <button onClick={confirmRelink} disabled={relinkLoading}
                    className="ml-auto text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 cursor-pointer">
                    {relinkLoading ? 'Writing…' : 'Confirm & Re-link'}
                  </button>
                )}
                {relinkResult && (
                  <button onClick={() => { setRelinkTarget(null); runOrphanCheck(); runRelinkStatus() }}
                    className="ml-auto text-xs px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white cursor-pointer">
                    Done (re-check orphans)
                  </button>
                )}
              </div>
            </div>
        </ModalShell>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SHIP CONTENT TO AMAZON — per-section preview → confirm modal
          ══════════════════════════════════════════════════════════════════════ */}
      {/* AUTO PUSH — one confirm, every ready Product-Detail field ships sequentially. */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white">
              <h3 className="text-sm font-bold text-slate-900">Auto Push — Product Details</h3>
              <ModalCloseButton onClick={() => setBulkOpen(false)} title={bulkRunning ? 'Safe to close — Auto Push keeps running in this tab (progress pill bottom-right). Just don’t close the browser tab itself.' : 'Close'} />
            </div>
            <div className="px-5 py-4 space-y-2">
              <p className="text-xs text-slate-500">
                {bulkFinished
                  ? (bulkStreamInterruptedRef.current
                      ? `⚠ INTERRUPTED at ${bulkProgress.done}/${bulkProgress.total} SKUs — the stream dropped before the server finished. SKUs ACCEPTED before the drop stay pushed (Amazon has them). Re-run Auto Push to finish the rest — it’s idempotent, only still-wrong SKUs re-push. Use Verify on Amazon on any field to confirm.`
                      : 'Done. Amazon applies accepted submissions in 15 min – 6 hr; use Verify on Amazon on any field to confirm.')
                  : bulkRunning
                  ? 'Pushing one PATCH per SKU. You can close this — it keeps running in this tab (reopen Auto Push to check progress). Use Stop to halt; already-accepted SKUs stay pushed.'
                  : `These ${bulkItems.length} fields are validated and ready. Each pushes to every variant SKU with the same checks as a manual push — a failure on one never blocks the rest.`}
              </p>
              {/* Overall SKU progress bar (PO request). total = every SKU; done = each SKU's terminal
                  event, so it reaches 100% even when some SKUs were already correct. */}
              {(bulkRunning || (bulkFinished && bulkProgress.total > 0)) && bulkProgress.total > 0 && (
                <div className="mt-1">
                  <div className="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
                    <span className={bulkFinished && bulkStreamInterruptedRef.current ? 'text-amber-700 font-semibold' : ''}>{bulkFinished ? (bulkStreamInterruptedRef.current ? 'Interrupted' : 'Complete') : 'Pushing to Amazon…'}</span>
                    <span>{bulkProgress.done} / {bulkProgress.total} SKUs</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${bulkFinished ? (bulkStreamInterruptedRef.current ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-violet-500'}`}
                      style={{ width: `${Math.round((bulkProgress.done / bulkProgress.total) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {bulkItems.map((it, i) => (
                  <div key={i} className={`flex items-center justify-between gap-3 px-3 py-2 ${it.skip ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={!it.skip}
                        disabled={bulkRunning || bulkFinished}
                        onChange={() => setBulkItems((prev) => { const next = prev.slice(); next[i] = { ...next[i], skip: !next[i].skip }; return next })}
                        className="accent-emerald-600 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-slate-800">{it.field}</p>
                        {/* Editable BEFORE the bulk push (PO: "what if a value is wrong, how do I change it?").
                            Enum fields get a dropdown of Amazon's accepted values; free-text gets an input.
                            The server re-validates/coerces every value (loadDetailContext) — a bad manual
                            value is flagged + skipped, never pushed. */}
                        {bulkRunning || bulkFinished ? (
                          <p className="text-[11px] text-slate-500 truncate">{it.value}</p>
                        ) : it.accepted && it.accepted.length > 0 ? (
                          <select
                            value={it.accepted.some((a) => a === it.value) ? it.value : '__custom__'}
                            onChange={(e) => { const v = e.target.value; if (v !== '__custom__') setBulkItems((prev) => { const n = prev.slice(); n[i] = { ...n[i], value: v }; return n }) }}
                            className="mt-0.5 text-[11px] border border-slate-300 rounded px-1.5 py-0.5 bg-white text-slate-700 max-w-full"
                          >
                            {!it.accepted.includes(it.value) && <option value="__custom__">{it.value} (current)</option>}
                            {it.accepted.map((a) => <option key={a} value={a}>{a}</option>)}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={it.value}
                            onChange={(e) => setBulkItems((prev) => { const n = prev.slice(); n[i] = { ...n[i], value: e.target.value }; return n })}
                            className="mt-0.5 text-[11px] border border-slate-300 rounded px-1.5 py-0.5 bg-white text-slate-700 w-full"
                          />
                        )}
                      </span>
                    </div>
                    {/* Long error/held notes WRAP in their own column instead of overflowing
                        across the field label (the 502 message was painting over the rows). */}
                    <span className={`text-[10px] font-semibold shrink-0 max-w-[55%] text-right ${
                      it.status === 'done' ? 'text-emerald-600' : it.status === 'failed' ? 'text-red-600' : it.status === 'pushing' ? 'text-violet-600 animate-pulse' : 'text-slate-400'
                    }`}>
                      {it.status === 'ready'
                        ? (it.note ? <span className="block whitespace-normal break-words font-normal">{it.note}</span> : 'Ready')
                        : it.status === 'pushing' ? 'Pushing…'
                        : it.status === 'done' ? `✓ ${it.note ?? 'Pushed'}`
                        : <span className="block whitespace-normal break-words">✗ {it.note ?? 'Failed'}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 sticky bottom-0 bg-white">
              <button onClick={() => setBulkOpen(false)} className="text-xs text-slate-600 hover:text-slate-800 px-3 py-1.5">
                {bulkFinished ? 'Close' : bulkRunning ? 'Hide (keeps running)' : 'Cancel'}
              </button>
              {bulkRunning && (
                <button onClick={stopBulkPush} disabled={cancelRequested} className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60 font-medium">
                  {cancelRequested ? 'Stopping…' : '■ Stop'}
                </button>
              )}
              {!bulkFinished && (
                <button
                  onClick={runBulkPush}
                  disabled={bulkRunning || bulkItems.filter((it) => !it.skip).length === 0}
                  className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded-lg font-semibold disabled:opacity-50"
                >
                  {bulkRunning ? 'Pushing… (one PATCH per SKU)' : `Push ${bulkItems.filter((it) => !it.skip).length} field${bulkItems.filter((it) => !it.skip).length === 1 ? '' : 's'} to Amazon →`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* SHIP ALL CORE — progress + result (element C). Mirrors the Auto Push modal, minimal (no
          per-field editing — the values are the confirmed core recommendations). */}
      {coreBulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white">
              <h3 className="text-sm font-bold text-slate-900">Ship all core — Title · Bullets · Description · Keywords</h3>
              <ModalCloseButton onClick={() => setCoreBulkOpen(false)} title={coreBulkRunning ? 'Safe to close — the push keeps running in this tab (progress pill bottom-right). Don’t close the browser tab.' : 'Close'} />
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-slate-500">
                {coreBulkFinished
                  ? (coreBulkInterruptedRef.current
                      ? '⚠ Interrupted before completion. Already-accepted SKUs stay pushed — re-run Ship all core to finish the rest (idempotent). Use Verify live to confirm.'
                      : (coreBulkMessage || 'Done. Amazon applies accepted submissions in 15–30 min; use Verify live to confirm.'))
                  : coreBulkRunning
                  ? 'Shipping one PATCH per SKU (Title + Bullets + Description broadcast to every child; Keywords per child). You can close this — it keeps running in this tab (reopen from the pill, bottom-right).'
                  : 'Ships every confirmed core field to every live child SKU in one PATCH each. The non-buyable variation parent is skipped; each field still gets full Amazon validation.'}
              </p>
              {/* Overall SKU progress bar. total = every SKU; done = each SKU's terminal event. */}
              {(coreBulkRunning || (coreBulkFinished && coreBulkProgress.total > 0)) && coreBulkProgress.total > 0 && (
                <div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
                    <span className={coreBulkFinished && coreBulkInterruptedRef.current ? 'text-amber-700 font-semibold' : ''}>{coreBulkFinished ? (coreBulkInterruptedRef.current ? 'Interrupted' : 'Complete') : 'Shipping to Amazon…'}</span>
                    <span>{coreBulkProgress.done} / {coreBulkProgress.total} SKUs</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${coreBulkFinished ? (coreBulkInterruptedRef.current ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-violet-500'}`}
                      style={{ width: `${Math.round((coreBulkProgress.done / coreBulkProgress.total) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              {coreBulkPerField.length > 0 && (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {coreBulkPerField.map((pf, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-xs font-semibold text-slate-800">{pf.field}</span>
                      <span className={`text-[10px] font-semibold shrink-0 ${pf.failed === 0 && pf.accepted > 0 ? 'text-emerald-600' : pf.failed > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                        {pf.accepted > 0 ? `✓ ${pf.accepted} SKU${pf.accepted === 1 ? '' : 's'}` : ''}{pf.failed > 0 ? ` · ✗ ${pf.failed} failed` : ''}{pf.accepted === 0 && pf.failed === 0 ? 'Already up to date' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 sticky bottom-0 bg-white">
              <button onClick={() => setCoreBulkOpen(false)} className="text-xs text-slate-600 hover:text-slate-800 px-3 py-1.5">
                {coreBulkFinished ? 'Close' : coreBulkRunning ? 'Hide (keeps running)' : 'Cancel'}
              </button>
              {coreBulkRunning && (
                <button onClick={stopCoreBulkPush} disabled={cancelRequested} className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60 font-medium">
                  {cancelRequested ? 'Stopping…' : '■ Stop'}
                </button>
              )}
              {!coreBulkRunning && !coreBulkFinished && (
                <button onClick={runCoreBulkPush} className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded-lg font-semibold">
                  Ship all core →
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Floating push pill — the push fetch lives in the PAGE's JS, not the modal, so the
          modal can close while the stream keeps running (PO: "an employee needs to watch an
          item send for 5 min"). Within-tab navigation is safe; only closing the browser TAB
          kills the stream (guarded by beforeunload below). */}
      {((pushLoading && !showPushModal) || (bulkRunning && !bulkOpen) || (coreBulkRunning && !coreBulkOpen)) && (
        <button
          onClick={() => (coreBulkRunning && !coreBulkOpen ? setCoreBulkOpen(true) : bulkRunning && !bulkOpen ? setBulkOpen(true) : setShowPushModal(true))}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-full shadow-lg"
          title="A push is still running in this tab — click to view progress. Keep this browser tab open until it finishes."
        >
          <span className="animate-spin w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" />
          {coreBulkRunning && !coreBulkOpen
            ? `Shipping all core… ${coreBulkProgress.done}/${coreBulkProgress.total} SKUs`
            : bulkRunning && !bulkOpen
            ? `Auto Push running… ${bulkItems.filter((i) => i.status === 'done' || i.status === 'failed').length}/${bulkItems.filter((i) => !i.skip).length} fields`
            : `Pushing ${pushField === 'details' && pushDetailField ? pushDetailField : FIELD_LABEL[pushField]}… ${pushProgress.filter((p) => p.status === 'accepted').length} accepted`}
          <span className="underline decoration-dotted underline-offset-2">view</span>
        </button>
      )}
      {showPushModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <Icon.Send className="w-4 h-4 text-emerald-600" />
                {pushField === 'details' && pushDetailField
                  ? <>Ship Detail · <span className="font-semibold">{pushDetailField}</span> to Amazon</>
                  : <>Ship {FIELD_LABEL[pushField]} to Amazon</>}
                {pushField === 'details' && pushPreview?.attribute_key && (
                  <span className="text-[10px] text-slate-500 font-mono ml-1">/attributes/{pushPreview.attribute_key}</span>
                )}
              </h3>
              <ModalCloseButton
                onClick={() => setShowPushModal(false)}
                title={pushLoading ? 'Safe to close — the push keeps running in this tab (a progress pill appears bottom-right). Just don’t close the browser tab itself.' : 'Close'}
              />
            </div>

            <div className="p-5">
              {pushError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">{pushError}</p>}
              {/* The error copy says "use Verify on Amazon" — give the seller that button RIGHT
                  HERE (the full verify panel lives in the preview view, which may not be rendered
                  in an early-failure state — PO hit a 502 during a deploy and had no way to act). */}
              {pushError && !pushResults && (
                <div className="mb-3 -mt-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={runVerify}
                      disabled={verifyLoading}
                      className="text-xs px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50">
                      {verifyLoading ? 'Checking Amazon live…' : 'Verify on Amazon — did it apply?'}
                    </button>
                    <button onClick={() => setShowPushModal(false)} className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
                  </div>
                  {verifyError && <p className="text-xs text-red-600 mt-1.5">{verifyError}</p>}
                  {verifyResults && (
                    <p className="text-xs text-slate-700 mt-1.5 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                      <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-green-500" /> <b>{verifyResults.matched}</b> applied</span>
                      {(verifyResults.inherited ?? 0) > 0 && <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-sky-500" /> <b>{verifyResults.inherited}</b> inherited</span>}
                      <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-amber-500" /> <b>{verifyResults.stale}</b> stale</span>
                      {verifyResults.stale > 0
                        ? '— reopen this Ship button: it will offer "Push just the stale" so nothing is double-submitted.'
                        : '— everything landed; no retry needed.'}
                    </p>
                  )}
                </div>
              )}

              {pushLoading && !pushResults && (
                <div className="py-4">
                  <div className="text-center mb-3">
                    <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full mx-auto mb-2" />
                    <p className="text-sm text-slate-500">
                      {pushPhase === 'rescoring' ? 'Re-scoring listing…'
                        : pushPhase === 'pushing' ? 'Streaming pushes to Amazon — one SKU at a time…'
                        : pushPhase === 'starting' ? 'Connecting to Amazon…'
                        : pushPreview ? 'Pushing to Amazon…'
                        : 'Loading preview…'}
                    </p>
                    {(pushPhase === 'pushing' || pushPhase === 'starting') && (
                      <p className="text-[10px] text-slate-400 mt-1">
                        You can <b>close this and keep working</b> — the push continues in this tab (progress pill bottom-right). Just don&apos;t close the browser tab; if it drops anyway, already-accepted SKUs stay pushed — re-open and use <b>Verify on Amazon</b> → <b>Push just the stale</b>.
                      </p>
                    )}
                    {/* PO: "NO way to cancel when it starts" — server-side stop between SKUs.
                        Already-accepted SKUs stay pushed (Amazon has them); the rest untouched. */}
                    {(pushPhase === 'pushing' || pushPhase === 'starting') && (
                      <button
                        onClick={stopPush}
                        disabled={cancelRequested}
                        className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60 font-medium"
                      >
                        {cancelRequested ? 'Stopping after the current SKU…' : '■ Stop push'}
                      </button>
                    )}
                  </div>
                  {/* Live per-SKU stream — visible during the push, kept after on success
                       so the seller can scroll back to see what each SKU did. The stream
                       eliminates the proxy-502 failure mode by keeping the connection
                       warm with one event per SKU (250ms each). */}
                  {pushProgress.length > 0 && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 max-w-md mx-auto">
                      <p className="text-[10px] font-semibold text-slate-600 uppercase mb-1.5">Per-SKU progress · {pushProgress.filter(p => p.status === 'accepted').length} accepted · {pushProgress.filter(p => p.status === 'failed').length} failed · {pushProgress.filter(p => p.status === 'validating').length} pending</p>
                      <div className="border border-slate-200 rounded divide-y divide-slate-100 max-h-[35vh] overflow-y-auto bg-white">
                        {pushProgress.map((p) => (
                          <div key={p.sku} className="px-2 py-1.5 text-[11px] flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              p.status === 'accepted' ? 'bg-green-100 text-green-700'
                              : p.status === 'failed' ? 'bg-red-100 text-red-700'
                              : 'bg-slate-100 text-slate-600'
                            }`}>
                              {p.status === 'accepted' ? '✓ accepted' : p.status === 'failed' ? '✗ failed' : '⏳ validating'}
                            </span>
                            <span className="font-mono text-slate-700 flex-1 min-w-0 truncate">{p.sku}</span>
                            {p.error && <span className="text-[10px] text-red-600 truncate">{p.error.slice(0, 60)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Preview (pre-confirm) */}
              {pushPreview && !pushResults && !pushLoading && (
                <>
                  {/* Scope banner — Parent (broadcast, same to all) vs Per-child (unique each) */}
                  {pushPreview.broadcast ? (
                    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 mb-3">
                      <p className="text-xs text-indigo-900 leading-relaxed">
                        <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-semibold mr-1.5 whitespace-nowrap">Parent</span>
                        {pushPreview.field === 'details' ? (
                          <>The same <b>{pushPreview.detail_field}</b> value is written to <b>all {pushPreview.count}</b> SKUs (each ASIN&apos;s FBA + FBM + the variation parent).{' '}
                          <b>{displayChanged}</b> currently differ and will change.</>
                        ) : (
                          <>The same {pushPreview.label.toLowerCase()} is written to <b>all {pushPreview.count}</b> SKUs — including each ASIN&apos;s matching FBA + FBM.{' '}
                          <b>{displayChanged}</b> currently differ and will change.</>
                        )}
                      </p>
                    </div>
                  ) : (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
                      <p className="text-xs text-amber-900 leading-relaxed">
                        <span className="px-1.5 py-0.5 rounded bg-amber-600 text-white font-semibold mr-1.5 whitespace-nowrap">Per-child</span>
                        {pushPreview.field === 'keywords'
                          ? <>Each of <b>{pushPreview.count}</b> SKUs (incl. matching FBA + FBM) gets its <b>own</b> backend search terms. <b>{pushPreview.changed}</b> will change — not customer-visible.</>
                          : pushPreview.field === 'title'
                          ? <>Each of <b>{pushPreview.count}</b> SKUs gets its <b>own</b> title — different SKUs get different titles (e.g. each capacity variant carries its own GB). Review each row below before confirming. <b>{pushPreview.changed}</b> will change.</>
                          : <>Each of <b>{pushPreview.count}</b> SKUs gets its <b>own</b> {pushPreview.label.toLowerCase()}. Review each row below. <b>{pushPreview.changed}</b> will change.</>}
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-slate-500 mb-3">
                    Every value is checked with Amazon (VALIDATION_PREVIEW) before any live write, and the previous value is saved for rollback.
                    {pushPreview.field === 'keywords' && ' Backend strings are capped at 250 bytes.'}
                  </p>

                  {lateralKeywordAdvisory && (
                    <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 mb-3 flex gap-2">
                      <svg className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                      </svg>
                      <p className="text-xs text-sky-900 leading-relaxed">
                        <b>Mostly lateral (~{lateralKeywordAdvisory.pct}% of terms unchanged).</b> These SKUs are already at full strength (≥200 chars, ≤250 bytes), so the high-traffic terms are already indexed — pushing is <b>unlikely to move your keyword score</b>. Skim the changed rows below: push only if a <i>major</i> missing keyword is being added. To actually lift the score, make sure the missing top keywords are indexed somewhere Amazon reads — the <b>backend keyword field</b> is the sanctioned home for high-value terms that don’t fit naturally in the title or bullets, so a Regenerate that re-fills the backend with them is what moves the needle here.
                      </p>
                    </div>
                  )}

                  {pushPreview.broadcast ? (
                    /* Broadcast: show the single new value once, then which children currently differ */
                    <>
                      <div className="bg-white rounded-md border-2 border-emerald-300 p-3 mb-3">
                        <p className="text-[10px] font-bold text-emerald-800 uppercase mb-1.5 flex items-center gap-1.5 flex-wrap">
                          {pushPreview.field === 'details' && pushPreview.detail_field
                            ? <>New {pushPreview.detail_field} → all {pushPreview.count} SKUs</>
                            : <>New {pushPreview.label.toLowerCase()} → all {pushPreview.count} SKUs</>}
                          {pushPreview.field === 'title' && aiRecs?.title_source === 'manual' && (
                            <span className="inline-flex items-center gap-1 normal-case bg-violet-100 text-violet-700 border border-violet-200 rounded px-1.5 py-0.5 text-[9px] font-semibold"
                                  title="This is your manually pushed title. It's locked — an AI Audit or Regenerate won't overwrite it. Use 'Regenerate title' to replace it.">
                              ✏️ Your title (locked)
                            </span>
                          )}
                        </p>
                        {pushPreview.field === 'bullets' && Array.isArray(pushPreview.proposedValue) ? (
                          <ul className="list-disc pl-5 space-y-1">
                            {pushPreview.proposedValue.map((b, i) => <li key={i} className="text-xs text-slate-800 break-words">{b}</li>)}
                          </ul>
                        ) : pushPreview.field === 'description' ? (
                          <div className="text-xs text-slate-800 max-h-56 overflow-y-auto leading-relaxed [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_b]:font-semibold"
                               dangerouslySetInnerHTML={{ __html: String(pushPreview.proposedValue ?? '') }} />
                        ) : pushPreview.field === 'title' ? (
                          /* Manual title editor — type/keep/rewrite the title, score it, push YOUR version */
                          <div className="space-y-2">
                            <textarea
                              value={editTitle}
                              onChange={(e) => { setEditTitle(e.target.value); setTitleScore(null) }}
                              rows={3}
                              maxLength={200}
                              className="w-full text-xs text-slate-900 border border-slate-300 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400 resize-y"
                              placeholder="Type or edit the title to push to all SKUs…"
                            />
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[10px] font-medium ${editTitle.length > 200 ? 'text-red-600' : editTitle.length > 75 || (editTitle.length > 0 && editTitle.length < 50) ? 'text-amber-600' : 'text-slate-500'}`}>
                                {editTitle.length}/75 chars{editTitle.length > 75 ? ' · over Amazon’s NEW 75-char limit (Jul 27, 2026 — auto-rewritten after that)' : editTitle.length > 0 && editTitle.length < 50 ? ' · under 50 — room for your top keyword' : ''}
                              </span>
                              <button onClick={() => scoreTitle(editTitle)} disabled={titleScoreLoading || !editTitle.trim()}
                                className="text-[10px] bg-slate-700 hover:bg-slate-800 text-white px-2 py-0.5 rounded font-medium disabled:opacity-50">
                                {titleScoreLoading ? 'Scoring…' : 'Check score + Amazon rules'}
                              </button>
                            </div>
                            {titleScore && (
                              <div className={`text-[11px] rounded-md p-2 border ${titleScore.suppressionRisk ? 'bg-red-50 border-red-200' : titleScore.titleScore >= 23 ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                                <p className="font-semibold text-slate-800">Title score: {titleScore.titleScore}/{titleScore.maxTitleScore} · overall would be {titleScore.overallScore}/100</p>
                                {titleScore.suppressionRisk && <p className="text-red-700 font-semibold mt-1">🚫 Amazon-policy risk — fix before pushing:</p>}
                                {titleScore.ruleProblems.length > 0 ? (
                                  <ul className="list-disc pl-4 mt-1 space-y-0.5 text-slate-700">
                                    {titleScore.ruleProblems.slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}
                                  </ul>
                                ) : <p className="text-emerald-700 mt-1">✓ No Amazon-rule violations.</p>}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-800 break-words whitespace-pre-wrap">{pushPreview.field === 'details' ? prettyDetailValue(String(pushPreview.proposedValue ?? ''), pushPreview.acceptedValues ?? undefined) : String(pushPreview.proposedValue ?? '')}</p>
                        )}
                      </div>
                      {/* Feature B — show Amazon's accepted vocabulary for enum attributes so the
                          seller can see the system knows the valid terms (and what we normalized). */}
                      {pushPreview.field === 'details' && pushPreview.acceptedValues && pushPreview.acceptedValues.length > 0 && (
                        pushPreview.enum_invalid ? (
                          /* Part 2b — uncoercible dropdown: the seller PICKS the correct accepted value. */
                          <div className="bg-amber-50 border border-amber-300 rounded-md p-2.5 mb-3">
                            <p className="text-[11px] text-amber-900 mb-1.5">
                              <span className="font-bold">“{String(pushPreview.proposedValue ?? '')}” isn’t an accepted Amazon value</span> for {pushPreview.detail_field}. Pick the correct one — that’s what gets pushed:
                            </p>
                            <div className="flex flex-wrap gap-1">
                              {pushPreview.acceptedValues.map((v, i) => (
                                <button
                                  key={i}
                                  onClick={() => setDetailOverride(v)}
                                  className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${detailOverride === v ? 'bg-emerald-600 border-emerald-600 text-white font-semibold' : 'bg-white border-slate-300 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'}`}
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                            {detailOverride && <p className="text-[11px] text-emerald-700 mt-1.5 font-medium">Will push: {detailOverride}</p>}
                          </div>
                        ) : (
                          /* Valid enum — the chips are STILL a picker (PO: "I can't choose/change any
                             of the other values if I want, WHY?"). Clicking a different accepted value
                             overrides what ships; clicking the recommended one clears the override.
                             The server re-validates + re-coerces the override and recompares every
                             SKU against it at push time, so the preview counts can't mislead. */
                          <div className="bg-sky-50 border border-sky-200 rounded-md p-2.5 mb-3">
                            {pushPreview.normalizedFrom && (
                              <p className="text-[11px] text-sky-900 mb-1.5">
                                Normalized <span className="font-mono line-through text-slate-500">{pushPreview.normalizedFrom}</span> → <span className="font-mono font-semibold text-emerald-700">{prettyDetailValue(String(pushPreview.proposedValue ?? ''), pushPreview.acceptedValues)}</span> to match Amazon&apos;s accepted terms.
                              </p>
                            )}
                            <p className="text-[10px] text-sky-800 font-bold uppercase mb-1">Amazon accepts — click a value to push it instead</p>
                            <div className="flex flex-wrap gap-1">
                              {pushPreview.acceptedValues.map((v, i) => {
                                const isRecommended = squashEnumVal(v) === squashEnumVal(String(pushPreview.proposedValue ?? ''))
                                const isChosen = detailOverride ? detailOverride === v : isRecommended
                                return (
                                  <button
                                    key={i}
                                    onClick={() => setDetailOverride(isRecommended ? '' : v)}
                                    title={isRecommended ? 'The recommended value' : `Push “${v}” to every SKU instead`}
                                    className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${isChosen ? 'bg-emerald-600 border-emerald-600 text-white font-semibold' : 'bg-white border-slate-300 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'}`}
                                  >
                                    {v}
                                  </button>
                                )
                              })}
                            </div>
                            {detailOverride.trim() !== '' && squashEnumVal(detailOverride) !== squashEnumVal(String(pushPreview.proposedValue ?? '')) && (
                              <p className="text-[11px] text-emerald-700 mt-1.5 font-medium">Will push: {detailOverride} — every SKU is re-compared against this value at push time.</p>
                            )}
                          </div>
                        )
                      )}
                      {pushPreview.changed > 0 && (
                        <details className="mb-4">
                          <summary className="text-xs text-slate-600 cursor-pointer hover:text-slate-800">
                            {pushPreview.changed} of {pushPreview.count} SKUs currently differ — view which
                          </summary>
                          <div className="mt-2 border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[35vh] overflow-y-auto">
                            {pushPreview.diff.filter(d => d.changed).map((d) => (
                              <div key={d.sku} className="p-2.5 text-xs">
                                <div className="font-mono text-slate-700 mb-0.5">{d.sku}</div>
                                <p className="text-slate-400 line-through break-words">{d.current || '(empty)'}</p>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </>
                  ) : (
                    /* Per-child: full current → proposed diff per SKU. Sort parent row to the top,
                       then by SKU for stable ordering, so the modal mirrors the section card above. */
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 mb-4 max-h-[45vh] overflow-y-auto">
                      {pushPreview.diff
                        .filter(d => d.changed)
                        .slice()
                        .sort((a, b) => (a.isParent ? -1 : b.isParent ? 1 : a.sku.localeCompare(b.sku)))
                        .map((d) => {
                        // Field-aware size readout: keywords are byte-capped (250B), titles char-capped
                        // (~200), description char-capped (~2000). Show the meaningful unit per field.
                        const sizeLabel = pushPreview.field === 'keywords' ? `${d.bytes}/250 bytes`
                          : pushPreview.field === 'title' ? `${d.chars}/200 chars`
                          : pushPreview.field === 'description' ? `${d.chars} chars`
                          : `${d.chars} chars`
                        return (
                          <div key={d.sku} className={`p-3 text-xs ${d.isParent ? 'bg-violet-50' : ''}`}>
                            <div className="font-mono text-slate-700 mb-1 flex items-center gap-2">
                              {d.isParent && <span className="text-[10px] font-bold text-violet-700 uppercase tracking-wide bg-violet-100 px-1.5 py-0.5 rounded">PARENT</span>}
                              <span>{d.sku}</span>
                              <span className="text-slate-400">({sizeLabel})</span>
                            </div>
                            <p className="text-slate-400 line-through mb-0.5 break-words">{(pushPreview.field === 'details' ? prettyDetailValue(d.current) : d.current) || '(empty — Amazon will validate the new value)'}</p>
                            <p className={`break-words ${d.isParent ? 'text-violet-800' : 'text-emerald-700'}`}>{pushPreview.field === 'details' ? prettyDetailValue(d.proposed) : d.proposed}</p>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* ── Verify on Amazon (also on preview, so a seller who pushed earlier
                       can check "did Amazon apply it?" without re-pushing). Shows when
                       changed === 0 (cache matches rec → push was Accepted earlier) too. */}
                  <div className="mb-3 -mt-1">
                    <button
                      onClick={runVerify}
                      disabled={verifyLoading}
                      className="text-xs text-indigo-700 hover:text-indigo-900 underline disabled:opacity-50"
                    >
                      {verifyLoading ? 'Checking Amazon live…' : verifyResults ? 'Re-check Amazon live' : 'Verify on Amazon → is it actually applied?'}
                    </button>
                    {verifyError && <p className="text-xs text-red-600 mt-1">{verifyError}</p>}
                    {verifyResults && (
                      <div className="mt-2 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                        <p className="text-xs text-slate-700 mb-1.5">
                          <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-green-500" /> <b>{verifyResults.matched}</b> applied</span>
                          {(verifyResults.inherited ?? 0) > 0 && <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-sky-500" /> <b>{verifyResults.inherited}</b> inherited</span>}
                          {(verifyResults.unverifiable ?? 0) > 0 && <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-slate-400" /> <b>{verifyResults.unverifiable}</b> couldn&apos;t read</span>}
                      <span className="inline-flex items-center gap-1 mr-3"><span className="w-2 h-2 rounded-full bg-amber-500" /> <b>{verifyResults.stale}</b> stale</span>
                          <span className="text-slate-500">· {verifyResults.total} SKUs checked</span>
                        </p>
                        {verifyResults.stale > 0 && pushField !== 'details' && (
                          <button
                            onClick={() => confirmPush(verifyResults.results.filter((v) => !v.matches && !v.inherited && !v.readFailed && v.expected).map((v) => v.sku))}
                            disabled={pushLoading}
                            className="mb-2 text-[11px] bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 rounded-md font-medium disabled:opacity-50"
                          >
                            Push just the {verifyResults.stale} stale SKU{verifyResults.stale === 1 ? '' : 's'} → (skips the {verifyResults.matched} already applied)
                          </button>
                        )}
                        <div className="border border-slate-200 rounded divide-y divide-slate-100 max-h-[25vh] overflow-y-auto bg-white">
                          {verifyResults.results.map((v) => (
                            <div key={v.sku} className={`px-2 py-1.5 text-[11px] flex items-center gap-2 ${v.isParent ? 'bg-violet-50' : ''}`}>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${v.matches ? 'bg-green-100 text-green-700' : v.inherited ? 'bg-sky-100 text-sky-700' : v.isParent ? 'bg-violet-100 text-violet-700' : v.readFailed ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>
                                {v.matches ? '✓ applied' : v.inherited ? '✓ inherited' : v.isParent ? 'skipped (hub)' : v.readFailed ? "couldn't read" : 'stale'}
                              </span>
                              <span className="font-mono text-slate-700">{v.sku}</span>
                              {v.isParent && <span className="text-[10px] px-1 rounded bg-violet-200 text-violet-800">PARENT</span>}
                              {v.lastUpdatedDate && (
                                <span className="text-[10px] text-slate-400 ml-auto whitespace-nowrap">{new Date(v.lastUpdatedDate).toLocaleString()}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end gap-2">
                    <button onClick={() => setShowPushModal(false)} className="text-xs px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
                    {/* Server-side queue (PR #184): runs on the server, survives tab close + deploys;
                        the global status bar (bottom of every page) tracks it. Same body as Confirm & Ship. */}
                    <button onClick={() => queueBackgroundPush(pushField === 'details' ? (detailOverride.trim() || undefined) : undefined)}
                      disabled={queueLoading || (pushField === 'title' && pushPreview.broadcast ? (!editTitle.trim() || displayChanged === 0) : pushField === 'details' ? (pushPreview.enum_invalid ? !detailOverride.trim() : (detailOverride.trim() ? false : pushPreview.changed === 0)) : pushPreview.changed === 0)}
                      title="Runs on the server — safe to close this tab. Track it in the status bar at the bottom of any page."
                      className="text-xs px-4 py-2 rounded-lg border border-emerald-600 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                      {queueLoading ? 'Queueing…' : 'Queue in background'}
                    </button>
                    <button onClick={() => confirmPush(undefined, pushField === 'details' ? (detailOverride.trim() || undefined) : undefined)}
                      disabled={pushField === 'title' && pushPreview.broadcast ? (!editTitle.trim() || displayChanged === 0) : pushField === 'details' ? (pushPreview.enum_invalid ? !detailOverride.trim() : (detailOverride.trim() ? false : pushPreview.changed === 0)) : pushPreview.changed === 0}
                      className="text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50">
                      {pushField === 'title' && pushPreview.broadcast
                        ? (displayChanged === 0
                            ? 'All variants already have this title'
                            : <>Push this title to {displayChanged} variant{displayChanged !== 1 ? 's' : ''} that need it</>)
                        : pushField === 'details' && detailOverride.trim() && !pushPreview.enum_invalid
                        ? <>Confirm &amp; Ship {pushPreview.detail_field} = “{detailOverride}” to all SKUs</>
                        : <>Confirm &amp; Ship {pushPreview.field === 'details' && pushPreview.detail_field
                            ? pushPreview.detail_field
                            : pushPreview.label.toLowerCase()} to {pushPreview.changed} SKU{pushPreview.changed !== 1 ? 's' : ''}</>}
                    </button>
                  </div>
                </>
              )}

              {/* Results (post-push) */}
              {pushResults && (
                <>
                  <p className="text-sm text-slate-800 mb-3">{pushResults.message}</p>
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 mb-4 max-h-[40vh] overflow-y-auto">
                    {pushResults.results.map((r) => {
                      // Live-notice: the parent hub's rejection is NOT a red dead-end when a self-heal
                      // was scheduled — render it as an informational violet row (the system fixes it;
                      // re-pushing won't help) and demote the technical Amazon error to a secondary line.
                      const healRow = !!pushResults.healScheduled && !!r.isParent && r.status === 'failed'
                      return (
                        <div key={r.sku} className={`p-2.5 text-xs ${healRow ? 'bg-violet-50' : ''}`}>
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.status === 'accepted' ? 'bg-green-100 text-green-700' : healRow ? 'bg-violet-100 text-violet-700' : 'bg-red-100 text-red-700'}`}>{healRow ? 'self-heal scheduled' : r.status}</span>
                            <span className="font-mono text-slate-700">{r.sku}</span>
                            {!healRow && r.error && <span className="text-red-600 truncate">{r.error}</span>}
                          </div>
                          {healRow && (
                            <>
                              <p className="text-[11px] text-violet-900 mt-1">Self-heal scheduled - {(pushResults.healAttrs ?? []).join(', ') || 'the missing parent values'} will be inherited from a live child within ~5 min. No action needed.</p>
                              {r.error && <p className="text-[10px] text-slate-500 mt-0.5 break-words" title={r.error}>Amazon: {r.error}</p>}
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Verify on Amazon (live getListingsItem per SKU) ─────────────────
                       Amazon returns ACCEPTED, not "applied". This calls /verify-push to
                       read the LIVE attribute and tell the seller whether each SKU is
                       APPLIED, STALE (Amazon still processing or rejected), or matches. */}
                  <div className="mb-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="text-xs text-slate-700">
                        <span className="font-semibold">Did Amazon apply it?</span>{' '}
                        <span className="text-slate-500">Submissions are ACCEPTED, then processed asynchronously (15min–6hr for variation families). Check what&apos;s actually live:</span>
                      </div>
                      <button
                        onClick={runVerify}
                        disabled={verifyLoading}
                        className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 whitespace-nowrap"
                      >
                        {verifyLoading ? 'Checking Amazon…' : verifyResults ? 'Re-check live' : 'Verify on Amazon →'}
                      </button>
                    </div>
                    {verifyError && <p className="text-xs text-red-600 mt-2">{verifyError}</p>}
                    {verifyResults && (
                      <div className="mt-3">
                        <p className="text-xs text-slate-700 mb-2">
                          <span className="inline-flex items-center gap-1 mr-3">
                            <span className="w-2 h-2 rounded-full bg-green-500" /> <b>{verifyResults.matched}</b> applied
                          </span>
                          {(verifyResults.inherited ?? 0) > 0 && (
                            <span className="inline-flex items-center gap-1 mr-3">
                              <span className="w-2 h-2 rounded-full bg-sky-500" /> <b>{verifyResults.inherited}</b> inherited (child uses the parent title)
                            </span>
                          )}
                          {(verifyResults.unverifiable ?? 0) > 0 && (
                            <span className="inline-flex items-center gap-1 mr-3">
                              <span className="w-2 h-2 rounded-full bg-slate-400" /> <b>{verifyResults.unverifiable}</b> couldn&apos;t read (Amazon throttled the check — re-check live)
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 mr-3">
                            <span className="w-2 h-2 rounded-full bg-amber-500" /> <b>{verifyResults.stale}</b> still stale (Amazon processing or rejected)
                          </span>
                          {(verifyResults.unknown ?? 0) > 0 && (
                            <span className="inline-flex items-center gap-1 mr-3">
                              <span className="w-2 h-2 rounded-full bg-slate-400" /> <b>{verifyResults.unknown}</b> no expectation (nothing pushed or recommended to compare)
                            </span>
                          )}
                          <span className="text-slate-500">· {verifyResults.total} SKUs checked{verifyResults.attribute_key ? ` · /attributes/${verifyResults.attribute_key}` : ''}</span>
                        </p>
                        {verifyResults.stale > 0 && pushField !== 'details' && (
                          <button
                            onClick={() => confirmPush(verifyResults.results.filter((v) => !v.matches && !v.inherited && !v.readFailed && v.expected).map((v) => v.sku))}
                            disabled={pushLoading}
                            className="mb-2 text-[11px] bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 rounded-md font-medium disabled:opacity-50"
                          >
                            Push just the {verifyResults.stale} stale SKU{verifyResults.stale === 1 ? '' : 's'} → (skips the {verifyResults.matched} already applied)
                          </button>
                        )}
                        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[35vh] overflow-y-auto bg-white">
                          {verifyResults.results.map((v) => (
                            <div key={v.sku} className={`p-2.5 text-xs ${v.isParent ? 'bg-violet-50' : ''}`}>
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${v.matches ? 'bg-green-100 text-green-700' : v.inherited ? 'bg-sky-100 text-sky-700' : v.isParent ? 'bg-violet-100 text-violet-700' : v.readFailed ? 'bg-slate-100 text-slate-500' : v.expected ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                                  {v.matches ? '✓ applied' : v.inherited ? '✓ inherited' : v.isParent ? 'skipped (hub)' : v.readFailed ? "couldn't read" : v.expected ? 'stale' : 'no expectation'}
                                </span>
                                <span className="font-mono text-slate-700">{v.sku}</span>
                                {v.isParent && <span className="text-[10px] px-1 rounded bg-violet-200 text-violet-800">PARENT</span>}
                                {v.lastUpdatedDate && (
                                  <span className="text-[10px] text-slate-400 ml-auto">
                                    Amazon updated {new Date(v.lastUpdatedDate).toLocaleString()}
                                  </span>
                                )}
                              </div>
                              {!v.matches && (
                                <div className="grid sm:grid-cols-2 gap-2 mt-1">
                                  <div>
                                    <p className="text-[10px] font-semibold text-amber-700 uppercase mb-0.5">Live on Amazon</p>
                                    <p className="text-[10px] text-slate-600 whitespace-pre-wrap break-words">{v.currentLive || <em className="text-slate-400">(empty)</em>}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-semibold text-emerald-700 uppercase mb-0.5">
                                      Expected (pushed){v.expectedSource === 'push_log' ? <span className="ml-1 normal-case font-normal text-slate-400">(from push history — the recommendation has since been regenerated)</span> : null}
                                    </p>
                                    <p className="text-[10px] text-slate-700 whitespace-pre-wrap break-words">{v.expected || <em className="text-slate-400">nothing to compare — this field isn&apos;t in the current recommendations and no push of it was ever logged</em>}</p>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        {verifyResults.stale > 0 && (
                          <p className="text-[10px] text-slate-500 mt-2 italic">
                            Stale = Amazon hasn&apos;t applied the new value yet. If it&apos;s been &gt; 6 hours, the submission may have been silently rejected — re-push from the section above.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end">
                    <button onClick={() => setShowPushModal(false)} className="text-xs px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white">Done</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
