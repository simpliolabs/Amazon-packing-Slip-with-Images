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
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['action-plan', 'placement', 'issues']))
  const [competitorAsin, setCompetitorAsin] = useState<string>('')
  const [competitorSaving, setCompetitorSaving] = useState(false)

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
      {aiRecs?.action_plan && aiRecs.action_plan.length > 0 && (
        <section>
          <button onClick={() => toggle('action-plan')} className="flex items-center gap-2 mb-3 w-full text-left">
            <span className="text-sm font-bold text-gray-900 uppercase tracking-wide">
              Action Plan
              <span className="text-gray-500 font-normal ml-1">
                ({aiRecs.action_plan.filter(a => a.verdict !== 'DONE' && a.verdict !== 'SKIP').length} actions needed)
              </span>
            </span>
            <span className="text-xs text-gray-400">{expandedSections.has('action-plan') ? '▾' : '▸'}</span>
          </button>

          {expandedSections.has('action-plan') && (
            <div className="space-y-2">
              {aiRecs.action_plan.map((item, idx) => {
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
          )}
        </section>
      )}

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
          <span className="text-sm font-bold text-gray-800 uppercase tracking-wide">
            Issues to Fix
            <span className="text-gray-400 font-normal ml-1">({score.issues.length})</span>
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
          SECTION 4 — Full AI Recommendations (copy-paste ready)
          ══════════════════════════════════════════════════════════════════════ */}
      {aiRecs && (
        <section>
          <button onClick={() => toggle('recommendations')} className="flex items-center gap-2 mb-3 w-full text-left">
            <span className="text-sm font-bold text-gray-800 uppercase tracking-wide">
              AI Recommendations
              <span className="text-gray-400 font-normal ml-1">gpt-4.1-mini &middot; {new Date(aiRecs.generated_at).toLocaleDateString()}</span>
            </span>
            <span className="text-xs text-gray-400">{expandedSections.has('recommendations') ? '▾' : '▸'}</span>
          </button>

          {expandedSections.has('recommendations') && (
            <div className="space-y-4">

              {/* Recommended Title */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-700">Recommended Title <span className="text-gray-400 font-normal">({aiRecs.recommended_title.length} chars)</span></span>
                  <button onClick={() => copy(aiRecs.recommended_title, 'title')}
                    className="text-[10px] bg-violet-100 hover:bg-violet-200 text-violet-700 px-2 py-1 rounded transition-colors">
                    {copied === 'title' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-sm text-gray-800 leading-relaxed">{aiRecs.recommended_title}</p>
              </div>

              {/* Recommended Bullets */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-700">Recommended Bullets</span>
                  <button onClick={() => copy(aiRecs.recommended_bullets.join('\n'), 'bullets')}
                    className="text-[10px] bg-violet-100 hover:bg-violet-200 text-violet-700 px-2 py-1 rounded transition-colors">
                    {copied === 'bullets' ? 'Copied!' : 'Copy All'}
                  </button>
                </div>
                <ol className="space-y-2">
                  {aiRecs.recommended_bullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-[10px] text-gray-400 font-mono mt-0.5">{i + 1}.</span>
                      <p className="text-sm text-gray-800 leading-relaxed flex-1">{b}</p>
                      <button onClick={() => copy(b, `bullet-${i}`)}
                        className="text-[10px] text-violet-600 hover:underline flex-shrink-0">
                        {copied === `bullet-${i}` ? 'Copied!' : 'Copy'}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Backend Keywords */}
              {aiRecs.per_child_keywords && aiRecs.per_child_keywords.length > 0 ? (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <span className="text-xs font-semibold text-gray-700 block mb-2">Backend Keywords (per variant)</span>
                  <div className="space-y-3">
                    {aiRecs.per_child_keywords.map((ck, i) => (
                      <div key={i} className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-mono text-gray-600">{ck.sku}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-400">{ck.keywords.length}/250 chars</span>
                            <button onClick={() => copy(ck.keywords, `kw-${i}`)}
                              className="text-[10px] text-violet-600 hover:underline">
                              {copied === `kw-${i}` ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-gray-700 font-mono leading-relaxed">{ck.keywords}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-700">Backend Keywords <span className="text-gray-400 font-normal">({aiRecs.recommended_keywords.length}/250 chars)</span></span>
                    <button onClick={() => copy(aiRecs.recommended_keywords, 'keywords')}
                      className="text-[10px] bg-violet-100 hover:bg-violet-200 text-violet-700 px-2 py-1 rounded transition-colors">
                      {copied === 'keywords' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-700 font-mono leading-relaxed">{aiRecs.recommended_keywords}</p>
                </div>
              )}

              {/* Description */}
              {aiRecs.recommended_description && (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-700">Recommended Description</span>
                    <button onClick={() => copy(aiRecs.recommended_description, 'desc')}
                      className="text-[10px] bg-violet-100 hover:bg-violet-200 text-violet-700 px-2 py-1 rounded transition-colors">
                      {copied === 'desc' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-sm text-gray-700 leading-relaxed">{aiRecs.recommended_description}</p>
                </div>
              )}

              {/* Product Details Improvements */}
              {aiRecs.product_details_improvements && aiRecs.product_details_improvements.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <span className="text-xs font-semibold text-gray-700 block mb-2">Product Details Improvements</span>
                  <div className="space-y-2">
                    {aiRecs.product_details_improvements.map((pd, i) => (
                      <div key={i} className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold text-gray-800">{pd.field_name}</span>
                          <button onClick={() => copy(pd.recommended_value, `pd-${i}`)}
                            className="text-[10px] text-violet-600 hover:underline">
                            {copied === `pd-${i}` ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        {pd.current_value && <p className="text-[10px] text-gray-400 line-through mb-0.5">Current: {pd.current_value}</p>}
                        <p className="text-xs text-gray-700">{pd.recommended_value}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">{pd.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Variant Corrections */}
              {aiRecs.variant_corrections && aiRecs.variant_corrections.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <span className="text-xs font-semibold text-gray-700 block mb-2">Variant-Specific Corrections</span>
                  <div className="space-y-2">
                    {aiRecs.variant_corrections.map((vc, i) => (
                      <div key={i} className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-gray-600">{vc.sku}</span>
                          <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{vc.field}</span>
                        </div>
                        <p className="text-[10px] text-gray-400 line-through">{vc.current.length > 100 ? vc.current.slice(0, 100) + '...' : vc.current}</p>
                        <p className="text-xs text-gray-800 mt-0.5">{vc.replace_with}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">{vc.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

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
    </div>
  )
}
