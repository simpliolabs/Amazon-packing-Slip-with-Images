/**
 * KeywordIntelligencePanel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shows keyword opportunity analysis for a single child ASIN.
 *
 * Displays:
 * - Summary counts (Critical / Upgrade / Reinforce / Defended)
 * - Filter bar (ALL / CRITICAL / UPGRADE / REINFORCE / DEFENDED)
 * - Ranked keyword rows with score, action badge, volume, and action text
 * - Refresh button + data source label
 *
 * Karpathy: Goal-Driven — shows exactly what the plan specifies, nothing more.
 * Progressive disclosure: full keyword table is paginated (top 10 visible, expand for rest).
 */

'use client'

import { useState } from 'react'
import { KeywordActionBadge } from './KeywordActionBadge'

// ─── Types (mirrors engine.ts AnalyzedKeyword) ────────────────────────────────

type ActionType = 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED'

interface AnalyzedKeyword {
  keyword: string
  opportunityScore: number
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

interface Props {
  asin: string
  data: IntelligenceResult | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

// ─── Presence Pills ───────────────────────────────────────────────────────────

function PresencePill({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
      active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
    }`}>
      {label}
    </span>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type FilterType = 'ALL' | 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED'

export function KeywordIntelligencePanel({ asin, data, loading, error, onRefresh }: Props) {
  const [filter, setFilter] = useState<FilterType>('ALL')
  const [showAll, setShowAll] = useState(false)

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-500">Analyzing keyword opportunities…</p>
        <p className="text-xs text-gray-400">This may take 30–60 seconds on first run</p>
      </div>
    )
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="text-2xl">⚠️</div>
        <p className="text-sm text-red-600 font-medium">Analysis failed</p>
        <p className="text-xs text-gray-500 text-center max-w-xs">{error}</p>
        <button
          onClick={onRefresh}
          className="text-xs font-medium text-violet-600 hover:text-violet-800 underline"
        >
          Try again
        </button>
      </div>
    )
  }

  // ── No data state ──
  if (!data || data.topOpportunities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="text-2xl">🔍</div>
        <p className="text-sm text-gray-700 font-medium">No keyword data yet</p>
        <p className="text-xs text-gray-500 text-center max-w-xs">
          {data?.message ?? 'Click "Analyze Keywords" to fetch data from Brand Analytics.'}
        </p>
        <button
          onClick={onRefresh}
          className="text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg px-4 py-2 transition-colors"
        >
          Analyze Keywords
        </button>
      </div>
    )
  }

  // ── Filter keywords ──
  const filtered = filter === 'ALL'
    ? data.topOpportunities
    : data.topOpportunities.filter(k => k.actionType === filter)

  const visible = filtered.slice(0, 5)

  // ── Data source label ──
  const sourceLabel = {
    sqp: 'Brand Analytics (SQP)',
    jungle_scout: 'Jungle Scout',
    inherited: 'Category siblings (no direct sales data)',
  }[data.dataSource]

  return (
    <div className="space-y-4">

      {/* Summary counts */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Critical',  count: data.summary.critical,  color: 'text-red-600',   bg: 'bg-red-50'   },
          { label: 'Upgrade',   count: data.summary.upgrade,   color: 'text-amber-600', bg: 'bg-amber-50' },
          { label: 'Reinforce', count: data.summary.reinforce, color: 'text-blue-600',  bg: 'bg-blue-50'  },
          { label: 'Defended',  count: data.summary.defended,  color: 'text-green-600', bg: 'bg-green-50' },
        ].map(({ label, count, color, bg }) => (
          <div key={label} className={`${bg} rounded-lg p-2 text-center`}>
            <p className={`text-xl font-bold ${color}`}>{count}</p>
            <p className="text-[10px] text-gray-500">{label}</p>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex gap-1.5 flex-wrap">
        {(['ALL', 'CRITICAL', 'UPGRADE', 'REINFORCE', 'DEFENDED'] as FilterType[]).map(f => (
          <button
            key={f}
            onClick={() => { setFilter(f); setShowAll(false) }}
            className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
              filter === f
                ? 'bg-violet-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f === 'ALL' ? 'All' : f}
          </button>
        ))}
      </div>

      {/* Keyword rows */}
      <div className="space-y-2">
        {visible.map((kw) => (
          <div
            key={kw.keyword}
            className="border border-gray-200 rounded-lg p-3 hover:border-violet-300 transition-colors"
          >
            {/* Row header */}
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="text-sm font-semibold text-gray-900 truncate">{kw.keyword}</span>
                <KeywordActionBadge type={kw.actionType} />
              </div>
              <span className="shrink-0 text-sm font-bold text-violet-700">{kw.opportunityScore}</span>
            </div>

            {/* Action text */}
            <p className="text-xs text-gray-700 mb-2">{kw.actionText}</p>

            {/* Metrics row */}
            <div className="flex items-center gap-3 text-[10px] text-gray-500 flex-wrap">
              <span><span className="font-medium text-gray-700">{kw.searchVolume.toLocaleString()}</span> vol/mo</span>
              {kw.competingProducts > 0 && (
                <span><span className="font-medium text-gray-700">{kw.competingProducts.toLocaleString()}</span> competing</span>
              )}
              {kw.keywordSales > 0 && (
                <span><span className="font-medium text-gray-700">{kw.keywordSales}</span> sales</span>
              )}
              {kw.asinPurchaseShare > 0 && (
                <span><span className="font-medium text-gray-700">{kw.asinPurchaseShare.toFixed(1)}%</span> our share</span>
              )}
            </div>

            {/* Presence pills */}
            <div className="flex items-center gap-1 mt-2">
              <span className="text-[9px] text-gray-400 mr-1">In listing:</span>
              <PresencePill label="Title" active={kw.inTitle} />
              <PresencePill label="Bullets" active={kw.inBullets} />
              <PresencePill label="Desc" active={kw.inDescription} />
              <PresencePill label="Backend" active={kw.inBackend} />
            </div>
          </div>
        ))}
      </div>

      {filtered.length > 5 && (
        <p className="text-[10px] text-gray-400 text-center py-1">
          Showing top 5 of {filtered.length} keywords
        </p>
      )}

      {/* Footer: data source + last updated + refresh */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <div>
          <p className="text-[10px] text-gray-400">Source: {sourceLabel}</p>
          <p className="text-[10px] text-gray-400">
            Updated: {new Date(data.analyzedAt).toLocaleDateString()}
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="text-xs text-violet-600 hover:text-violet-800 font-medium"
        >
          Refresh ↻
        </button>
      </div>
    </div>
  )
}
// Build trigger: Sat May 30 17:37:36 EDT 2026
