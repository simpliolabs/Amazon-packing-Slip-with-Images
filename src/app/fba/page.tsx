'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ProductRecommendation, ReplenishmentStatus } from '@/lib/fba/replenishment'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExcessItem {
  id: string
  asin: string
  sku: string
  fnsku: string | null
  product_name: string
  qty_available: number
  excess_qty: number
  days_of_supply: number
  units_sold_last_30_days: number
  your_price: number
  estimated_monthly_storage_fee: number
  estimated_storage_cost_per_unit: number
  amazon_alert: string | null
  amazon_recommended_action: string | null
  ai_action_plan: string | null
  ai_plan_generated_at: string | null
  action_taken: string | null
  action_taken_at: string | null
  action_notes: string | null
  recheck_due_at: string | null
  recheck_completed_at: string | null
  recheck_outcome: string | null
  outcome_excess_qty: number | null
  status: string
  first_detected_at: string
  last_synced_at: string
}

interface ExcessSummary {
  total: number
  active: number
  actioned: number
  resolved: number
  escalated: number
  total_excess_units: number
  total_monthly_storage_cost: number
  needs_ai_plan: number
}

interface SkuSalesRow {
  sku: string
  asin: string | null
  product_name: string | null
  units_sold_7d: number
  units_sold_30d: number
  units_sold_90d: number
  revenue_30d: number
  avg_daily_units: number
  fulfillment_channel: string | null
  last_order_date: string | null
  last_synced_at: string
}
interface ListingIssue {
  sku: string
  asin: string | null
  product_name: string | null
  issue_type: 'suppressed' | 'zero_price' | 'fba_no_stock' | 'fbm_no_fba'
  issue_label: string
  severity: 'critical' | 'warning' | 'opportunity'
  detail: string
  price: number | null
  quantity: number
  fulfillment_channel: string | null
  units_sold_30d: number
  estimated_lost_revenue_30d: number | null
}
interface ListingIssuesSummary {
  total: number
  critical: number
  warning: number
  opportunity: number
  total_lost_revenue: number
}
interface FBANotification {
  id: string
  type: string
  title: string
  message: string
  asin: string | null
  sku: string | null
  is_read: boolean
  created_at: string
}

interface ReplenishmentSummary {
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
  excessItemsFound?: number
  errors: string[]
  durationMs: number
}

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<ReplenishmentStatus, { label: string; color: string; bg: string; border: string }> = {
  stocked_out:   { label: 'No FBA Stock',         color: 'text-red-700',    bg: 'bg-red-100',    border: 'border-red-300' },
  critical:      { label: 'Send Urgently',         color: 'text-red-600',    bg: 'bg-red-50',     border: 'border-red-200' },
  replenish:     { label: 'Send Now',              color: 'text-orange-700', bg: 'bg-orange-100', border: 'border-orange-300' },
  new_candidate: { label: 'Start Selling on FBA',  color: 'text-blue-700',   bg: 'bg-blue-100',   border: 'border-blue-300' },
  watch:         { label: 'Monitor',               color: 'text-yellow-700', bg: 'bg-yellow-100', border: 'border-yellow-300' },
  healthy:       { label: 'FBA Covered',           color: 'text-green-700',  bg: 'bg-green-100',  border: 'border-green-300' },
  overstocked:   { label: 'Pause Shipments',       color: 'text-purple-700', bg: 'bg-purple-100', border: 'border-purple-300' },
  no_data:       { label: 'No Data',              color: 'text-gray-500',   bg: 'bg-gray-100',   border: 'border-gray-200' },
}

const URGENCY_CONFIG = {
  critical: { label: 'Critical', color: 'text-red-700', bg: 'bg-red-100', border: 'border-red-300' },
  high:     { label: 'High',     color: 'text-orange-700', bg: 'bg-orange-100', border: 'border-orange-300' },
  medium:   { label: 'Medium',   color: 'text-yellow-700', bg: 'bg-yellow-100', border: 'border-yellow-300' },
  low:      { label: 'Low',      color: 'text-gray-600',   bg: 'bg-gray-100',   border: 'border-gray-200' },
}

const ACTION_LABELS: Record<string, string> = {
  ran_sale: 'Ran a Sale',
  created_outlet_deal: 'Created Outlet Deal',
  removed: 'Initiated Removal',
  held: 'Held — No Action',
  pending: 'Pending',
}

const EXCESS_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  active:    { label: 'Needs Action',  color: 'text-orange-700', bg: 'bg-orange-50' },
  actioned:  { label: 'Action Taken',  color: 'text-blue-700',   bg: 'bg-blue-50' },
  resolved:  { label: 'Resolved',      color: 'text-green-700',  bg: 'bg-green-50' },
  escalated: { label: 'Escalated',     color: 'text-red-700',    bg: 'bg-red-50' },
  dismissed: { label: 'Dismissed',     color: 'text-gray-500',   bg: 'bg-gray-50' },
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FBAIntelligencePage() {
  const [activeTab, setActiveTab] = useState<'replenishment' | 'excess' | 'analytics' | 'listings'>('replenishment')
  const [salesAnalytics, setSalesAnalytics] = useState<SkuSalesRow[]>([])
  const [listingIssues, setListingIssues] = useState<ListingIssue[]>([])
  const [listingIssuesSummary, setListingIssuesSummary] = useState<ListingIssuesSummary | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [listingsLoading, setListingsLoading] = useState(false)

  // Replenishment state
  const [report, setReport] = useState<ProductRecommendation[]>([])
  const [replenishSummary, setReplenishSummary] = useState<ReplenishmentSummary | null>(null)
  const [replenishLoading, setReplenishLoading] = useState(true)
  const [filter, setFilter] = useState<ReplenishmentStatus | 'all'>('all')
  const [search, setSearch] = useState('')

  // Excess state
  const [excessItems, setExcessItems] = useState<ExcessItem[]>([])
  const [excessSummary, setExcessSummary] = useState<ExcessSummary | null>(null)
  const [excessLoading, setExcessLoading] = useState(true)
  const [excessFilter, setExcessFilter] = useState<string>('all')
  const [generatingPlan, setGeneratingPlan] = useState<string | null>(null) // SKU being generated
  const [expandedItem, setExpandedItem] = useState<string | null>(null)     // SKU expanded

  // Notifications
  const [notifications, setNotifications] = useState<FBANotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [showNotifications, setShowNotifications] = useState(false)

  // Shared state
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSynced, setLastSynced] = useState<string | null>(null)

  const getToken = async () => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  // ── Fetch replenishment report ──────────────────────────────────────────────
  const fetchReport = useCallback(async () => {
    setReplenishLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/replenishment', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to load report')
      const data = await resp.json()
      setReport(data.report || [])
      setReplenishSummary(data.summary || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setReplenishLoading(false)
    }
  }, [])

  // ── Fetch excess inventory ──────────────────────────────────────────────────
  const fetchExcess = useCallback(async () => {
    setExcessLoading(true)
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/excess', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to load excess data')
      const data = await resp.json()
      setExcessItems(data.items || [])
      setExcessSummary(data.summary || null)
    } catch (err) {
      console.error('Excess fetch error:', err)
    } finally {
      setExcessLoading(false)
    }
  }, [])

  // ── Fetch notifications ─────────────────────────────────────────────────────
  const fetchNotifications = useCallback(async () => {
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/notifications', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!resp.ok) return
      const data = await resp.json()
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch {
      // Non-fatal
    }
  }, [])

  // ── Sync FBA data ───────────────────────────────────────────────────────────
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
        const text = await resp.text()
        let errMsg = 'Sync failed'
        try { errMsg = JSON.parse(text).error || errMsg } catch { errMsg = resp.status === 502 ? 'Sync is running in the background. Refreshing data...' : text || errMsg }
        // Even on 502, the sync is running server-side. Wait and reload.
        if (resp.status === 502) {
          setError('Sync is running in the background. Refreshing data in 15 seconds...')
          await new Promise(r => setTimeout(r, 15000))
          await fetchReport()
          await fetchExcess()
          await fetchNotifications()
          await fetchSalesAnalytics()
          await fetchListingIssues()
          setError(null)
          setLastSynced(new Date().toLocaleString())
          return
        }
        throw new Error(errMsg)
      }
      const data = await resp.json()
      // Handle partial response (sync still running in background)
      if (data.partial) {
        setError('Sync is running in the background. Refreshing data in 15 seconds...')
        await new Promise(r => setTimeout(r, 15000))
        await fetchReport()
        await fetchExcess()
        await fetchNotifications()
        await fetchSalesAnalytics()
        await fetchListingIssues()
        setError(null)
        setLastSynced(new Date().toLocaleString())
        return
      }
      setReport(data.report || [])
      setReplenishSummary(data.summary || null)
      setSyncResult(data.sync || null)
      setLastSynced(new Date().toLocaleString())
      // Refresh all tabs after sync
      await fetchExcess()
      await fetchNotifications()
      await fetchSalesAnalytics()
      await fetchListingIssues()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  // ── Generate AI plan for an excess item ────────────────────────────────────
  const generatePlan = async (sku: string, isReanalysis = false) => {
    setGeneratingPlan(sku)
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/excess', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sku, is_reanalysis: isReanalysis }),
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to generate plan')
      await fetchExcess()
      setExpandedItem(sku)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate AI plan')
    } finally {
      setGeneratingPlan(null)
    }
  }

  // ── Update action taken ─────────────────────────────────────────────────────
  const updateAction = async (sku: string, action: string) => {
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/excess', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sku, action }),
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to update action')
      await fetchExcess()
      await fetchNotifications()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update action')
    }
  }

  // ── Mark notifications read ─────────────────────────────────────────────────
  const markAllRead = async () => {
    try {
      const token = await getToken()
      await fetch('/api/fba/notifications', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ all: true }),
      })
      setUnreadCount(0)
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
    } catch {
      // Non-fatal
    }
  }

  // ── CSV downloads ───────────────────────────────────────────────────────────
  const downloadCSV = async (type: 'csv' | 'shipment' | 'excess') => {
    const token = await getToken()
    const url = type === 'excess'
      ? '/api/fba/excess?format=csv'
      : `/api/fba/replenishment?format=${type}`
    const resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!resp.ok) return
    const blob = await resp.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = type === 'excess'
      ? `excess-inventory-${new Date().toISOString().split('T')[0]}.csv`
      : type === 'shipment'
      ? `amazon-shipment-${new Date().toISOString().split('T')[0]}.csv`
      : `fba-report-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(objUrl)
  }

  useEffect(() => {
    fetchReport()
    fetchExcess()
    fetchNotifications()
    // Poll notifications every 2 minutes
    const interval = setInterval(fetchNotifications, 120000)
    return () => clearInterval(interval)
  }, [fetchReport, fetchExcess, fetchNotifications])

  // ── Filtered replenishment ──────────────────────────────────────────────────
  const [showNoData, setShowNoData] = useState(false)

  const filteredReport = report.filter(r => {
    // Hide no_data rows by default unless toggled on or explicitly filtered
    if (!showNoData && filter === 'all' && r.status === 'no_data') return false
    if (filter !== 'all' && r.status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return r.asin.toLowerCase().includes(q) ||
             r.sku.toLowerCase().includes(q) ||
             r.title.toLowerCase().includes(q)
    }
    return true
  })

  const noDataCount = report.filter(r => r.status === 'no_data').length

  // ── Filtered excess ─────────────────────────────────────────────────────────
  const filteredExcess = excessItems.filter(i => {
    if (excessFilter !== 'all' && i.status !== excessFilter) return false
    return true
  })

  const urgentReplenishCount = (replenishSummary?.stocked_out || 0) + (replenishSummary?.critical || 0) + (replenishSummary?.replenish || 0)

  // ── Urgency helper ──────────────────────────────────────────────────────────
  const getUrgency = (item: ExcessItem): 'critical' | 'high' | 'medium' | 'low' => {
    if (item.days_of_supply > 300 || item.estimated_monthly_storage_fee > 50) return 'critical'
    if (item.days_of_supply > 180 || item.estimated_monthly_storage_fee > 20) return 'high'
    if (item.days_of_supply > 90) return 'medium'
    return 'low'
  }

  // Fetch sales analytics
  const fetchSalesAnalytics = useCallback(async (triggerSync = false) => {
    setAnalyticsLoading(true)
    try {
      if (triggerSync) {
        await fetch('/api/fba/sync-reports').catch(() => {})
        // Wait a moment for sync to complete
        await new Promise(r => setTimeout(r, 2000))
      }
      const resp = await fetch('/api/fba/reports-data?type=sales')
      const json = await resp.json()
      setSalesAnalytics(json.data || [])
    } catch (e) { console.error(e) }
    finally { setAnalyticsLoading(false) }
  }, [])

  // Fetch listing health
  const fetchListingIssues = useCallback(async (triggerSync = false) => {
    setListingsLoading(true)
    try {
      if (triggerSync) {
        await fetch('/api/fba/sync-reports').catch(() => {})
        await new Promise(r => setTimeout(r, 2000))
      }
      const resp = await fetch('/api/fba/listing-issues')
      const json = await resp.json()
      setListingIssues(json.issues || [])
      setListingIssuesSummary(json.summary || null)
    } catch (e) { console.error(e) }
    finally { setListingsLoading(false) }
  }, [])

  // Load data when switching to analytics/listings tabs
  useEffect(() => {
    if (activeTab === 'analytics' && salesAnalytics.length === 0) fetchSalesAnalytics()
    if (activeTab === 'listings' && listingIssues.length === 0) fetchListingIssues()
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">FBA Intelligence</h1>
          <p className="text-sm text-gray-500 mt-1">
            Replenishment recommendations and excess inventory management.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSynced && (
            <span className="text-xs text-gray-400">Last synced: {lastSynced}</span>
          )}

          {/* Notification bell */}
          <div className="relative">
            <button
              onClick={() => { setShowNotifications(!showNotifications); if (unreadCount > 0) markAllRead() }}
              className="relative p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              title="Notifications"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Notification dropdown */}
            {showNotifications && (
              <div className="absolute right-0 top-10 w-96 bg-white border border-gray-200 rounded-xl shadow-xl z-50 max-h-96 overflow-y-auto">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">Notifications</span>
                  <button onClick={() => setShowNotifications(false)} className="text-gray-400 hover:text-gray-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {notifications.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-gray-400">No notifications yet</div>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} className={`px-4 py-3 border-b border-gray-50 ${!n.is_read ? 'bg-blue-50' : ''}`}>
                      <div className="flex items-start gap-2">
                        {!n.is_read && <span className="w-2 h-2 bg-blue-500 rounded-full mt-1.5 flex-shrink-0" />}
                        <div className={!n.is_read ? '' : 'ml-4'}>
                          <p className="text-xs font-semibold text-gray-900">{n.title}</p>
                          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{n.message}</p>
                          <p className="text-xs text-gray-400 mt-1">{new Date(n.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

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
                Syncing…
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

      {/* ── Sync result banner ───────────────────────────────────────────────── */}
      {syncResult && (
        <div className="mb-5 p-4 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          <strong>Sync complete</strong> in {(syncResult.durationMs / 1000).toFixed(1)}s —{' '}
          {syncResult.asinsFromOrders} ASINs from orders,{' '}
          {syncResult.inventoryUpserted} inventory records updated,{' '}
          {syncResult.salesReportAsins} in Sales &amp; Traffic Report
          {syncResult.excessItemsFound !== undefined && `, ${syncResult.excessItemsFound} excess items detected`}.
          {syncResult.errors.length > 0 && (
            <div className="mt-2 text-amber-700">
              <strong>Warnings:</strong> {syncResult.errors.join('; ')}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-6 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('replenishment')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'replenishment'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Replenishment
          {urgentReplenishCount > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-bold">
              {urgentReplenishCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('excess')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'excess'
              ? 'border-orange-500 text-orange-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Clear FBA Stock
          {(excessSummary?.active || 0) > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full font-bold">
              {excessSummary?.active}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('analytics')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'analytics'
              ? 'border-green-600 text-green-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Sales Analytics
          {salesAnalytics.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-bold">
              {salesAnalytics.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('listings')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'listings'
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Listing Issues
          {listingIssuesSummary && listingIssuesSummary.total > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-bold">
              {listingIssuesSummary.total}
            </span>
          )}
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: REPLENISHMENT
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'replenishment' && (
        <>
          {/* CSV export buttons */}
          <div className="flex items-center gap-2 mb-4">
            <button onClick={() => downloadCSV('csv')} disabled={report.length === 0}
              className="px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors">
              Team CSV
            </button>
            <button onClick={() => downloadCSV('shipment')} disabled={report.length === 0}
              className="px-3 py-2 text-xs border border-orange-200 rounded-lg text-orange-700 hover:bg-orange-50 disabled:opacity-40 transition-colors">
              Amazon Shipment CSV
            </button>
          </div>

          {!lastSynced && !replenishLoading && (
            <div className="mb-5 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
              <strong>How this works:</strong> Click <strong>Sync FBA Data</strong> to pull FBA inventory levels and sales data
              for only the ASINs you actually sell. The Sales &amp; Traffic Report may take 2–4 minutes to generate.
            </div>
          )}

          {urgentReplenishCount > 0 && (
            <div className="mb-5 p-4 bg-red-50 border border-red-300 rounded-xl flex items-center gap-3">
              <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-red-800">{urgentReplenishCount} product{urgentReplenishCount !== 1 ? 's' : ''} need immediate attention</p>
                <p className="text-xs text-red-600 mt-0.5">
                  {[
                    replenishSummary?.stocked_out ? `${replenishSummary.stocked_out} no FBA stock` : '',
                    replenishSummary?.critical ? `${replenishSummary.critical} critical` : '',
                    replenishSummary?.replenish ? `${replenishSummary.replenish} need replenishment` : '',
                  ].filter(Boolean).join(', ')}
                </p>
              </div>
            </div>
          )}

          {replenishSummary && (
            <div className="grid grid-cols-4 gap-3 mb-5">
              {[
                { key: 'all', label: 'All Products', count: replenishSummary.total, color: 'text-gray-700', bg: 'bg-white' },
                { key: 'stocked_out', label: 'No FBA Stock', count: replenishSummary.stocked_out, color: 'text-red-700', bg: 'bg-red-50' },
                { key: 'critical', label: 'Send Urgently', count: replenishSummary.critical, color: 'text-red-600', bg: 'bg-red-50' },
                { key: 'replenish', label: 'Send Now', count: replenishSummary.replenish, color: 'text-orange-700', bg: 'bg-orange-50' },
                { key: 'new_candidate', label: 'Start on FBA', count: replenishSummary.new_candidates, color: 'text-blue-700', bg: 'bg-blue-50' },
                { key: 'watch', label: 'Monitor', count: replenishSummary.watch, color: 'text-yellow-700', bg: 'bg-yellow-50' },
                { key: 'healthy', label: 'FBA Covered', count: replenishSummary.healthy, color: 'text-green-700', bg: 'bg-green-50' },
                { key: 'overstocked', label: 'Pause Shipments', count: replenishSummary.overstocked, color: 'text-purple-700', bg: 'bg-purple-50' },
              ].map(card => (
                <button key={card.key} onClick={() => setFilter(card.key as ReplenishmentStatus | 'all')}
                  className={`${card.bg} border rounded-xl p-3 text-left transition-all ${filter === card.key ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className={`text-2xl font-bold ${card.color}`}>{card.count}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{card.label}</div>
                </button>
              ))}
            </div>
          )}

          <div className="mb-4 flex items-center gap-3">
            <input type="text" placeholder="Search by ASIN, SKU, or title…" value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {noDataCount > 0 && (
              <button
                onClick={() => setShowNoData(!showNoData)}
                className={`px-3 py-2 text-xs rounded-lg border transition-colors whitespace-nowrap ${
                  showNoData
                    ? 'bg-gray-100 border-gray-300 text-gray-700'
                    : 'border-gray-200 text-gray-400 hover:text-gray-600'
                }`}
              >
                {showNoData ? `Hide` : `Show`} {noDataCount} No Data
              </button>
            )}
          </div>

          {replenishLoading ? (
            <div className="flex items-center justify-center py-20 text-gray-400">
              <svg className="w-6 h-6 animate-spin mr-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Loading recommendations…
            </div>
          ) : filteredReport.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              {report.length === 0
                ? <div><p className="text-base font-medium text-gray-500 mb-2">No data yet</p><p className="text-sm">Click <strong>Sync FBA Data</strong> to generate your first recommendations.</p></div>
                : <p>No products match your current filter.</p>}
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
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">On Way</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">FBA Sold 30d</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Wks Cover</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Send Qty</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredReport.map((rec) => {
                      const cfg = STATUS_CONFIG[rec.status]
                      return (
                        <tr key={rec.asin} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900 text-xs leading-tight max-w-xs truncate">{rec.title}</div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-xs text-gray-400 font-mono">{rec.asin}</span>
                              {rec.sku && <span className="text-xs text-gray-400">· {rec.sku}</span>}
                              {rec.fba_sku && rec.fba_sku !== rec.sku && (
                                <span className="text-xs text-blue-500 font-mono">FBA: {rec.fba_sku}</span>
                              )}
                              {rec.has_customization && (
                                <span className="px-1.5 py-0.5 text-xs font-bold bg-red-100 text-red-700 rounded">CUSTOM</span>
                              )}
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
                            {rec.fba_qty_inbound > 0 ? <span className="text-blue-600">+{rec.fba_qty_inbound}</span> : <span className="text-gray-300">—</span>}
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
                            {rec.recommended_send_qty > 0
                              ? <span className="font-bold text-gray-900">{rec.recommended_send_qty}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3">
                            {rec.status === 'new_candidate' ? (
                              <a href={`https://sellercentral.amazon.com/inventory/ref=xx_invmgr_dnav_xx?tbla_myitable=sort:%7B%22sortOrder%22%3A%22DESCENDING%22%2C%22sortedColumnId%22%3A%22date%22%7D;search:${rec.asin};`}
                                target="_blank" rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:text-blue-800 underline whitespace-nowrap">
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
                Showing {filteredReport.length} of {report.length} products
                {!lastSynced && ' · FBA inventory data not yet synced — click "Sync FBA Data" to populate'}
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: CLEAR FBA STOCK (Excess Inventory)
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'excess' && (
        <>
          {/* Summary + export */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              {excessSummary && (
                <>
                  <div className="text-sm text-gray-600">
                    <span className="font-semibold text-orange-700">{excessSummary.total_excess_units}</span> excess units
                  </div>
                  <span className="text-gray-300">·</span>
                  <div className="text-sm text-gray-600">
                    <span className="font-semibold text-red-600">${excessSummary.total_monthly_storage_cost.toFixed(2)}</span>/mo storage
                  </div>
                  {excessSummary.needs_ai_plan > 0 && (
                    <>
                      <span className="text-gray-300">·</span>
                      <div className="text-sm text-amber-700">
                        <span className="font-semibold">{excessSummary.needs_ai_plan}</span> need AI plan
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <button onClick={() => downloadCSV('excess')} disabled={excessItems.length === 0}
              className="px-3 py-2 text-xs border border-orange-200 rounded-lg text-orange-700 hover:bg-orange-50 disabled:opacity-40 transition-colors">
              Export CSV
            </button>
          </div>

          {/* Status filter tabs */}
          <div className="flex items-center gap-2 mb-5">
            {[
              { key: 'all', label: 'All', count: excessSummary?.total },
              { key: 'active', label: 'Needs Action', count: excessSummary?.active },
              { key: 'actioned', label: 'Action Taken', count: excessSummary?.actioned },
              { key: 'escalated', label: 'Escalated', count: excessSummary?.escalated },
              { key: 'resolved', label: 'Resolved', count: excessSummary?.resolved },
            ].map(f => (
              <button key={f.key} onClick={() => setExcessFilter(f.key)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                  excessFilter === f.key
                    ? 'bg-orange-600 text-white border-orange-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                }`}>
                {f.label}{f.count !== undefined ? ` (${f.count})` : ''}
              </button>
            ))}
          </div>

          {excessLoading ? (
            <div className="flex items-center justify-center py-20 text-gray-400">
              <svg className="w-6 h-6 animate-spin mr-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Loading excess inventory…
            </div>
          ) : filteredExcess.length === 0 ? (
            <div className="text-center py-20">
              {excessItems.length === 0 ? (
                <div>
                  <div className="text-4xl mb-3">📦</div>
                  <p className="text-base font-medium text-gray-600 mb-2">No excess inventory detected</p>
                  <p className="text-sm text-gray-400">
                    {lastSynced
                      ? 'Amazon has not flagged any items as excess. Check back after your next sync.'
                      : 'Click Sync FBA Data to check for excess inventory from Amazon\'s Inventory Health report.'}
                  </p>
                </div>
              ) : (
                <p className="text-gray-400">No items match the selected filter.</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredExcess.map(item => {
                const urgency = getUrgency(item)
                const urgencyCfg = URGENCY_CONFIG[urgency]
                const statusCfg = EXCESS_STATUS_CONFIG[item.status] || EXCESS_STATUS_CONFIG.active
                const isExpanded = expandedItem === item.sku
                const isGenerating = generatingPlan === item.sku

                return (
                  <div key={item.sku} className={`bg-white border rounded-xl overflow-hidden transition-all ${
                    urgency === 'critical' ? 'border-red-200' : urgency === 'high' ? 'border-orange-200' : 'border-gray-200'
                  }`}>
                    {/* Item header */}
                    <div className="px-5 py-4">
                      <div className="flex items-start justify-between gap-4">
                        {/* Left: product info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${urgencyCfg.bg} ${urgencyCfg.color} border-current border-opacity-30`}>
                              {urgencyCfg.label} Priority
                            </span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.color}`}>
                              {statusCfg.label}
                            </span>
                            {item.recheck_due_at && !item.recheck_completed_at && (
                              <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                                Re-check: {new Date(item.recheck_due_at).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <h3 className="font-semibold text-gray-900 text-sm leading-snug">{item.product_name}</h3>
                          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                            <span className="font-mono">{item.asin}</span>
                            <span>·</span>
                            <span>{item.sku}</span>
                            {item.your_price > 0 && <><span>·</span><span>${item.your_price.toFixed(2)}</span></>}
                          </div>
                        </div>

                        {/* Right: key metrics */}
                        <div className="flex items-center gap-6 flex-shrink-0">
                          <div className="text-center">
                            <div className="text-xl font-bold text-orange-600">{item.excess_qty}</div>
                            <div className="text-xs text-gray-400">Excess Units</div>
                          </div>
                          <div className="text-center">
                            <div className={`text-xl font-bold ${item.days_of_supply > 180 ? 'text-red-600' : item.days_of_supply > 90 ? 'text-orange-600' : 'text-gray-700'}`}>
                              {item.days_of_supply}d
                            </div>
                            <div className="text-xs text-gray-400">Days Supply</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xl font-bold text-gray-700">{item.qty_available}</div>
                            <div className="text-xs text-gray-400">On Hand</div>
                          </div>
                          {item.estimated_monthly_storage_fee > 0 && (
                            <div className="text-center">
                              <div className="text-xl font-bold text-red-600">${item.estimated_monthly_storage_fee.toFixed(0)}</div>
                              <div className="text-xs text-gray-400">/mo Storage</div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Velocity row */}
                      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                        <span>{item.units_sold_last_30_days} units sold (30d)</span>
                        {item.estimated_storage_cost_per_unit > 0 && (
                          <span>${item.estimated_storage_cost_per_unit.toFixed(2)}/unit storage</span>
                        )}
                        {item.amazon_alert && (
                          <span className="text-amber-600">Amazon: {item.amazon_alert}</span>
                        )}
                      </div>

                      {/* Action row */}
                      <div className="flex items-center gap-3 mt-4">
                        {/* AI Plan button */}
                        {!item.ai_action_plan ? (
                          <button
                            onClick={() => generatePlan(item.sku)}
                            disabled={isGenerating}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
                          >
                            {isGenerating ? (
                              <>
                                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                </svg>
                                Generating AI Plan…
                              </>
                            ) : (
                              <>
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3.5 3.5 0 01-4.95 0l-.347-.347z" />
                                </svg>
                                Generate AI Action Plan
                              </>
                            )}
                          </button>
                        ) : (
                          <button
                            onClick={() => setExpandedItem(isExpanded ? null : item.sku)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 text-violet-700 border border-violet-200 text-xs rounded-lg hover:bg-violet-100 transition-colors"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3.5 3.5 0 01-4.95 0l-.347-.347z" />
                            </svg>
                            {isExpanded ? 'Hide AI Plan' : 'View AI Plan'}
                          </button>
                        )}

                        {/* Action dropdown */}
                        {item.status !== 'resolved' && item.status !== 'dismissed' && (
                          <select
                            value={item.action_taken || ''}
                            onChange={e => { if (e.target.value) updateAction(item.sku, e.target.value) }}
                            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">Mark Action Taken…</option>
                            <option value="ran_sale">Ran a Sale</option>
                            <option value="created_outlet_deal">Created Outlet Deal</option>
                            <option value="removed">Initiated Removal</option>
                            <option value="held">Held — No Action</option>
                          </select>
                        )}

                        {/* Re-analyze button (if action was taken) */}
                        {item.action_taken && item.status === 'actioned' && (
                          <button
                            onClick={() => generatePlan(item.sku, true)}
                            disabled={isGenerating}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 text-xs rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                          >
                            {isGenerating ? (
                              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                              </svg>
                            ) : (
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            )}
                            Re-analyze Now
                          </button>
                        )}

                        {/* Seller Central link */}
                        <a
                          href={`https://sellercentral.amazon.com/inventoryplanning/manageinventoryhealth?asin=${item.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto text-xs text-gray-400 hover:text-gray-600 underline whitespace-nowrap"
                        >
                          Act in Seller Central →
                        </a>
                      </div>

                      {/* Action taken badge */}
                      {item.action_taken && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                          <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-medium">
                            {ACTION_LABELS[item.action_taken] || item.action_taken}
                          </span>
                          {item.action_taken_at && (
                            <span>on {new Date(item.action_taken_at).toLocaleDateString()}</span>
                          )}
                          {item.recheck_due_at && !item.recheck_completed_at && (
                            <span className="text-blue-600">· Auto re-analysis on {new Date(item.recheck_due_at).toLocaleDateString()}</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Expanded AI Plan */}
                    {isExpanded && item.ai_action_plan && (
                      <div className="px-5 py-4 bg-violet-50 border-t border-violet-100">
                        <div className="flex items-center gap-2 mb-2">
                          <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3.5 3.5 0 01-4.95 0l-.347-.347z" />
                          </svg>
                          <span className="text-xs font-semibold text-violet-700">AI Action Plan</span>
                          {item.ai_plan_generated_at && (
                            <span className="text-xs text-violet-400">
                              Generated {new Date(item.ai_plan_generated_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{item.ai_action_plan}</p>

                        {/* Re-analysis outcome */}
                        {item.recheck_outcome && item.recheck_completed_at && (
                          <div className="mt-4 pt-4 border-t border-violet-200">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs font-semibold text-blue-700">Re-analysis Outcome</span>
                              <span className="text-xs text-blue-400">{new Date(item.recheck_completed_at).toLocaleDateString()}</span>
                            </div>
                            <p className="text-sm text-gray-700 leading-relaxed">{item.recheck_outcome}</p>
                            {item.outcome_excess_qty !== null && (
                              <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                                <span>Before: <strong>{item.excess_qty}</strong> excess units</span>
                                <span>→</span>
                                <span>After: <strong className={item.outcome_excess_qty === 0 ? 'text-green-600' : item.outcome_excess_qty < item.excess_qty ? 'text-blue-600' : 'text-red-600'}>
                                  {item.outcome_excess_qty}
                                </strong> excess units</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {filteredExcess.length > 0 && (
            <div className="mt-4 text-xs text-gray-400 text-center">
              Showing {filteredExcess.length} of {excessItems.length} items · Data from Amazon&apos;s Inventory Health report
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: SALES ANALYTICS
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'analytics' && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Sales Analytics</h2>
              <p className="text-sm text-gray-500 mt-0.5">Per-SKU sales velocity from the Amazon All Orders report · Last 7 / 30 / 90 days</p>
            </div>
            <button
              onClick={() => fetchSalesAnalytics(true)}
              disabled={analyticsLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {analyticsLoading ? 'Syncing from Amazon…' : 'Sync & Refresh'}
            </button>
          </div>
          {analyticsLoading ? (
            <div className="text-center py-12 text-gray-400">Loading sales data…</div>
          ) : salesAnalytics.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <p className="font-medium">No sales analytics data yet.</p>
              <p className="text-sm mt-1">Trigger a sync from the Replenishment tab to populate this table.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">SKU</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Channel</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">7d Units</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">30d Units</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">90d Units</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">30d Revenue</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Avg/Day</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Order</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {salesAnalytics.map(row => (
                    <tr key={row.sku} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">{row.sku}</td>
                      <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate" title={row.product_name || ''}>{row.product_name || '—'}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                          row.fulfillment_channel === 'Amazon' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {row.fulfillment_channel === 'Amazon' ? 'FBA' : row.fulfillment_channel || 'MFN'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{row.units_sold_7d}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{row.units_sold_30d}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{row.units_sold_90d}</td>
                      <td className="px-4 py-3 text-right text-green-700 font-medium">${row.revenue_30d.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{row.avg_daily_units.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-gray-400 text-xs">
                        {row.last_order_date ? new Date(row.last_order_date).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 text-xs text-gray-400 text-center">
            Data sourced from Amazon All Orders flat-file report · Updated on every sync
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: LISTING ISSUES
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'listings' && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Listing Issues</h2>
              <p className="text-sm text-gray-500 mt-0.5">Only showing listings that need your attention — suppressed, broken, stocked out, or missing FBA</p>
            </div>
            <button
              onClick={() => fetchListingIssues(true)}
              disabled={listingsLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {listingsLoading ? 'Scanning…' : 'Refresh Issues'}
            </button>
          </div>

          {/* Summary Cards */}
          {listingIssuesSummary && listingIssuesSummary.total > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-red-700">{listingIssuesSummary.critical}</div>
                <div className="text-xs text-red-600 font-medium">Critical</div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-amber-700">{listingIssuesSummary.warning}</div>
                <div className="text-xs text-amber-600 font-medium">Warnings</div>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-blue-700">{listingIssuesSummary.opportunity}</div>
                <div className="text-xs text-blue-600 font-medium">Opportunities</div>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-gray-900">${listingIssuesSummary.total_lost_revenue.toLocaleString()}</div>
                <div className="text-xs text-gray-500 font-medium">Est. Lost Revenue/mo</div>
              </div>
            </div>
          )}

          {listingsLoading ? (
            <div className="text-center py-12 text-gray-400">Scanning listings for issues…</div>
          ) : listingIssues.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">&#10003;</div>
              <p className="font-medium text-green-700">All Clear — No Listing Issues Found</p>
              <p className="text-sm mt-1 text-gray-500">All your listings are active, priced correctly, and stocked. Nice work.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {listingIssues.map((issue, idx) => (
                <div key={`${issue.sku}-${idx}`} className={`rounded-xl border p-4 ${
                  issue.severity === 'critical' ? 'border-red-200 bg-red-50/50'
                  : issue.severity === 'warning' ? 'border-amber-200 bg-amber-50/50'
                  : 'border-blue-200 bg-blue-50/50'
                }`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                          issue.severity === 'critical' ? 'bg-red-100 text-red-700'
                          : issue.severity === 'warning' ? 'bg-amber-100 text-amber-700'
                          : 'bg-blue-100 text-blue-700'
                        }`}>
                          {issue.issue_label}
                        </span>
                        <span className="text-xs text-gray-400 font-mono">{issue.sku}</span>
                        {issue.asin && (
                          <a href={`https://amazon.com/dp/${issue.asin}`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                            {issue.asin}
                          </a>
                        )}
                      </div>
                      <p className="text-sm font-medium text-gray-900 truncate" title={issue.product_name || ''}>
                        {issue.product_name || 'Unknown Product'}
                      </p>
                      <p className="text-xs text-gray-600 mt-1">{issue.detail}</p>
                    </div>
                    <div className="text-right shrink-0">
                      {issue.units_sold_30d > 0 && (
                        <div className="text-sm font-bold text-gray-900">{issue.units_sold_30d} units/30d</div>
                      )}
                      {issue.estimated_lost_revenue_30d != null && issue.estimated_lost_revenue_30d > 0 && (
                        <div className="text-xs text-red-600 font-medium">~${issue.estimated_lost_revenue_30d.toLocaleString()} lost/mo</div>
                      )}
                      {issue.price != null && issue.price > 0 && (
                        <div className="text-xs text-gray-400">${issue.price.toFixed(2)}</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-xs text-gray-400 text-center">
            Cross-references All Listings report with Sales Analytics · Only shows actionable issues
          </div>
        </>
      )}
    </div>
  )
}
