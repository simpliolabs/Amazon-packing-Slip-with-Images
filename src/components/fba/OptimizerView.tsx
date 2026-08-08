/**
 * OptimizerView.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Split-screen optimizer panel.
 * Left: keyword diagnostics (KeywordIntelligencePanel)
 * Right: AI-generated listing fix (existing AI recommendations)
 *
 * Karpathy: Simplicity First — this is a layout wrapper, not a logic layer.
 * All data fetching is done by the parent (fba/page.tsx) and passed as props.
 */

'use client'

import { KeywordIntelligencePanel } from './KeywordIntelligencePanel'
import { ApiUsageMeter } from './ApiUsageMeter'

// ─── Types ────────────────────────────────────────────────────────────────────

type ActionType = 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED'

interface AnalyzedKeyword {
  keyword: string
  /** Internal gap-amplified placement composite (renamed from opportunityScore, PO 2026-08-08). */
  coverageGapScore: number
  actionType: ActionType
  actionText: string
  rationale: string
  urgency: 'high' | 'medium' | 'low'
  estimatedImpact: string
  searchVolume: number
  keywordSales: number
  competingProducts: number
  asinImpressionShare: number
  asinPurchaseShare: number
  inTitle: boolean
  inBullets: boolean
  inDescription: boolean
  inBackend: boolean
  dataSource: 'sqp' | 'jungle_scout' | 'inherited'
}

interface IntelligenceResult {
  asin: string
  analyzedAt: string
  dataSource: 'sqp' | 'jungle_scout' | 'inherited'
  totalKeywordsAnalyzed: number
  topOpportunities: AnalyzedKeyword[]
  summary: { critical: number; upgrade: number; reinforce: number; defended: number; optimized: number }
  message?: string
}

interface CannibalizationWarning {
  keyword: string
  affected_skus: string[]
  issue: string
  recommendation: string
}

interface ProductDetailImprovement {
  field_name: string
  current_value: string | null
  recommended_value: string
  reason: string
}

interface KeywordReconciliation {
  keyword: string
  action_type: 'CRITICAL' | 'UPGRADE' | 'REINFORCE'
  search_volume: number
  placed_in: string[]
  exact_text: string
  why: string
}

interface AiRecommendations {
  recommended_title: string
  recommended_bullets: string[]
  recommended_keywords: string
  recommended_description: string
  generated_at: string
  keyword_opportunities_used?: number
  cannibalization_warnings?: CannibalizationWarning[]
  product_details_improvements?: ProductDetailImprovement[]
  keyword_reconciliation?: KeywordReconciliation[]
}

interface ApiUsageStats {
  used: number
  limit: number
  remaining: number
  provider: string
}

interface Props {
  // Keyword intelligence props
  childAsin: string
  kwData: IntelligenceResult | null
  kwLoading: boolean
  kwError: string | null
  onRefreshKeywords: () => void
  // AI recommendations props
  aiRecs: AiRecommendations | null
  aiLoading: boolean
  onGenerateAiFix: () => void
  // API usage
  apiUsage: ApiUsageStats | null
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OptimizerView({
  childAsin,
  kwData,
  kwLoading,
  kwError,
  onRefreshKeywords,
  aiRecs,
  aiLoading,
  onGenerateAiFix,
  apiUsage,
}: Props) {
  return (
    <div className="flex flex-col h-full">

      {/* API usage meter — top strip */}
      {apiUsage && (
        <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
          <ApiUsageMeter
            used={apiUsage.used}
            limit={apiUsage.limit}
            provider={apiUsage.provider}
          />
        </div>
      )}

      {/* Split body */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-200 flex-1 overflow-hidden">

        {/* Left: Keyword Intelligence */}
        <div className="p-4 overflow-y-auto max-h-[55vh]">
          <h3 className="text-sm font-bold text-gray-800 mb-3">
            Keyword Opportunities
            <span className="text-xs font-normal text-gray-400 ml-2">
              {kwData ? `${kwData.totalKeywordsAnalyzed} analyzed` : childAsin}
            </span>
          </h3>
          <KeywordIntelligencePanel
            asin={childAsin}
            data={kwData}
            loading={kwLoading}
            error={kwError}
            onRefresh={onRefreshKeywords}
          />
        </div>

        {/* Right: AI Fix */}
        <div className="p-4 overflow-y-auto max-h-[55vh]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-gray-800">AI-Generated Fix</h3>
            <button
              onClick={onGenerateAiFix}
              disabled={aiLoading}
              className="text-xs font-medium bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white rounded-lg px-3 py-1.5 transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              {aiLoading ? '✨ Generating…' : aiRecs ? '✨ Regenerate' : '✨ Generate Fix'}
            </button>
          </div>

          {aiLoading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">AI is writing your optimized listing…</p>
            </div>
          )}

          {!aiLoading && !aiRecs && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="text-3xl">✨</div>
              <p className="text-sm text-gray-700 font-medium">Ready to generate</p>
              <p className="text-xs text-gray-500 max-w-xs">
                {kwData && kwData.summary.critical > 0
                  ? `${kwData.summary.critical} critical keyword gaps detected. Click Generate Fix to get an optimized title, bullets, and backend keywords.`
                  : 'Click Generate Fix to get AI-optimized listing content.'}
              </p>
            </div>
          )}

          {!aiLoading && aiRecs && (
            <div className="space-y-4">
              {/* Keyword Reconciliation Report — grouped by placement */}
              {aiRecs.keyword_reconciliation && aiRecs.keyword_reconciliation.length > 0 && (() => {
                const placementGroups: Record<string, { text: string; keywords: { keyword: string; action_type: string; search_volume: number; why: string }[] }> = {}
                for (const kr of aiRecs.keyword_reconciliation!) {
                  const key = [...kr.placed_in].sort().join(' + ')
                  if (!placementGroups[key]) {
                    placementGroups[key] = { text: kr.exact_text, keywords: [] }
                  }
                  placementGroups[key].keywords.push({ keyword: kr.keyword, action_type: kr.action_type, search_volume: kr.search_volume, why: kr.why })
                }
                const sortedKeys = Object.keys(placementGroups).sort((a, b) => {
                  if (a.includes('title') && !b.includes('title')) return -1
                  if (!a.includes('title') && b.includes('title')) return 1
                  if (a.includes('bullet') && !b.includes('bullet')) return -1
                  if (!a.includes('bullet') && b.includes('bullet')) return 1
                  return a.localeCompare(b)
                })
                const totalKw = aiRecs.keyword_reconciliation!.length
                return (
                  <div>
                    <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-2">
                      Keyword Placement Plan ({totalKw} keywords reconciled)
                    </p>
                    <div className="space-y-3">
                      {sortedKeys.map((groupKey) => {
                        const group = placementGroups[groupKey]
                        const placements = groupKey.split(' + ')
                        const totalVol = group.keywords.reduce((s, k) => s + (k.search_volume || 0), 0)
                        const hasCritical = group.keywords.some(k => k.action_type === 'CRITICAL')
                        const hasUpgrade = group.keywords.some(k => k.action_type === 'UPGRADE' || k.action_type === 'TITLE UPGRADE')
                        const borderColor = hasCritical ? 'border-red-300 bg-red-50/50' : hasUpgrade ? 'border-amber-300 bg-amber-50/50' : 'border-green-300 bg-green-50/50'
                        return (
                          <div key={groupKey} className={`rounded-lg p-3 border-2 ${borderColor}`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex flex-wrap gap-1">
                                {placements.map((loc, j) => (
                                  <span key={j} className="text-[10px] font-bold bg-violet-200 text-violet-900 px-2 py-0.5 rounded uppercase">
                                    {loc.replace(/_/g, ' ')}
                                  </span>
                                ))}
                              </div>
                              <span className="text-[10px] text-gray-500 font-medium">{group.keywords.length} keywords \u00b7 {totalVol.toLocaleString()} searches/mo</span>
                            </div>
                            <p className="text-xs text-gray-800 leading-relaxed bg-white rounded p-2 border border-gray-200 mb-2 italic">
                              &ldquo;{group.text.length > 250 ? group.text.slice(0, 250) + '\u2026' : group.text}&rdquo;
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {group.keywords.sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0)).map((kw, kwIdx) => (
                                <span key={kwIdx} className={`inline-flex items-center gap-1 text-[9px] font-medium px-2 py-1 rounded-full border ${
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
                  </div>
                )
              })()}

              {/* Keyword inclusion indicator */}
              {aiRecs.keyword_opportunities_used !== undefined && !aiRecs.keyword_reconciliation?.length && (
                <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-violet-700 font-medium">
                    ✓ {aiRecs.keyword_opportunities_used} keyword opportunities incorporated
                  </p>
                </div>
              )}

              {/* Title */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                  Title <span className="font-normal normal-case text-gray-400">({aiRecs.recommended_title.length} chars)</span>
                </p>
                <p className={`text-sm text-gray-900 bg-gray-50 rounded-lg p-3 border ${
                  aiRecs.recommended_title.length > 200 ? 'border-red-300 bg-red-50' : 'border-gray-200'
                }`}>
                  {aiRecs.recommended_title}
                </p>
                {aiRecs.recommended_title.length > 200 && (
                  <p className="text-xs text-red-600 mt-1">⚠ Exceeds 200-char limit — review before publishing</p>
                )}
              </div>

              {/* Bullets */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Bullets</p>
                <ol className="space-y-1.5">
                  {aiRecs.recommended_bullets.map((b, i) => (
                    <li key={i} className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3 border border-gray-200">
                      <span className="text-gray-400 text-xs mr-1">{i + 1}.</span>{b}
                      {b.length > 500 && (
                        <span className="text-red-500 text-[10px] ml-1">⚠ {b.length} chars</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Backend keywords */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                  Backend Keywords <span className="font-normal normal-case text-gray-400">({new TextEncoder().encode(aiRecs.recommended_keywords).length} bytes)</span>
                </p>
                <p className={`text-sm text-gray-900 bg-gray-50 rounded-lg p-3 border font-mono text-xs ${
                  new TextEncoder().encode(aiRecs.recommended_keywords).length > 250 ? 'border-red-300 bg-red-50' : 'border-gray-200'
                }`}>
                  {aiRecs.recommended_keywords}
                </p>
                {new TextEncoder().encode(aiRecs.recommended_keywords).length > 250 && (
                  <p className="text-xs text-red-600 mt-1">⚠ Exceeds 250-byte limit — trim before publishing</p>
                )}
              </div>

              {/* Description */}
              {aiRecs.recommended_description && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</p>
                  <div
                    className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3 border border-gray-200 prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: aiRecs.recommended_description }}
                  />
                </div>
              )}

              {/* Cannibalization Warnings */}
              {aiRecs.cannibalization_warnings && aiRecs.cannibalization_warnings.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide mb-1">
                    ⚠ Cannibalization Warnings ({aiRecs.cannibalization_warnings.length})
                  </p>
                  <div className="space-y-2">
                    {aiRecs.cannibalization_warnings.map((w, i) => (
                      <div key={i} className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                        <p className="text-sm font-medium text-orange-900">
                          <span className="font-mono bg-orange-100 px-1 rounded text-xs">{w.keyword}</span>
                        </p>
                        <p className="text-xs text-orange-700 mt-1">{w.issue}</p>
                        <p className="text-xs text-orange-800 mt-1 font-medium">Fix: {w.recommendation}</p>
                        <p className="text-[10px] text-orange-500 mt-0.5">Affected: {w.affected_skus.join(', ')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Product Details Improvements */}
              {aiRecs.product_details_improvements && aiRecs.product_details_improvements.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">
                    📋 Product Details Improvements ({aiRecs.product_details_improvements.length})
                  </p>
                  <div className="space-y-1.5">
                    {aiRecs.product_details_improvements.map((imp, i) => (
                      <div key={i} className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                        <div className="flex items-start justify-between">
                          <p className="text-sm font-medium text-blue-900">{imp.field_name}</p>
                        </div>
                        {imp.current_value && (
                          <p className="text-xs text-gray-500 mt-0.5 line-through">{imp.current_value}</p>
                        )}
                        <p className="text-xs text-blue-800 mt-0.5 font-medium">→ {imp.recommended_value}</p>
                        <p className="text-[10px] text-blue-600 mt-0.5">{imp.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[10px] text-gray-400">
                Generated: {new Date(aiRecs.generated_at).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
