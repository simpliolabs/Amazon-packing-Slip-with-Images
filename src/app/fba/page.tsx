'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ProductRecommendation, ReplenishmentStatus } from '@/lib/fba/replenishment'

const STATUS_CONFIG: Record<ReplenishmentStatus, { label: string; color: string; bg: string; dot: string }> = {
  stocked_out:   { label: 'Stocked Out',        color: 'text-red-700',    bg: 'bg-red-100',    dot: 'bg-red-500' },
  critical:      { label: 'Critical',            color: 'text-red-600',    bg: 'bg-red-50',     dot: 'bg-red-400' },
  replenish:     { label: 'Replenish Now',        color: 'text-orange-700', bg: 'bg-orange-100', dot: 'bg-orange-500' },
  new_candidate: { label: 'Create FBA Listing',  color: 'text-blue-700',   bg: 'bg-blue-100',   dot: 'bg-blue-500' },
  watch:         { label: 'Watch',               color: 'text-yellow-700', bg: 'bg-yellow-100', dot: 'bg-yellow-500' },
  healthy:       { label: 'Healthy',             color: 'text-green-700',  bg: 'bg-green-100',  dot: 'bg-green-500' },
  overstocked:   { label: 'Overstocked',         color: 'text-purple-700', bg: 'bg-purple-100', dot: 'bg-purple-500' },
  no_data:       { label: 'No Data',             color: 'text-gray-500',   bg: 'bg-gray-100',   dot: 'bg-gray-400' },
}

interface Summary {
  total: number
  critical: number
  stocked_out: number
  replenish: number
  new_candidates: number
  watch: number
  healthy: number
  overstocked: number
}

export default function FBAIntelligencePage() {
  const [report, setReport] = useState<ProductRecommendation[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReplenishmentStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [lastSynced, setLastSynced] = useState<string | null>(null)

  const fetchReport = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const resp = await fetch('/api/fba/replenishment', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      if (!resp.ok) {
        const err = await resp.json()
        throw new Error(err.error || 'Failed to load report')
      }

      const data = await resp.json()
      setReport(data.report || [])
      setSummary(data.summary || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  const triggerSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const resp = await fetch('/api/fba/replenishment', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      if (!resp.ok) {
        const err = await resp.json()
        throw new Error(err.error || 'Sync failed')
      }

      const data = await resp.json()
      setReport(data.report || [])
      setSummary(data.summary || null)
      setLastSynced(new Date().toLocaleString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const downloadCSV = async (type: 'csv' | 'shipment') => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token

    const resp = await fetch(`/api/fba/replenishment?format=${type}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = type === 'shipment'
      ? `amazon-shipment-${new Date().toISOString().split('T')[0]}.csv`
      : `fba-replenishment-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => { fetchReport() }, [fetchReport])

  const filtered = report.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return r.title?.toLowerCase().includes(q) ||
             r.sku?.toLowerCase().includes(q) ||
             r.fbm_asin?.toLowerCase().includes(q) ||
             r.fba_asin?.toLowerCase().includes(q)
    }
    return true
  })

  const urgentCount = (summary?.critical || 0) + (summary?.stocked_out || 0) + (summary?.replenish || 0)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">FBA Intelligence</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Replenishment recommendations based on FBM velocity &amp; FBA inventory
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastSynced && (
              <span className="text-xs text-gray-400">Last synced: {lastSynced}</span>
            )}
            <button
              onClick={() => downloadCSV('shipment')}
              disabled={loading || report.length === 0}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Amazon Shipment CSV
            </button>
            <button
              onClick={() => downloadCSV('csv')}
              disabled={loading || report.length === 0}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Team Report CSV
            </button>
            <button
              onClick={triggerSync}
              disabled={syncing}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {syncing ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Syncing...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Sync Catalog
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {[
              { key: 'stocked_out', label: 'Stocked Out', value: summary.stocked_out, color: 'bg-red-500' },
              { key: 'critical', label: 'Critical', value: summary.critical, color: 'bg-red-400' },
              { key: 'replenish', label: 'Replenish', value: summary.replenish, color: 'bg-orange-500' },
              { key: 'new_candidates', label: 'New FBA', value: summary.new_candidates, color: 'bg-blue-500' },
              { key: 'watch', label: 'Watch', value: summary.watch, color: 'bg-yellow-500' },
              { key: 'healthy', label: 'Healthy', value: summary.healthy, color: 'bg-green-500' },
              { key: 'overstocked', label: 'Overstocked', value: summary.overstocked, color: 'bg-purple-500' },
              { key: 'all', label: 'Total', value: summary.total, color: 'bg-gray-400' },
            ].map(card => (
              <button
                key={card.key}
                onClick={() => setFilter(card.key as ReplenishmentStatus | 'all')}
                className={`bg-white rounded-lg border p-3 text-left transition-all ${
                  filter === card.key ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${card.color} mb-2`} />
                <div className="text-xl font-bold text-gray-900">{card.value}</div>
                <div className="text-xs text-gray-500">{card.label}</div>
              </button>
            ))}
          </div>
        )}

        {/* Urgent Alert Banner */}
        {urgentCount > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-700 font-medium text-sm">
              {urgentCount} product{urgentCount !== 1 ? 's' : ''} need immediate attention — send to FBA now to avoid stockouts.
            </span>
          </div>
        )}

        {/* Filters + Search */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search by title, SKU, or ASIN..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {filter !== 'all' && (
            <button
              onClick={() => setFilter('all')}
              className="text-sm text-blue-600 hover:underline"
            >
              Clear filter
            </button>
          )}
          <span className="text-sm text-gray-500 ml-auto">
            {filtered.length} product{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <svg className="w-6 h-6 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="ml-3 text-gray-500">Loading replenishment data...</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <p className="font-medium">No products found</p>
              <p className="text-sm mt-1">
                {report.length === 0
                  ? 'Click "Sync Catalog" to fetch your Amazon listings'
                  : 'Try adjusting your filters'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Product</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">FBM 30d</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Vel/Day</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">FBA Stock</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Inbound</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">Wks Cover</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600 bg-blue-50">Send Qty</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((r, idx) => {
                    const cfg = STATUS_CONFIG[r.status]
                    return (
                      <tr key={`${r.fbm_asin}-${idx}`} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.color}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <div className="font-medium text-gray-900 truncate" title={r.title}>
                            {r.title || r.fbm_asin}
                          </div>
                          <div className="text-xs text-gray-400 mt-0.5 space-x-2">
                            <span>SKU: {r.sku || '—'}</span>
                            <span>FBM: {r.fbm_asin}</span>
                            {r.fba_asin && <span>FBA: {r.fba_asin}</span>}
                          </div>
                          {r.has_customization && (
                            <span className="inline-block mt-1 px-1.5 py-0.5 text-xs bg-red-100 text-red-600 rounded font-medium">
                              CUSTOM
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {r.fbm_units_30d}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {r.velocity_per_day > 0 ? r.velocity_per_day.toFixed(2) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          <span className={r.fba_qty_available === 0 && r.fba_asin ? 'text-red-600' : 'text-gray-900'}>
                            {r.fba_asin ? r.fba_qty_available : '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {r.fba_asin ? r.fba_qty_inbound : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {r.weeks_of_cover !== null ? (
                            <span className={
                              r.weeks_of_cover < 2 ? 'text-red-600 font-bold' :
                              r.weeks_of_cover < 4 ? 'text-orange-600 font-medium' :
                              r.weeks_of_cover > 12 ? 'text-purple-600' :
                              'text-gray-900'
                            }>
                              {r.weeks_of_cover >= 100 ? '∞' : `${r.weeks_of_cover}w`}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right bg-blue-50">
                          {r.recommended_send_qty > 0 ? (
                            <span className="font-bold text-blue-700 text-base">
                              {r.recommended_send_qty}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 max-w-xs">
                          <span className="line-clamp-2" title={r.send_rationale}>
                            {r.send_rationale}
                          </span>
                          {r.status === 'new_candidate' && (
                            <a
                              href={`https://sellercentral.amazon.com/skucentral?mSku=${encodeURIComponent(r.sku)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline mt-1 block"
                            >
                              Create in Seller Central →
                            </a>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
