'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ProductRecommendation, ReplenishmentStatus } from '@/lib/fba/replenishment'

const STATUS_CONFIG: Record<ReplenishmentStatus, { label: string; color: string; bg: string; border: string }> = {
  stocked_out:   { label: 'Stocked Out',       color: 'text-red-700',    bg: 'bg-red-100',    border: 'border-red-300' },
  critical:      { label: 'Critical',           color: 'text-red-600',    bg: 'bg-red-50',     border: 'border-red-200' },
  replenish:     { label: 'Replenish Now',       color: 'text-orange-700', bg: 'bg-orange-100', border: 'border-orange-300' },
  new_candidate: { label: 'Create FBA Listing', color: 'text-blue-700',   bg: 'bg-blue-100',   border: 'border-blue-300' },
  watch:         { label: 'Watch',              color: 'text-yellow-700', bg: 'bg-yellow-100', border: 'border-yellow-300' },
  healthy:       { label: 'Healthy',            color: 'text-green-700',  bg: 'bg-green-100',  border: 'border-green-300' },
  overstocked:   { label: 'Overstocked',        color: 'text-purple-700', bg: 'bg-purple-100', border: 'border-purple-300' },
  no_data:       { label: 'No Data',            color: 'text-gray-500',   bg: 'bg-gray-100',   border: 'border-gray-200' },
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

interface SyncResult {
  asinsFromOrders: number
  inventoryUpserted: number
  salesReportAsins: number
  errors: string[]
  durationMs: number
}

export default function FBAIntelligencePage() {
  const [report, setReport] = useState<ProductRecommendation[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReplenishmentStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [lastSynced, setLastSynced] = useState<string | null>(null)

  const getToken = async () => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  const fetchReport = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
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
    setSyncResult(null)
    try {
      const token = await getToken()
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
      setSyncResult(data.sync || null)
      setLastSynced(new Date().toLocaleString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const downloadCSV = async (type: 'csv' | 'shipment') => {
    const token = await getToken()
    const resp = await fetch(`/api/fba/replenishment?format=${type}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!resp.ok) return

    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = type === 'shipment'
      ? `amazon-shipment-${new Date().toISOString().split('T')[0]}.csv`
      : `fba-report-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => { fetchReport() }, [fetchReport])

  const filtered = report.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return r.asin.toLowerCase().includes(q) ||
             r.sku.toLowerCase().includes(q) ||
             r.title.toLowerCase().includes(q)
    }
    return true
  })

  const urgentCount = (summary?.stocked_out || 0) + (summary?.critical || 0) + (summary?.replenish || 0)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">FBA Intelligence</h1>
          <p className="text-sm text-gray-500 mt-1">
            Replenishment recommendations based on your order history and FBA inventory.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSynced && (
            <span className="text-xs text-gray-400">Last synced: {lastSynced}</span>
          )}
          <button
            onClick={() => downloadCSV('csv')}
            disabled={report.length === 0}
            className="px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            Team CSV
          </button>
          <button
            onClick={() => downloadCSV('shipment')}
            disabled={report.length === 0}
            className="px-3 py-2 text-xs border border-orange-200 rounded-lg text-orange-700 hover:bg-orange-50 disabled:opacity-40 transition-colors"
          >
            Amazon Shipment CSV
          </button>
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {syncing ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Syncing FBA Data…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync FBA Data
              </>
            )}
          </button>
        </div>
      </div>

      {/* Sync explanation banner */}
      {!lastSynced && !loading && (
        <div className="mb-5 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
          <strong>How this works:</strong> Click <strong>Sync FBA Data</strong> to pull FBA inventory levels and sales data
          for only the ASINs you actually sell (based on your order history). No full catalog import — only your active products.
          The Sales &amp; Traffic Report may take 2–4 minutes to generate on Amazon&apos;s side.
        </div>
      )}

      {/* Sync result */}
      {syncResult && (
        <div className="mb-5 p-4 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          <strong>Sync complete</strong> in {(syncResult.durationMs / 1000).toFixed(1)}s —{' '}
          {syncResult.asinsFromOrders} ASINs from your orders,{' '}
          {syncResult.inventoryUpserted} FBA inventory records updated,{' '}
          {syncResult.salesReportAsins} ASINs in Sales &amp; Traffic Report.
          {syncResult.errors.length > 0 && (
            <div className="mt-2 text-amber-700">
              <strong>Warnings:</strong> {syncResult.errors.join('; ')}
            </div>
          )}
        </div>
      )}

      {/* Urgent alert */}
      {urgentCount > 0 && (
        <div className="mb-5 p-4 bg-red-50 border border-red-300 rounded-xl flex items-center gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-red-800">
              {urgentCount} product{urgentCount !== 1 ? 's' : ''} need immediate attention
            </p>
            <p className="text-xs text-red-600 mt-0.5">
              {summary?.stocked_out ? `${summary.stocked_out} stocked out` : ''}
              {summary?.stocked_out && summary?.critical ? ', ' : ''}
              {summary?.critical ? `${summary.critical} critical` : ''}
              {(summary?.stocked_out || summary?.critical) && summary?.replenish ? ', ' : ''}
              {summary?.replenish ? `${summary.replenish} need replenishment` : ''}
            </p>
          </div>
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { key: 'all', label: 'All Products', count: summary.total, color: 'text-gray-700', bg: 'bg-white' },
            { key: 'stocked_out', label: 'Stocked Out', count: summary.stocked_out, color: 'text-red-700', bg: 'bg-red-50' },
            { key: 'critical', label: 'Critical', count: summary.critical, color: 'text-red-600', bg: 'bg-red-50' },
            { key: 'replenish', label: 'Replenish Now', count: summary.replenish, color: 'text-orange-700', bg: 'bg-orange-50' },
            { key: 'new_candidate', label: 'Create FBA', count: summary.new_candidates, color: 'text-blue-700', bg: 'bg-blue-50' },
            { key: 'watch', label: 'Watch', count: summary.watch, color: 'text-yellow-700', bg: 'bg-yellow-50' },
            { key: 'healthy', label: 'Healthy', count: summary.healthy, color: 'text-green-700', bg: 'bg-green-50' },
            { key: 'overstocked', label: 'Overstocked', count: summary.overstocked, color: 'text-purple-700', bg: 'bg-purple-50' },
          ].map(card => (
            <button
              key={card.key}
              onClick={() => setFilter(card.key as ReplenishmentStatus | 'all')}
              className={`${card.bg} border rounded-xl p-3 text-left transition-all ${
                filter === card.key ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className={`text-2xl font-bold ${card.color}`}>{card.count}</div>
              <div className="text-xs text-gray-500 mt-0.5">{card.label}</div>
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by ASIN, SKU, or title…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <svg className="w-6 h-6 animate-spin mr-3" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          Loading recommendations…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          {report.length === 0 ? (
            <div>
              <p className="text-base font-medium text-gray-500 mb-2">No data yet</p>
              <p className="text-sm">Click <strong>Sync FBA Data</strong> to generate your first recommendations.</p>
            </div>
          ) : (
            <p>No products match your current filter.</p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Product</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">FBM 30d</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">FBA Avail.</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">FBA Inbound</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">FBA Sold 30d</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Wks Cover</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Send Qty</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((rec) => {
                  const cfg = STATUS_CONFIG[rec.status]
                  return (
                    <tr key={rec.asin} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2">
                          <div>
                            <div className="font-medium text-gray-900 text-xs leading-tight max-w-xs truncate">
                              {rec.title}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-gray-400 font-mono">{rec.asin}</span>
                              {rec.sku && <span className="text-xs text-gray-400">· {rec.sku}</span>}
                              {rec.has_customization && (
                                <span className="px-1.5 py-0.5 text-xs font-bold bg-red-100 text-red-700 rounded">CUSTOM</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${cfg.bg} ${cfg.color} border ${cfg.border}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 font-medium">
                        {rec.fbm_units_30d > 0 ? rec.fbm_units_30d : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={rec.fba_qty_available === 0 ? 'text-red-500 font-bold' : 'text-gray-700'}>
                          {rec.fba_qty_available}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {rec.fba_qty_inbound > 0 ? (
                          <span className="text-blue-600">+{rec.fba_qty_inbound}</span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {rec.fba_units_sold_30d > 0 ? rec.fba_units_sold_30d : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {rec.weeks_of_cover !== null ? (
                          <span className={rec.weeks_of_cover < 2 ? 'text-red-600 font-bold' : rec.weeks_of_cover < 4 ? 'text-orange-600' : 'text-gray-600'}>
                            {rec.weeks_of_cover.toFixed(1)}w
                          </span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {rec.recommended_send_qty > 0 ? (
                          <span className="font-bold text-gray-900">{rec.recommended_send_qty}</span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {rec.status === 'new_candidate' ? (
                          <a
                            href={`https://sellercentral.amazon.com/inventory/ref=xx_invmgr_dnav_xx?tbla_myitable=sort:%7B%22sortOrder%22%3A%22DESCENDING%22%2C%22sortedColumnId%22%3A%22date%22%7D;search:${rec.asin};`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:text-blue-800 underline whitespace-nowrap"
                          >
                            Create in SC →
                          </a>
                        ) : rec.recommended_send_qty > 0 ? (
                          <span className="text-xs text-gray-400 italic">Send {rec.recommended_send_qty} units</span>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-400">
            Showing {filtered.length} of {report.length} products
            {!lastSynced && ' · FBA inventory data not yet synced — click "Sync FBA Data" to populate'}
          </div>
        </div>
      )}
    </div>
  )
}
