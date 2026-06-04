'use client'

import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useCallback } from 'react'
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
  keyword_score: number; aplus_score: number; overall_score: number
  issues: SeoIssue[]; child_count: number; child_override_count: number
  top_child_asin: string | null; product_title: string | null
  image_url: string | null; total_units_30d: number; scored_at: string
  children: ChildContentRow[]
}

interface KeywordReconciliation {
  keyword: string; action_type: 'CRITICAL' | 'UPGRADE' | 'REINFORCE'
  search_volume: number; placed_in: string[]; exact_text: string; why: string
}

interface PerChildKeywords { sku: string; asin: string; keywords: string }

interface VariantCorrection { sku: string; field: string; current: string; replace_with: string; reason: string }
interface CannibalizationWarning { keyword: string; affected_skus: string[]; issue: string; recommendation: string }
interface ProductDetailImprovement { field_name: string; current_value: string | null; recommended_value: string; reason: string }

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

interface AiRecommendations {
  parent_asin: string; recommended_title: string; recommended_bullets: string[]
  recommended_keywords: string; per_child_keywords?: PerChildKeywords[]
  recommended_description: string; variant_corrections: VariantCorrection[]
  cannibalization_warnings?: CannibalizationWarning[]
  product_details_improvements?: ProductDetailImprovement[]
  keyword_reconciliation?: KeywordReconciliation[]
  action_plan?: ActionPlanItem[]
  generated_at: string; keyword_opportunities_used?: number
}

interface AnalyzedKeyword {
  keyword: string; opportunityScore: number
  actionType: 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED'
  actionText: string; rationale: string; urgency: string; estimatedImpact: string
  searchVolume: number; keywordSales: number; competingProducts: number
  asinImpressionShare: number; asinClickShare: number; asinPurchaseShare: number
  inTitle: boolean; inBullets: boolean; inDescription: boolean; inBackend: boolean
  dataSource: string
}

interface KeywordIntelligenceResult {
  asin: string; analyzedAt: string; dataSource: string
  totalKeywordsAnalyzed: number; topOpportunities: AnalyzedKeyword[]
  summary: { critical: number; upgrade: number; reinforce: number; defended: number; optimized: number }
  apiUsage?: { used: number; limit: number; remaining: number; provider: string }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function scoreColor(score: number) {
  if (score >= 80) return 'text-green-600 border-green-400'
  if (score >= 60) return 'text-amber-600 border-amber-400'
  return 'text-red-600 border-red-400'
}

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
  return 'border-l-gray-400'
}

function copyToClipboard(text: string) {
  if (typeof window !== 'undefined') navigator.clipboard.writeText(text)
}

// ─── Page Component ─────────────────────────────────────────────────────────

export default function ListingDetailPage() {
  const params = useParams()
  const router = useRouter()
  const asin = params.asin as string

  const [score, setScore] = useState<SeoScoreRow | null>(null)
  const [aiRecs, setAiRecs] = useState<AiRecommendations | null>(null)
  const [kwData, setKwData] = useState<KeywordIntelligenceResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiProgress, setAiProgress] = useState<string>('')
  const [copied, setCopied] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['apply']))
  const [competitorAsin, setCompetitorAsin] = useState<string>('')
  const [competitorSaving, setCompetitorSaving] = useState(false)

  // ── Push backend keywords to Amazon (PR16) ──
  interface PushDiffRow { sku: string; current: string; proposed: string; bytes: number; changed: boolean }
  interface PushResultRow { sku: string; status: string; submissionId: string | null; error?: string }
  const [pushPreview, setPushPreview] = useState<{ count: number; changed: number; diff: PushDiffRow[] } | null>(null)
  const [pushLoading, setPushLoading] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [pushResults, setPushResults] = useState<{ pushed: number; failed: number; total: number; message: string; results: PushResultRow[] } | null>(null)
  const [showPushModal, setShowPushModal] = useState(false)

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
        const resp = await fetch('/api/fba/listing-optimizer')
        if (!resp.ok) throw new Error('Failed to load')
        const data = await resp.json()
        const found = data.scores?.find((s: SeoScoreRow) => s.parent_asin === asin)
        if (found) setScore(found)
      } catch { /* ignore */ }
      setLoading(false)
    })()
  }, [asin])

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

  // Fetch keyword intelligence
  useEffect(() => {
    if (!score?.top_child_asin) return
    ;(async () => {
      try {
        const resp = await fetch(`/api/fba/intelligence/${score.top_child_asin}?stored=true`)
        if (resp.ok) {
          const data = await resp.json()
          if (data.totalKeywordsAnalyzed > 0) setKwData(data)
        }
      } catch { /* ignore */ }
    })()
  }, [score?.top_child_asin])

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

  // Generate AI recommendations (streaming)
  const generateAiRecs = useCallback(async () => {
    setAiLoading(true)
    setAiError(null)
    setAiProgress('Starting AI audit...')
    try {
      const resp = await fetch('/api/fba/listing-optimizer/ai-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_asin: asin }),
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
            } else if (msg.type === 'error') {
              throw new Error(msg.error || 'AI generation failed')
            }
          } catch (parseErr) {
            // Skip malformed lines
            if (parseErr instanceof Error && parseErr.message !== 'AI generation failed' && !parseErr.message.includes('AI returned')) continue
            throw parseErr
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer)
          if (msg.type === 'result') finalResult = msg
          else if (msg.type === 'error') throw new Error(msg.error)
        } catch { /* ignore */ }
      }

      if (finalResult?.recommendations) {
        setAiRecs(finalResult.recommendations)
      } else {
        throw new Error('No recommendations received')
      }
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : 'Failed')
    }
    setAiLoading(false)
    setAiProgress('')
  }, [asin])

  // ─── Push backend keywords to Amazon (preview → confirm) ──────────────────
  const openPushPreview = useCallback(async () => {
    setPushError(null); setPushResults(null); setPushPreview(null); setShowPushModal(true); setPushLoading(true)
    try {
      const resp = await fetch(`/api/fba/listing-optimizer/push-keywords?parent_asin=${asin}`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Preview failed')
      setPushPreview(data)
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'Preview failed')
    }
    setPushLoading(false)
  }, [asin])

  const confirmPush = useCallback(async () => {
    setPushError(null); setPushLoading(true)
    try {
      const resp = await fetch('/api/fba/listing-optimizer/push-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_asin: asin, confirm: true }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Push failed')
      setPushResults(data)
      setPushPreview(null)
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'Push failed')
    }
    setPushLoading(false)
  }, [asin])

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

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-sm text-gray-500">Loading listing data...</p>
      </div>
    </div>
  )

  if (!score) return (
    <div className="max-w-4xl mx-auto p-8 text-center">
      <p className="text-lg text-gray-600 mb-4">Listing not found: {asin}</p>
      <button onClick={() => router.push('/fba')} className="text-violet-600 hover:underline text-sm">
        &larr; Back to Listing Optimizer
      </button>
    </div>
  )

  const bars = [
    { label: 'Title', score: score.title_score, max: 25 },
    { label: 'Bullets', score: score.bullet_score, max: 25 },
    { label: 'Keywords', score: score.keyword_score, max: 25 },
    { label: 'A+', score: score.aplus_score, max: 25 },
  ]

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">

      {/* ── Back link ── */}
      <button onClick={() => router.push('/fba')} className="text-sm text-violet-600 hover:text-violet-800 flex items-center gap-1">
        <span>&larr;</span> Back to Listing Optimizer
      </button>

      {/* ══════════════════════════════════════════════════════════════════════
          HEADER — Product info + Score
          ══════════════════════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex gap-5">
          {/* Image */}
          <div className="flex-shrink-0 w-20 h-20 bg-gray-100 rounded-lg overflow-hidden">
            {score.image_url ? (
              <img src={score.image_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">IMG</div>
            )}
          </div>

          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-gray-900 leading-snug line-clamp-2">{score.product_title || asin}</h1>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
              <span className="font-mono">{asin}</span>
              <span>{score.child_count} variant{score.child_count !== 1 ? 's' : ''}</span>
              <span>{score.total_units_30d.toLocaleString()} units/30d</span>
            </div>
            {/* Score bars */}
            <div className="grid grid-cols-4 gap-3 mt-3">
              {bars.map(b => (
                <div key={b.label}>
                  <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
                    <span>{b.label}</span><span>{b.score}/{b.max}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${barColor(b.score, b.max)}`} style={{ width: `${(b.score / b.max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Score circle */}
          <div className="flex-shrink-0 flex flex-col items-center">
            <div className={`w-16 h-16 rounded-full border-4 flex items-center justify-center ${scoreColor(score.overall_score)}`}>
              <span className="text-xl font-bold">{score.overall_score}</span>
            </div>
            <span className="text-[9px] text-gray-400 mt-0.5">/ 100</span>
          </div>
        </div>

        {/* Action links */}
        <div className="flex gap-3 mt-4 pt-3 border-t border-gray-100">
          <a href={`https://sellercentral.amazon.com/abis/listing/edit?asin=${asin}&ref_=xx_addlisting_dnav_xx`}
            target="_blank" rel="noopener noreferrer"
            className="text-xs text-violet-600 hover:text-violet-800 border border-violet-200 rounded-lg px-3 py-1.5">
            Edit Listing in Seller Central &rarr;
          </a>
          <a href={`https://sellercentral.amazon.com/enhanced-content/edit?asin=${asin}`}
            target="_blank" rel="noopener noreferrer"
            className="text-xs text-violet-600 hover:text-violet-800 border border-violet-200 rounded-lg px-3 py-1.5">
            Edit A+ Content &rarr;
          </a>
          <button
            onClick={generateAiRecs}
            disabled={aiLoading}
            className="ml-auto text-xs bg-violet-600 hover:bg-violet-700 text-white px-4 py-1.5 rounded-lg disabled:opacity-50 transition-colors">
            {aiLoading ? 'Generating...' : aiRecs ? 'Regenerate AI Audit' : 'Run AI Audit'}
          </button>
          {aiRecs && (
            <button
              onClick={openPushPreview}
              disabled={pushLoading}
              title="Write the per-child backend keywords directly to Amazon"
              className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded-lg disabled:opacity-50 transition-colors">
              Push Keywords to Amazon &rarr;
            </button>
          )}
        </div>
        {aiError && <p className="text-xs text-red-600 mt-2">{aiError}</p>}

        {/* Competitor ASIN input for reverse keyword lookup */}
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 whitespace-nowrap">Competitor ASIN:</label>
            <input
              type="text"
              value={competitorAsin}
              onChange={(e) => setCompetitorAsin(e.target.value.toUpperCase())}
              placeholder="B0XXXXXXXXX"
              className="text-xs border border-gray-200 rounded px-2 py-1 w-32 font-mono uppercase"
              maxLength={10}
            />
            <button
              onClick={saveCompetitorAsin}
              disabled={competitorSaving || !competitorAsin || competitorAsin.length !== 10}
              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded disabled:opacity-50">
              {competitorSaving ? 'Saving...' : 'Save'}
            </button>
            <span className="text-xs text-gray-400">Used for Jungle Scout keyword lookup when your ASIN has no data</span>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          ACTION PLAN — Comprehensive listing review with verdicts
          ══════════════════════════════════════════════════════════════════════ */}
      {aiRecs?.action_plan && aiRecs.action_plan.length > 0 && (() => {
        const verdictStyles: Record<string, string> = {
          REPLACE: 'bg-red-50 border-red-300 text-red-800',
          EDIT: 'bg-amber-50 border-amber-300 text-amber-800',
          CREATE: 'bg-blue-50 border-blue-300 text-blue-800',
          DONE: 'bg-green-50 border-green-300 text-green-800',
          SKIP: 'bg-gray-50 border-gray-300 text-gray-500',
        }
        const verdictIcons: Record<string, string> = {
          REPLACE: '🔴', EDIT: '⚠️', CREATE: '🔵', DONE: '✅', SKIP: '⏭️',
        }
        const priorityBadge: Record<string, string> = {
          HIGH: 'bg-red-100 text-red-700',
          MEDIUM: 'bg-amber-100 text-amber-700',
          LOW: 'bg-gray-100 text-gray-600',
          NONE: 'bg-green-100 text-green-700',
        }
        const recs = aiRecs!
        const parentItems = (recs.action_plan ?? []).filter(a => a.element !== 'backend_keywords')
        const backendItem = (recs.action_plan ?? []).find(a => a.element === 'backend_keywords')
        const recMap = new Map((recs.per_child_keywords ?? []).map(p => [p.sku, p.keywords]))
        const perChildRows = score.children.map(c => {
          const recommended = (recMap.get(c.sku) ?? '').trim()
          const current = (c.backend_keywords ?? '').trim()
          return { sku: c.sku, current, recommended, changed: recommended !== '' && recommended !== current }
        })
        const needsUpdate = perChildRows.filter(r => r.changed).length
        const actionsNeeded = (recs.action_plan ?? []).filter(a => a.verdict !== 'DONE' && a.verdict !== 'SKIP').length
        // ── Per-field variant cohesion (client-side; "should-match" fields only) ──
        // Groups each child's CURRENT value to show whether the 46 variants are consistent or
        // split, how many need updating, and which SKUs hold which version.
        const normV = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
        const fieldCohesion = (getCurrent: (c: ChildContentRow) => string | null | undefined, recommended: string) => {
          const groups = new Map<string, string[]>()
          for (const c of score.children) {
            const v = normV(getCurrent(c))
            if (!groups.has(v)) groups.set(v, [])
            groups.get(v)!.push(c.sku)
          }
          const versions = [...groups.entries()].map(([value, skus]) => ({ value, skus })).sort((a, b) => b.skus.length - a.skus.length)
          const rec = normV(recommended)
          const needUpdate = score.children.filter(c => normV(getCurrent(c)) !== rec).length
          return { versions, distinct: versions.length, needUpdate, total: score.children.length, recommended }
        }
        const cohFields = [
          { key: 'title', label: 'Title', coh: fieldCohesion(c => c.title, recs.recommended_title), copyVal: recs.recommended_title },
          { key: 'bullets', label: 'Bullets', coh: fieldCohesion(c => [c.bullet_1, c.bullet_2, c.bullet_3, c.bullet_4, c.bullet_5].filter(Boolean).join('\n'), (recs.recommended_bullets ?? []).join('\n')), copyVal: (recs.recommended_bullets ?? []).join('\n') },
          { key: 'description', label: 'Description', coh: fieldCohesion(c => c.description, recs.recommended_description), copyVal: recs.recommended_description },
        ]
        return (
        <section>
          <button onClick={() => toggle('apply')} className="flex items-center gap-2 mb-3 w-full text-left">
            <span className="text-sm font-bold text-gray-900 uppercase tracking-wide">
              Apply These Changes
              <span className="text-gray-500 font-normal ml-1">({actionsNeeded} actions needed)</span>
            </span>
            <span className="text-xs text-gray-400">{expandedSections.has('apply') ? '▾' : '▸'}</span>
          </button>

          {expandedSections.has('apply') && (
            <div className="space-y-6">
              {/* ── VARIANT COHESION — how the variants compare per field ── */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-baseline gap-2">
                  <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">Variant Cohesion</span>
                  <span className="text-[11px] text-gray-400">how your {score.children.length} variants compare today</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {cohFields.map(f => {
                    const split = f.coh.distinct > 1
                    const open = expandedSections.has(`coh-${f.key}`)
                    return (
                      <div key={f.key}>
                        <button onClick={() => toggle(`coh-${f.key}`)} className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 transition-colors">
                          <span className="text-xs font-semibold text-gray-800 w-20 flex-shrink-0">{f.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 flex-shrink-0 hidden sm:inline">should match</span>
                          {split
                            ? <span className="text-[11px] text-purple-700 flex items-center gap-1"><span aria-hidden>⚡</span>{f.coh.distinct} versions live</span>
                            : <span className="text-[11px] text-green-700 flex items-center gap-1"><span aria-hidden>✓</span>all {f.coh.total} identical</span>}
                          <span className="ml-auto text-[11px] flex-shrink-0">
                            {f.coh.needUpdate > 0
                              ? <span className="text-amber-700 flex items-center gap-1"><span aria-hidden>⚠️</span>{f.coh.needUpdate} need update</span>
                              : <span className="text-green-700">up to date</span>}
                          </span>
                          <span className="text-xs text-gray-400 flex-shrink-0">{open ? '▾' : '▸'}</span>
                        </button>
                        {open && (
                          <div className="px-4 pb-3 pt-1 bg-gray-50/60 space-y-2">
                            <div className="flex items-start justify-between gap-2 bg-green-50 border border-green-200 rounded p-2">
                              <div className="min-w-0">
                                <p className="text-[10px] font-bold text-green-800 uppercase">Update all {f.coh.total} variants to:</p>
                                <p className="text-xs text-gray-800 whitespace-pre-wrap break-words mt-0.5">{f.copyVal || '(none)'}</p>
                              </div>
                              <button onClick={() => copy(f.copyVal || '', `coh-${f.key}`)} className="text-[10px] bg-green-600 hover:bg-green-700 text-white px-2 py-0.5 rounded flex-shrink-0">{copied === `coh-${f.key}` ? 'Copied!' : 'Copy'}</button>
                            </div>
                            <p className="text-[10px] font-medium text-gray-500 uppercase">Current values across your variants{split ? ' — these diverge:' : ':'}</p>
                            {f.coh.versions.map((v, vi) => (
                              <details key={vi} className="bg-white border border-gray-200 rounded">
                                <summary className="cursor-pointer px-2 py-1 text-[11px] flex items-center gap-2">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 flex-shrink-0">{v.skus.length} variant{v.skus.length === 1 ? '' : 's'}</span>
                                  <span className="truncate text-gray-500">{v.value ? (v.value.length > 90 ? v.value.slice(0, 90) + '…' : v.value) : '(empty)'}</span>
                                </summary>
                                <p className="px-2 pb-2 text-[10px] text-gray-400 font-mono break-words">{v.skus.join(', ')}</p>
                              </details>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-2 px-4 py-2">
                    <span className="text-xs font-semibold text-gray-800 w-20 flex-shrink-0">Backend</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 flex-shrink-0 hidden sm:inline">unique each</span>
                    <span className="text-[11px] text-gray-500">each variant gets its own color-specific terms</span>
                    <span className="ml-auto text-[11px] text-amber-700 flex items-center gap-1 flex-shrink-0"><span aria-hidden>⚠️</span>{needsUpdate} need update <span className="text-gray-400 hidden sm:inline">— see table below</span></span>
                  </div>
                </div>
              </div>

              {/* ── TIER 1 — Edit Once (Parent Level) ── */}
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">✏️ Edit Once</h3>
                  <span className="text-[11px] text-gray-400">Parent level — applies to all {score.children.length} variants</span>
                </div>
                <div className="space-y-2">
                  {parentItems.map((item, idx) => {
                    const style = verdictStyles[item.verdict] || verdictStyles.SKIP
                    return (
                  <div key={idx} className={`rounded-lg border p-4 ${style}`}>
                    {/* Row 1: Element + Verdict + Priority + Level */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-lg">{verdictIcons[item.verdict]}</span>
                      <span className="font-semibold text-sm uppercase">{item.element.replace(/_/g, ' ')}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${priorityBadge[item.priority] || ''}`}>
                        {item.priority}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/60 border border-current/20">
                        {item.level === 'parent' ? '📦 Parent Level' : '🏷️ Per Child'}
                      </span>
                      <span className="ml-auto text-[10px] font-mono opacity-60">{item.verdict}</span>
                    </div>

                    {/* Row 2: Current Status */}
                    <p className="text-xs mt-1.5 opacity-80">
                      <span className="font-medium">Current:</span> {item.current_status}
                    </p>

                    {/* Row 3: Instruction */}
                    {item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (
                      <div className="mt-2 bg-white/60 rounded p-2.5 border border-current/10">
                        <p className="text-xs font-medium mb-0.5">What to do:</p>
                        <p className="text-xs leading-relaxed">{item.instruction}</p>
                      </div>
                    )}

                    {/* Row 4: Seller Central Path */}
                    {item.seller_central_path && item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (
                      <p className="text-[10px] mt-1.5 opacity-60">
                        📍 {item.seller_central_path}
                      </p>
                    )}

                    {/* Row 5: Replacement Content (the actual fix) */}
                    {item.replacement_content && item.verdict !== 'DONE' && item.verdict !== 'SKIP' && (
                      <div className="mt-2 bg-white rounded-md border-2 border-green-300 p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[10px] font-bold text-green-800 uppercase">✂️ Copy & Paste This:</span>
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

                    {/* Row 6: Notes */}
                    {item.notes && (
                      <p className="text-[10px] mt-1.5 italic opacity-70">💡 {item.notes}</p>
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
                {recs.product_details_improvements && recs.product_details_improvements.length > 0 && (
                  <div className="mt-3 bg-white border border-gray-200 rounded-xl p-4">
                    <span className="text-xs font-semibold text-gray-700 block mb-2">Recommended Product Detail values</span>
                    <div className="grid sm:grid-cols-2 gap-2">
                      {recs.product_details_improvements.map((pd, i) => (
                        <div key={i} className="bg-gray-50 rounded-lg p-2.5">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs font-semibold text-gray-800">{pd.field_name}</span>
                            <button onClick={() => copy(pd.recommended_value, `pd-${i}`)} className="text-[10px] text-violet-600 hover:underline">{copied === `pd-${i}` ? 'Copied!' : 'Copy'}</button>
                          </div>
                          <p className="text-xs text-gray-700">{pd.recommended_value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── TIER 2 — Edit Per Variant (Per Child) ── */}
              <div>
                <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                  <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wide">🎨 Edit Per Variant</h3>
                  <span className="text-[11px] text-gray-400">Backend search terms — unique per color/size</span>
                  {needsUpdate > 0
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">{needsUpdate} of {perChildRows.length} need update</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">all {perChildRows.length} match</span>}
                </div>
                {backendItem?.instruction && <p className="text-xs text-gray-600 mb-2">{backendItem.instruction}</p>}
                {perChildRows.length === 0 ? (
                  <p className="text-xs text-gray-400">No variant data yet.</p>
                ) : (
                  <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-gray-500">SKU</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-500">Status</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-500">Recommended backend search terms</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {perChildRows.map(r => (
                          <tr key={r.sku} className={r.changed ? 'bg-amber-50/40' : ''}>
                            <td className="px-3 py-2 font-mono text-gray-700 align-top whitespace-nowrap">{r.sku}</td>
                            <td className="px-3 py-2 align-top whitespace-nowrap">
                              {r.recommended === ''
                                ? <span className="text-gray-400">—</span>
                                : r.changed
                                  ? <span className="text-amber-600 font-medium">⚠️ Update</span>
                                  : <span className="text-green-600">✓ OK</span>}
                            </td>
                            <td className="px-3 py-2 align-top">
                              {r.changed && r.current && <p className="text-[10px] text-gray-400 line-through mb-0.5 whitespace-pre-wrap break-words">{r.current}</p>}
                              <p className="text-gray-700 font-mono leading-relaxed whitespace-pre-wrap break-words">{r.recommended || '(no recommendation)'}</p>
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
                )}
                {needsUpdate > 0 && (
                  <button onClick={openPushPreview} className="mt-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-medium">
                    Push {needsUpdate} update{needsUpdate === 1 ? '' : 's'} to Amazon →
                  </button>
                )}

                {/* Variant-specific corrections (folded from AI Recommendations) */}
                {recs.variant_corrections && recs.variant_corrections.length > 0 && (
                  <div className="mt-3 bg-white border border-gray-200 rounded-xl p-4">
                    <span className="text-xs font-semibold text-gray-700 block mb-2">Variant-specific corrections</span>
                    <div className="space-y-2">
                      {recs.variant_corrections.map((vc, i) => (
                        <div key={i} className="bg-gray-50 rounded-lg p-3">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-mono text-gray-600">{vc.sku}</span>
                            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{vc.field}</span>
                          </div>
                          <p className="text-[10px] text-gray-400 line-through">{vc.current.length > 100 ? vc.current.slice(0, 100) + '...' : vc.current}</p>
                          <p className="text-xs text-gray-800 mt-0.5">{vc.replace_with}</p>
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

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 1 — Keyword Placement Plan (grouped by placement)
          ══════════════════════════════════════════════════════════════════════ */}
      <section>
        <button onClick={() => toggle('placement')} className="flex items-center gap-2 mb-3 w-full text-left">
          <span className="text-sm font-bold text-violet-800 uppercase tracking-wide">
            Keyword Placement Plan
            {placementGroups && <span className="text-violet-500 font-normal ml-1">({placementGroups.total} keywords reconciled)</span>}
          </span>
          <span className="text-xs text-gray-400">{expandedSections.has('placement') ? '▾' : '▸'}</span>
        </button>

        {expandedSections.has('placement') && (
          <>
            {!aiRecs && !aiLoading && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-500 mb-3">No AI audit yet. Generate one to see the keyword placement plan.</p>
                <button onClick={generateAiRecs} className="text-xs bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-lg">
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
                    <div key={groupKey} className={`rounded-xl border-2 p-4 ${borderClass}`}>
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
                          <span className="text-xs text-gray-500">{group.keywords.length} keywords &middot; {totalVol.toLocaleString()} searches/mo</span>
                          <button
                            onClick={() => copy(group.text, copyLabel)}
                            className="text-[10px] bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-2 py-1 rounded transition-colors">
                            {copied === copyLabel ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                      </div>

                      {/* The actual text */}
                      <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
                        <p className="text-sm text-gray-800 leading-relaxed">{group.text}</p>
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
        <button onClick={() => toggle('issues')} className="flex items-center gap-2 mb-3 w-full text-left">
          <span className="text-sm font-bold text-gray-600 uppercase tracking-wide">
            Diagnostics
            <span className="text-gray-400 font-normal ml-1">({score.issues.length}) — detailed audit; the actions above are the fixes</span>
          </span>
          <span className="text-xs text-gray-400">{expandedSections.has('issues') ? '▾' : '▸'}</span>
        </button>

        {expandedSections.has('issues') && (
          <div className="space-y-2">
            {score.issues.length === 0 ? (
              <p className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg p-3">No issues found. This listing looks great!</p>
            ) : (
              score.issues.map((issue, i) => (
                <div key={i} className={`border-l-4 ${issueBorder(issue.field)} bg-white border border-gray-200 rounded-r-lg p-3`}>
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                      issue.severity === 'error' ? 'bg-red-100 text-red-700'
                      : issue.severity === 'warning' ? 'bg-amber-100 text-amber-700'
                      : 'bg-blue-100 text-blue-700'
                    }`}>{issue.field}</span>
                    <p className="text-sm text-gray-700 leading-relaxed">{issue.message}</p>
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
        <button onClick={() => toggle('variants')} className="flex items-center gap-2 mb-3 w-full text-left">
          <span className="text-sm font-bold text-gray-800 uppercase tracking-wide">
            Variant Breakdown
            <span className="text-gray-400 font-normal ml-1">({score.children.length})</span>
          </span>
          <span className="text-xs text-gray-400">{expandedSections.has('variants') ? '▾' : '▸'}</span>
        </button>

        {expandedSections.has('variants') && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-gray-500">SKU</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500">A+</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500">Bullets</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500">Keywords</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-500">Images</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {score.children.map(child => (
                  <tr key={child.sku} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="font-mono text-gray-700">{child.sku}</div>
                      <div className="text-[10px] text-gray-400 truncate max-w-[300px]">{child.title}</div>
                    </td>
                    <td className="px-3 py-2">
                      {child.has_aplus ? (
                        <span className="text-green-600">&#10003; ({child.aplus_module_count}m)</span>
                      ) : (
                        <span className="text-red-500">&#10007;</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {[child.bullet_1, child.bullet_2, child.bullet_3, child.bullet_4, child.bullet_5].filter(Boolean).length}/5
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {child.backend_keywords ? `${child.backend_keywords.length}/250` : '0/250'}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{child.image_count}/7</td>
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
      {kwData && kwData.topOpportunities.length > 0 && (
        <section>
          <button onClick={() => toggle('kwintel')} className="flex items-center gap-2 mb-3 w-full text-left">
            <span className="text-sm font-bold text-gray-800 uppercase tracking-wide">
              Keyword Intelligence
              <span className="text-gray-400 font-normal ml-1">({kwData.totalKeywordsAnalyzed} keywords analyzed)</span>
            </span>
            <span className="text-xs text-gray-400">{expandedSections.has('kwintel') ? '▾' : '▸'}</span>
          </button>

          {expandedSections.has('kwintel') && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {/* Summary badges */}
              <div className="flex gap-3 p-3 border-b border-gray-100 bg-gray-50">
                {kwData.summary.critical > 0 && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{kwData.summary.critical} Critical</span>}
                {kwData.summary.upgrade > 0 && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{kwData.summary.upgrade} Upgrade</span>}
                {kwData.summary.reinforce > 0 && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">{kwData.summary.reinforce} Reinforce</span>}
                {kwData.summary.defended > 0 && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{kwData.summary.defended} Defended</span>}
              </div>
              {/* Top 20 keywords table */}
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Keyword</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-500">Vol</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Action</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Present In</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {kwData.topOpportunities.slice(0, 20).map((kw, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-800">{kw.keyword}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{kw.searchVolume.toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          kw.actionType === 'CRITICAL' ? 'bg-red-100 text-red-700'
                          : kw.actionType === 'UPGRADE' ? 'bg-amber-100 text-amber-700'
                          : kw.actionType === 'REINFORCE' ? 'bg-green-100 text-green-700'
                          : 'bg-blue-100 text-blue-700'
                        }`}>{kw.actionType}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          {kw.inTitle && <span className="text-[9px] bg-blue-50 text-blue-600 px-1 rounded">T</span>}
                          {kw.inBullets && <span className="text-[9px] bg-green-50 text-green-600 px-1 rounded">B</span>}
                          {kw.inDescription && <span className="text-[9px] bg-purple-50 text-purple-600 px-1 rounded">D</span>}
                          {kw.inBackend && <span className="text-[9px] bg-gray-100 text-gray-600 px-1 rounded">K</span>}
                          {!kw.inTitle && !kw.inBullets && !kw.inDescription && !kw.inBackend && (
                            <span className="text-[9px] text-red-500">nowhere</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          PUSH KEYWORDS TO AMAZON — preview → confirm modal (PR16)
          ══════════════════════════════════════════════════════════════════════ */}
      {showPushModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !pushLoading && setShowPushModal(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 sticky top-0 bg-white">
              <h3 className="text-sm font-bold text-gray-900">Push Backend Keywords to Amazon</h3>
              <button onClick={() => !pushLoading && setShowPushModal(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
            </div>

            <div className="p-5">
              {pushError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">{pushError}</p>}

              {pushLoading && !pushResults && (
                <div className="text-center py-8">
                  <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full mx-auto mb-2" />
                  <p className="text-sm text-gray-500">{pushResults ? 'Pushing…' : pushPreview ? 'Pushing to Amazon…' : 'Loading preview…'}</p>
                </div>
              )}

              {/* Preview (pre-confirm) */}
              {pushPreview && !pushResults && !pushLoading && (
                <>
                  <p className="text-sm text-gray-700 mb-1">
                    <b>{pushPreview.changed}</b> of {pushPreview.count} variants will change. Backend search terms only — not customer-visible.
                  </p>
                  <p className="text-xs text-gray-500 mb-3">Each value is capped at 250 bytes and validated with Amazon before writing. Previous values are saved for rollback.</p>
                  <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-4 max-h-[45vh] overflow-y-auto">
                    {pushPreview.diff.filter(d => d.changed).map((d) => (
                      <div key={d.sku} className="p-3 text-xs">
                        <div className="font-mono text-gray-700 mb-1">{d.sku} <span className="text-gray-400">({d.bytes}/250 bytes)</span></div>
                        <p className="text-gray-400 line-through mb-0.5 break-words">{d.current || '(empty)'}</p>
                        <p className="text-emerald-700 break-words">{d.proposed}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setShowPushModal(false)} className="text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">Cancel</button>
                    <button onClick={confirmPush} disabled={pushPreview.changed === 0}
                      className="text-xs px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50">
                      Confirm &amp; Push {pushPreview.changed} variant{pushPreview.changed !== 1 ? 's' : ''} to Amazon
                    </button>
                  </div>
                </>
              )}

              {/* Results (post-push) */}
              {pushResults && (
                <>
                  <p className="text-sm text-gray-800 mb-3">{pushResults.message}</p>
                  <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-4 max-h-[50vh] overflow-y-auto">
                    {pushResults.results.map((r) => (
                      <div key={r.sku} className="p-2.5 text-xs flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.status === 'accepted' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{r.status}</span>
                        <span className="font-mono text-gray-700">{r.sku}</span>
                        {r.error && <span className="text-red-600 truncate">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <button onClick={() => setShowPushModal(false)} className="text-xs px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-900 text-white">Done</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
