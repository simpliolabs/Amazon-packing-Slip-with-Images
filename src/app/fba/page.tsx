'use client'

import React, { useState, useEffect, useCallback } from 'react'
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
  issue_type: 'suppressed' | 'zero_price' | 'fbm_no_fba'
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

// ─── Missing Inventory Types ────────────────────────────────────────────────

interface MissingInventoryGap {
  sku: string
  asin: string
  product_name: string
  quantity: number
  status: string
  family: string
  size_token: string
  color_token: string
  total_colors_for_size: number
  stocked_colors: number
  max_qty_in_sibling: number
  family_total_colors: number
  severity: 'critical' | 'warning'
  last_synced_at: string | null
}

interface MissingInventorySummary {
  family: string
  total_gaps: number
  critical_gaps: number
  warning_gaps: number
  sizes_affected: number
  colors_affected: number
  missing_sizes: string[]
  last_synced_at: string | null
}

interface MissingInventoryTotals {
  total_gaps: number
  critical_gaps: number
  warning_gaps: number
  families_affected: number
}

// ─── Work Log Types ──────────────────────────────────────────────────────────

interface WorkLogEntry {
  id: string
  asin: string
  sku: string
  qty_planned: number
  note: string | null
  logged_by: string | null
  logged_by_name: string | null
  logged_at: string
  edited_at: string | null
  edited_by: string | null
  edited_by_name: string | null
  edit_history: Array<{
    prev_qty_planned: number
    prev_note: string | null
    edited_by: string
    edited_at: string
  }>
}

interface WorkLogState {
  entries: WorkLogEntry[]
  total_planned: number
  loading: boolean
  error: string | null
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

const STATUS_CONFIG: Partial<Record<ReplenishmentStatus, { label: string; color: string; bg: string; border: string }>> & Record<string, { label: string; color: string; bg: string; border: string }> = {
  stocked_out:   { label: 'FBA Stocked Out',       color: 'text-red-700',    bg: 'bg-red-100',    border: 'border-red-300' },
  critical:      { label: 'Send Urgently',         color: 'text-red-600',    bg: 'bg-red-50',     border: 'border-red-200' },
  replenish:     { label: 'Send Now',              color: 'text-orange-700', bg: 'bg-orange-100', border: 'border-orange-300' },
  new_candidate: { label: 'Start Selling on FBA',  color: 'text-blue-700',   bg: 'bg-blue-100',   border: 'border-blue-300' },

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
  const [activeTab, setActiveTab] = useState<'replenishment' | 'excess' | 'analytics' | 'listings' | 'missing' | 'ads'>('replenishment')
  const [salesAnalytics, setSalesAnalytics] = useState<SkuSalesRow[]>([])
  const [salesSearch, setSalesSearch] = useState('')
  const [salesSortCol, setSalesSortCol] = useState<keyof SkuSalesRow>('units_sold_30d')
  const [salesSortDir, setSalesSortDir] = useState<'asc' | 'desc'>('desc')
  const [listingIssues, setListingIssues] = useState<ListingIssue[]>([])
  const [listingIssuesSummary, setListingIssuesSummary] = useState<ListingIssuesSummary | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsSyncPending, setAnalyticsSyncPending] = useState(false)
  const [listingsLoading, setListingsLoading] = useState(false)
  const [listingsSyncPending, setListingsSyncPending] = useState(false)

  // Missing Inventory state
  const [missingGaps, setMissingGaps] = useState<MissingInventoryGap[]>([])
  const [missingSummary, setMissingSummary] = useState<MissingInventorySummary[]>([])
  const [missingTotals, setMissingTotals] = useState<MissingInventoryTotals | null>(null)
  const [missingLoading, setMissingLoading] = useState(false)
  const [missingFamily, setMissingFamily] = useState<string>('')
  const [missingSeverity, setMissingSeverity] = useState<string>('all')
  const [missingSearchQuery, setMissingSearchQuery] = useState<string>('')

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

  // Work Log state — keyed by ASIN
  const [workLogs, setWorkLogs] = useState<Record<string, WorkLogState>>({})
  const [expandedWorkLog, setExpandedWorkLog] = useState<string | null>(null)
  // Work Log form state
  const [workLogForm, setWorkLogForm] = useState<Record<string, { qty: string; note: string; submitting: boolean }>>({})
  // Work Log edit state — keyed by entry id
  const [editingEntry, setEditingEntry] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ qty: string; note: string }>({ qty: '', note: '' })

  // Ads Manager state
  const [adsStatus, setAdsStatus] = useState<{
    configured: boolean; valid: boolean; message: string;
    stats: { campaigns: number; keywords: number; lastSynced: string | null }
  } | null>(null)
  const [adsCampaigns, setAdsCampaigns] = useState<{
    campaign_id: string; name: string; state: string; campaign_type: string;
    daily_budget: number | null;
    perf_30d: { impressions: number; clicks: number; cost: number; sales: number; acos: number | null; roas: number | null }
  }[]>([])
  const [adsSummary, setAdsSummary] = useState<{
    totalSpend: number; totalSales: number; avgAcos: number | null; activeCampaigns: number; totalCampaigns: number
  } | null>(null)
  const [adsLoading, setAdsLoading] = useState(false)
  const [adsSyncing, setAdsSyncing] = useState(false)

  // Notifications
  const [notifications, setNotifications] = useState<FBANotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [showNotifications, setShowNotifications] = useState(false)

  // Shared state
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSynced, setLastSynced] = useState<string | null>(null)

  // Initial loading overlay state
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  const [loadedSources, setLoadedSources] = useState<Set<string>>(new Set())

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
      setLoadedSources(prev => new Set(prev).add('replenishment'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setLoadedSources(prev => new Set(prev).add('replenishment'))
    } finally {
      setReplenishLoading(false)
    }
  }, [])

  // ── Fetch excess inventory ──────────────────────────────────────────────────
  const fetchExcess = useCallback(async (refresh = false) => {
    setExcessLoading(true)
    try {
      const token = await getToken()
      const url = refresh ? '/api/fba/excess?refresh=true' : '/api/fba/excess'
      const resp = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to load excess data')
      const data = await resp.json()
      setExcessItems(data.items || [])
      setExcessSummary(data.summary || null)
      setLoadedSources(prev => new Set(prev).add('excess'))
    } catch (err) {
      console.error('Excess fetch error:', err)
      setLoadedSources(prev => new Set(prev).add('excess'))
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
      setLoadedSources(prev => new Set(prev).add('notifications'))
    } catch {
      setLoadedSources(prev => new Set(prev).add('notifications'))
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

  // ── Mark label created / shipped ─────────────────────────────────────────────
  const markLabelCreated = async (asin: string, sku: string) => {
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/label-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ asin, sku, status: 'label_created' }),
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to mark label')
      await fetchReport()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark label created')
    }
  }

  const markShipped = async (asin: string, sku: string) => {
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/label-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ asin, sku, status: 'shipped' }),
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to mark shipped')
      await fetchReport()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark shipped')
    }
  }

  // ── Work Log functions ────────────────────────────────────────────────────
  const fetchWorkLog = async (asin: string) => {
    setWorkLogs(prev => ({
      ...prev,
      [asin]: { ...(prev[asin] || { entries: [], total_planned: 0 }), loading: true, error: null },
    }))
    try {
      const token = await getToken()
      const resp = await fetch(`/api/fba/work-log?asin=${encodeURIComponent(asin)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to load work log')
      const data = await resp.json()
      setWorkLogs(prev => ({
        ...prev,
        [asin]: { entries: data.entries || [], total_planned: data.total_planned || 0, loading: false, error: null },
      }))
    } catch (err) {
      setWorkLogs(prev => ({
        ...prev,
        [asin]: { ...(prev[asin] || { entries: [], total_planned: 0 }), loading: false, error: err instanceof Error ? err.message : 'Error' },
      }))
    }
  }

  const toggleWorkLog = (asin: string) => {
    if (expandedWorkLog === asin) {
      setExpandedWorkLog(null)
    } else {
      setExpandedWorkLog(asin)
      if (!workLogs[asin] || workLogs[asin].entries.length === 0) {
        fetchWorkLog(asin)
      }
    }
  }

  const submitWorkLog = async (asin: string, sku: string) => {
    const form = workLogForm[asin]
    if (!form || !form.qty || parseInt(form.qty) < 1) return
    setWorkLogForm(prev => ({ ...prev, [asin]: { ...prev[asin], submitting: true } }))
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/work-log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ asin, sku, qty_planned: parseInt(form.qty), note: form.note || undefined }),
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to log')
      setWorkLogForm(prev => ({ ...prev, [asin]: { qty: '', note: '', submitting: false } }))
      await fetchWorkLog(asin)
    } catch (err) {
      setWorkLogForm(prev => ({ ...prev, [asin]: { ...prev[asin], submitting: false } }))
      setError(err instanceof Error ? err.message : 'Failed to save work log')
    }
  }

  const saveEditEntry = async (entryId: string, asin: string) => {
    const qty = parseInt(editForm.qty)
    if (!qty || qty < 1) return
    try {
      const token = await getToken()
      const resp = await fetch('/api/fba/work-log', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ id: entryId, qty_planned: qty, note: editForm.note }),
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to update')
      setEditingEntry(null)
      await fetchWorkLog(asin)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update work log entry')
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

  // Mark initial load complete once all 3 primary sources are loaded
  useEffect(() => {
    if (loadedSources.has('replenishment') && loadedSources.has('excess') && loadedSources.has('notifications')) {
      // Small delay for smooth transition
      const timer = setTimeout(() => setInitialLoadComplete(true), 300)
      return () => clearTimeout(timer)
    }
  }, [loadedSources])

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
  }).sort((a, b) => {
    // Primary: send qty descending (most units needed at top)
    if ((b.recommended_send_qty || 0) !== (a.recommended_send_qty || 0)) {
      return (b.recommended_send_qty || 0) - (a.recommended_send_qty || 0)
    }
    // Secondary: intelligence score descending
    return (b.intelligence_score || 0) - (a.intelligence_score || 0)
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
    setAnalyticsSyncPending(false)
    try {
      if (triggerSync) {
        // Force a fresh Amazon report (bypasses the 6-hour cache)
        const syncResp = await fetch('/api/fba/sync-reports?force=sales').catch(() => null)
        const syncJson = syncResp ? await syncResp.json().catch(() => ({})) : {}
        const isPending = syncJson?.sales?.pending === true

        if (isPending) {
          // Report is generating — show banner and poll every 30s for up to 5 min
          setAnalyticsSyncPending(true)
          setAnalyticsLoading(false)
          const MAX_POLLS = 10
          for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise(r => setTimeout(r, 30_000))
            const pollResp = await fetch('/api/fba/sync-reports').catch(() => null)
            const pollJson = pollResp ? await pollResp.json().catch(() => ({})) : {}
            if (!pollJson?.sales?.pending) {
              // Report is ready — fetch fresh data
              setAnalyticsSyncPending(false)
              setAnalyticsLoading(true)
              break
            }
          }
          setAnalyticsSyncPending(false)
        } else {
          // Report was ready immediately — small delay for DB write to settle
          await new Promise(r => setTimeout(r, 1500))
        }
      }
      const resp = await fetch('/api/fba/reports-data?type=sales')
      const json = await resp.json()
      setSalesAnalytics(json.data || [])
    } catch (e) { console.error(e) }
    finally {
      setAnalyticsLoading(false)
      setAnalyticsSyncPending(false)
    }
  }, [])

  // Fetch Ads Manager data
  const fetchAdsData = useCallback(async () => {
    setAdsLoading(true)
    try {
      const [statusResp, campaignsResp] = await Promise.all([
        fetch('/api/ads/status'),
        fetch('/api/ads/campaigns'),
      ])
      if (statusResp.ok) {
        const status = await statusResp.json()
        setAdsStatus(status)
      }
      if (campaignsResp.ok) {
        const data = await campaignsResp.json()
        setAdsCampaigns(data.campaigns || [])
        setAdsSummary(data.summary || null)
      }
    } catch (err) {
      console.error('[AdsManager] Failed to load ads data:', err)
    } finally {
      setAdsLoading(false)
    }
  }, [])

  // Fetch missing inventory gaps
  const fetchMissingInventory = useCallback(async (family = '', severity = 'all') => {
    setMissingLoading(true)
    try {
      const token = await getToken()
      const params = new URLSearchParams({ limit: '500' })
      if (family) params.set('family', family)
      if (severity !== 'all') params.set('severity', severity)
      const resp = await fetch(`/api/fba/missing-inventory?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!resp.ok) throw new Error((await resp.json()).error || 'Failed to load missing inventory')
      const data = await resp.json()
      setMissingGaps(data.gaps || [])
      setMissingSummary(data.summary || [])
      setMissingTotals(data.totals || null)
    } catch (e) { console.error('[missing-inventory]', e) }
    finally { setMissingLoading(false) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch listing health
  const fetchListingIssues = useCallback(async (triggerSync = false) => {
    setListingsLoading(true)
    try {
      if (triggerSync) {
        // Use force=listings to bypass the 2-hour cache and always request a fresh Amazon report.
        // syncListings is non-blocking: it requests the report and returns immediately.
        // The report is only available on the NEXT call (usually 1-3 minutes later).
        const syncResp = await fetch('/api/fba/sync-reports?force=listings').catch(() => null)
        const syncJson = syncResp ? await syncResp.json().catch(() => null) : null
        // If listings sync said it requested a new report (not picked up yet), show pending banner
        // and start auto-polling every 30 seconds until the report is ready.
        const listingsResult = syncJson?.listings
        const isPending = listingsResult?.pending === true
        if (isPending) {
          setListingsSyncPending(true)
          setListingsLoading(false)
          // Auto-poll: try picking up the report every 30s for up to 5 minutes
          let attempts = 0
          const maxAttempts = 10
          const pollInterval = setInterval(async () => {
            attempts++
            try {
              // Non-force call — picks up the DONE report if it's ready now
              const pollResp = await fetch('/api/fba/sync-reports').catch(() => null)
              const pollJson = pollResp ? await pollResp.json().catch(() => null) : null
              const pollListings = pollJson?.listings
              const stillPending = pollListings?.pending === true
              if (!stillPending && (pollListings?.synced ?? 0) > 0) {
                // Report is ready — refresh issues and clear the banner
                clearInterval(pollInterval)
                setListingsSyncPending(false)
                setListingsLoading(true)
                const resp = await fetch('/api/fba/listing-issues')
                const json = await resp.json()
                setListingIssues(json.issues || [])
                setListingIssuesSummary(json.summary || null)
                setListingsLoading(false)
              } else if (attempts >= maxAttempts) {
                // Gave up after 5 minutes — leave banner visible so user can retry manually
                clearInterval(pollInterval)
              }
            } catch { /* ignore poll errors */ }
          }, 30_000)
          return // Don't fall through to the normal issues fetch below
        } else {
          setListingsSyncPending(false)
        }
        await new Promise(r => setTimeout(r, 1000))
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
    if (activeTab === 'missing' && missingGaps.length === 0) fetchMissingInventory()
    if (activeTab === 'ads' && !adsStatus) fetchAdsData()
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

  // Data source labels for the loading overlay
  const DATA_SOURCES = [
    { key: 'replenishment', label: 'Replenishment recommendations' },
    { key: 'excess', label: 'Excess inventory' },
    { key: 'notifications', label: 'Notifications' },
  ] as const

  return (
    <div className="p-6 max-w-7xl mx-auto relative">
      {/* ── Gathering Data Overlay ──────────────────────────────────────────── */}
      {!initialLoadComplete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm transition-opacity duration-500">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 px-10 py-8 max-w-md w-full mx-4 text-center">
            {/* Spinner */}
            <div className="mx-auto mb-5 w-12 h-12 relative">
              <div className="absolute inset-0 rounded-full border-4 border-gray-200" />
              <div className="absolute inset-0 rounded-full border-4 border-t-[#2E9CE6] animate-spin" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Gathering Data</h2>
            <p className="text-sm text-gray-500 mb-5">Loading your FBA intelligence dashboard&hellip;</p>

            {/* Progress checklist */}
            <div className="space-y-2.5 text-left">
              {DATA_SOURCES.map(src => {
                const done = loadedSources.has(src.key)
                return (
                  <div key={src.key} className="flex items-center gap-3">
                    {done ? (
                      <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                        <div className="w-4 h-4 rounded-full border-2 border-gray-300 border-t-[#2E9CE6] animate-spin" />
                      </div>
                    )}
                    <span className={`text-sm ${done ? 'text-gray-600' : 'text-gray-400'}`}>{src.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

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
        <button
          onClick={() => setActiveTab('missing')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'missing'
              ? 'border-rose-600 text-rose-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Missing Inventory
          {missingTotals && missingTotals.critical_gaps > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-rose-100 text-rose-700 text-xs rounded-full font-bold">
              {missingTotals.critical_gaps}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('ads')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'ads'
              ? 'border-yellow-600 text-yellow-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Ads Manager
          {adsSummary && adsSummary.activeCampaigns > 0 && (
            <span className="ml-2 px-1.5 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full font-bold">
              {adsSummary.activeCampaigns}
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
                    replenishSummary?.stocked_out ? `${replenishSummary.stocked_out} FBA stocked out` : '',
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
                { key: 'stocked_out', label: 'FBA Stocked Out', count: replenishSummary.stocked_out, color: 'text-red-700', bg: 'bg-red-50' },
                { key: 'critical', label: 'Send Urgently', count: replenishSummary.critical, color: 'text-red-600', bg: 'bg-red-50' },
                { key: 'replenish', label: 'Send Now', count: replenishSummary.replenish, color: 'text-orange-700', bg: 'bg-orange-50' },
                { key: 'new_candidate', label: 'Start on FBA', count: replenishSummary.new_candidates, color: 'text-blue-700', bg: 'bg-blue-50' },

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
                      const cfg = STATUS_CONFIG[rec.status] || { label: rec.status_label || rec.status, color: 'text-gray-500', bg: 'bg-gray-100', border: 'border-gray-200' }
                      return (
                        <React.Fragment key={rec.asin}>
                        <tr className="hover:bg-gray-50 transition-colors" title={rec.send_rationale}>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900 text-xs leading-tight max-w-xs truncate">{rec.title}</div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-xs text-gray-400 font-mono">{rec.asin}</span>
                              {rec.sku && <span className="text-xs text-gray-400">· {rec.sku}</span>}
                              {rec.fba_sku && rec.fba_sku !== rec.sku && (
                                <span className="text-xs text-blue-500 font-mono">FBA: {rec.fba_sku}</span>
                              )}
                              {rec.parent_asin && (
                                <a href={`https://www.amazon.com/dp/${rec.parent_asin}`} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-purple-500 hover:text-purple-700 font-mono" title={`Parent: ${rec.parent_asin} (${rec.sibling_count} variants)`}>
                                  Parent: {rec.parent_asin}
                                </a>
                              )}
                              {rec.has_customization && (
                                <span className="px-1.5 py-0.5 text-xs font-bold bg-red-100 text-red-700 rounded">CUSTOM</span>
                              )}
                            </div>
                            {rec.send_rationale && (
                              <div className="text-xs text-gray-400 mt-0.5 max-w-sm truncate" title={rec.send_rationale}>
                                {rec.send_rationale}
                              </div>
                            )}
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
                            ) : rec.shipment_status === 'label_created' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800" title={rec.label_created_at ? `Label created ${new Date(rec.label_created_at).toLocaleDateString()}` : 'Label created'}>
                                📦 Label
                              </span>
                            ) : rec.shipment_status === 'shipped' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                🚚 Shipped
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
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
                            <div className="flex flex-col gap-1">
                              {rec.status === 'new_candidate' ? (
                                <a href={`https://sellercentral.amazon.com/inventory/ref=xx_invmgr_dnav_xx?tbla_myitable=sort:%7B%22sortOrder%22%3A%22DESCENDING%22%2C%22sortedColumnId%22%3A%22date%22%7D;search:${rec.asin};`}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-blue-600 hover:text-blue-800 underline whitespace-nowrap">
                                  Create in SC →
                                </a>
                              ) : rec.recommended_send_qty > 0 ? (
                                <span className="text-xs text-gray-400 italic">Send {rec.recommended_send_qty} units</span>
                              ) : null}
                              {/* Label Created toggle */}
                              {rec.fba_qty_inbound === 0 && !rec.shipment_status && rec.status !== 'new_candidate' && (
                                <button
                                  onClick={() => markLabelCreated(rec.asin, rec.fba_sku || rec.sku)}
                                  className="text-xs px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 whitespace-nowrap"
                                >
                                  🏷️ Mark Label
                                </button>
                              )}
                              {rec.shipment_status === 'label_created' && (
                                <button
                                  onClick={() => markShipped(rec.asin, rec.fba_sku || rec.sku)}
                                  className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 whitespace-nowrap"
                                >
                                  🚚 Mark Shipped
                                </button>
                              )}
                              {/* Work Log toggle */}
                              <button
                                onClick={() => toggleWorkLog(rec.asin)}
                                className={`text-xs px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
                                  expandedWorkLog === rec.asin
                                    ? 'bg-blue-100 text-blue-700 border-blue-300'
                                    : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200'
                                }`}
                              >
                                {expandedWorkLog === rec.asin ? '▲ Log' : '▼ Log'}
                                {workLogs[rec.asin]?.total_planned > 0 && (
                                  <span className="ml-1 font-bold text-blue-700">{workLogs[rec.asin].total_planned}</span>
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {/* ── Work Log expandable row ── */}
                        {expandedWorkLog === rec.asin && (
                          <tr key={`wl-${rec.asin}`}>
                            <td colSpan={9} className="px-0 py-0 bg-blue-50/40 border-b border-blue-100">
                              <div className="px-6 py-4">
                                <div className="flex items-center justify-between mb-3">
                                  <span className="text-xs font-semibold text-blue-800 uppercase tracking-wide">Print Run Log — {rec.asin}</span>
                                  <button
                                    onClick={() => setExpandedWorkLog(null)}
                                    className="text-gray-400 hover:text-gray-600"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                </div>

                                {/* Summary bar */}
                                {(() => {
                                  const wl = workLogs[rec.asin]
                                  const totalPlanned = wl?.total_planned || 0
                                  const onWay = rec.fba_qty_inbound || 0
                                  const sendQty = rec.recommended_send_qty || 0
                                  const remaining = Math.max(0, sendQty - totalPlanned)
                                  return (
                                    <div className="flex items-center gap-6 mb-4 p-3 bg-white rounded-lg border border-blue-100 text-xs">
                                      <div>
                                        <span className="text-gray-500">Planned to print:</span>{' '}
                                        <span className="font-bold text-blue-700">{totalPlanned}</span>
                                      </div>
                                      <div>
                                        <span className="text-gray-500">On Way (Amazon):</span>{' '}
                                        <span className="font-bold text-green-700">{onWay > 0 ? `+${onWay}` : '—'}</span>
                                      </div>
                                      <div>
                                        <span className="text-gray-500">Send Qty:</span>{' '}
                                        <span className="font-bold text-gray-700">{sendQty}</span>
                                      </div>
                                      <div>
                                        <span className="text-gray-500">Remaining:</span>{' '}
                                        <span className={`font-bold ${remaining > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                                          {remaining > 0 ? remaining : '✓ Complete'}
                                        </span>
                                      </div>
                                    </div>
                                  )
                                })()}

                                {/* Log entries table */}
                                {workLogs[rec.asin]?.loading ? (
                                  <div className="text-xs text-gray-400 py-2">Loading log…</div>
                                ) : workLogs[rec.asin]?.error ? (
                                  <div className="text-xs text-red-500 py-2">{workLogs[rec.asin].error}</div>
                                ) : (workLogs[rec.asin]?.entries || []).length === 0 ? (
                                  <div className="text-xs text-gray-400 italic py-2">No print runs logged yet for this ASIN.</div>
                                ) : (
                                  <div className="mb-3 rounded-lg border border-gray-200 overflow-hidden bg-white">
                                    <table className="w-full text-xs">
                                      <thead className="bg-gray-50 border-b border-gray-200">
                                        <tr>
                                          <th className="text-left px-3 py-2 text-gray-500 font-semibold">Date</th>
                                          <th className="text-left px-3 py-2 text-gray-500 font-semibold">SKU</th>
                                          <th className="text-right px-3 py-2 text-gray-500 font-semibold">Qty Planned</th>
                                          <th className="text-left px-3 py-2 text-gray-500 font-semibold">Note</th>
                                          <th className="text-left px-3 py-2 text-gray-500 font-semibold">Logged By</th>
                                          <th className="text-left px-3 py-2 text-gray-500 font-semibold">History</th>
                                          <th className="px-3 py-2"></th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-gray-100">
                                        {(workLogs[rec.asin]?.entries || []).map(entry => (
                                          <tr key={entry.id} className="hover:bg-gray-50">
                                            <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                                              {new Date(entry.logged_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                            </td>
                                            <td className="px-3 py-2 text-gray-500 font-mono">{entry.sku}</td>
                                            <td className="px-3 py-2 text-right">
                                              {editingEntry === entry.id ? (
                                                <input
                                                  type="number"
                                                  min="1"
                                                  value={editForm.qty}
                                                  onChange={e => setEditForm(f => ({ ...f, qty: e.target.value }))}
                                                  className="w-16 px-1 py-0.5 border border-blue-300 rounded text-right text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                />
                                              ) : (
                                                <span className="font-bold text-gray-900">{entry.qty_planned}</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-2 text-gray-500 max-w-xs">
                                              {editingEntry === entry.id ? (
                                                <input
                                                  type="text"
                                                  value={editForm.note}
                                                  onChange={e => setEditForm(f => ({ ...f, note: e.target.value }))}
                                                  placeholder="Note…"
                                                  className="w-full px-1 py-0.5 border border-blue-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                />
                                              ) : (
                                                entry.note || <span className="text-gray-300">—</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-2 text-gray-500">{entry.logged_by_name || '—'}</td>
                                            <td className="px-3 py-2">
                                              {entry.edit_history && entry.edit_history.length > 0 ? (
                                                <span
                                                  className="text-blue-500 cursor-pointer hover:underline"
                                                  title={entry.edit_history.map(h =>
                                                    `${new Date(h.edited_at).toLocaleString()}: was ${h.prev_qty_planned} units${h.prev_note ? ` / "${h.prev_note}"` : ''}`
                                                  ).join('\n')}
                                                >
                                                  {entry.edit_history.length} edit{entry.edit_history.length !== 1 ? 's' : ''}
                                                </span>
                                              ) : (
                                                <span className="text-gray-300">—</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-2">
                                              {editingEntry === entry.id ? (
                                                <div className="flex items-center gap-1">
                                                  <button
                                                    onClick={() => saveEditEntry(entry.id, rec.asin)}
                                                    className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
                                                  >
                                                    Save
                                                  </button>
                                                  <button
                                                    onClick={() => setEditingEntry(null)}
                                                    className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200"
                                                  >
                                                    Cancel
                                                  </button>
                                                </div>
                                              ) : (
                                                <button
                                                  onClick={() => {
                                                    setEditingEntry(entry.id)
                                                    setEditForm({ qty: String(entry.qty_planned), note: entry.note || '' })
                                                  }}
                                                  className="text-gray-400 hover:text-blue-600 transition-colors"
                                                  title="Edit this entry"
                                                >
                                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                                  </svg>
                                                </button>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}

                                {/* New entry form */}
                                <div className="flex items-center gap-2 mt-2">
                                  <input
                                    type="number"
                                    min="1"
                                    placeholder="Qty"
                                    value={workLogForm[rec.asin]?.qty || ''}
                                    onChange={e => setWorkLogForm(prev => ({
                                      ...prev,
                                      [rec.asin]: { ...(prev[rec.asin] || { qty: '', note: '', submitting: false }), qty: e.target.value },
                                    }))}
                                    className="w-20 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                                  />
                                  <input
                                    type="text"
                                    placeholder="Note (optional)"
                                    value={workLogForm[rec.asin]?.note || ''}
                                    onChange={e => setWorkLogForm(prev => ({
                                      ...prev,
                                      [rec.asin]: { ...(prev[rec.asin] || { qty: '', note: '', submitting: false }), note: e.target.value },
                                    }))}
                                    className="flex-1 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
                                  />
                                  <button
                                    onClick={() => submitWorkLog(rec.asin, rec.fba_sku || rec.sku)}
                                    disabled={!workLogForm[rec.asin]?.qty || workLogForm[rec.asin]?.submitting}
                                    className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors whitespace-nowrap"
                                  >
                                    {workLogForm[rec.asin]?.submitting ? 'Saving…' : '+ Log Print Run'}
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
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
            <div className="flex items-center gap-2">
              <button onClick={triggerSync} disabled={syncing || excessLoading}
                className="px-3 py-2 text-xs border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-50 disabled:opacity-40 transition-colors inline-flex items-center gap-1.5">
                {syncing ? (
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {syncing ? 'Syncing FBA Data…' : 'Refresh from Amazon'}
              </button>
              <button onClick={() => downloadCSV('excess')} disabled={excessItems.length === 0}
                className="px-3 py-2 text-xs border border-orange-200 rounded-lg text-orange-700 hover:bg-orange-50 disabled:opacity-40 transition-colors">
                Export CSV
              </button>
            </div>
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
      {activeTab === 'analytics' && (() => {
        // Sort handler
        const handleSalesSort = (col: keyof SkuSalesRow) => {
          if (salesSortCol === col) {
            setSalesSortDir(salesSortDir === 'asc' ? 'desc' : 'asc')
          } else {
            setSalesSortCol(col)
            setSalesSortDir('desc')
          }
        }
        const sortArrow = (col: keyof SkuSalesRow) => salesSortCol === col ? (salesSortDir === 'asc' ? ' ▲' : ' ▼') : ''

        // Filter + sort
        const filteredSales = salesAnalytics
          .filter(row => {
            if (!salesSearch) return true
            const q = salesSearch.toLowerCase()
            return (
              row.sku.toLowerCase().includes(q) ||
              (row.asin || '').toLowerCase().includes(q) ||
              (row.product_name || '').toLowerCase().includes(q)
            )
          })
          .sort((a, b) => {
            const aVal = a[salesSortCol]
            const bVal = b[salesSortCol]
            if (aVal == null && bVal == null) return 0
            if (aVal == null) return 1
            if (bVal == null) return -1
            if (typeof aVal === 'number' && typeof bVal === 'number') {
              return salesSortDir === 'asc' ? aVal - bVal : bVal - aVal
            }
            const aStr = String(aVal)
            const bStr = String(bVal)
            return salesSortDir === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
          })

        return (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Sales Analytics</h2>
              <p className="text-sm text-gray-500 mt-0.5">Per-SKU sales velocity from the Amazon All Orders report · Last 7 / 30 / 90 days</p>
            </div>
            <button
              onClick={() => fetchSalesAnalytics(true)}
              disabled={analyticsLoading || analyticsSyncPending}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {analyticsLoading ? 'Syncing from Amazon…' : analyticsSyncPending ? 'Waiting for report…' : 'Sync & Refresh'}
            </button>
          </div>

          {/* Pending banner — shown while Amazon is generating the fresh report */}
          {analyticsSyncPending && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <svg className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <div>
                <span className="font-semibold">Amazon report requested.</span> Fresh sales data is being generated — this usually takes 1–3 minutes. The table will update automatically when ready.
              </div>
            </div>
          )}

          {/* Search bar */}
          <div className="mb-4">
            <input
              type="text"
              placeholder="Search by SKU, ASIN, or title…"
              value={salesSearch}
              onChange={e => setSalesSearch(e.target.value)}
              className="w-full max-w-md px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            {salesSearch && (
              <span className="ml-3 text-xs text-gray-500">
                {filteredSales.length} of {salesAnalytics.length} results
              </span>
            )}
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
                    <th onClick={() => handleSalesSort('sku')} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">SKU{sortArrow('sku')}</th>
                    <th onClick={() => handleSalesSort('asin')} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">ASIN{sortArrow('asin')}</th>
                    <th onClick={() => handleSalesSort('product_name')} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">Product{sortArrow('product_name')}</th>
                    <th onClick={() => handleSalesSort('fulfillment_channel')} className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">Channel{sortArrow('fulfillment_channel')}</th>
                    <th onClick={() => handleSalesSort('units_sold_7d')} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">7D Units{sortArrow('units_sold_7d')}</th>
                    <th onClick={() => handleSalesSort('units_sold_30d')} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">30D Units{sortArrow('units_sold_30d')}</th>
                    <th onClick={() => handleSalesSort('units_sold_90d')} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">90D Units{sortArrow('units_sold_90d')}</th>
                    <th onClick={() => handleSalesSort('revenue_30d')} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">30D Revenue{sortArrow('revenue_30d')}</th>
                    <th onClick={() => handleSalesSort('avg_daily_units')} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">Avg/Day{sortArrow('avg_daily_units')}</th>
                    <th onClick={() => handleSalesSort('last_order_date')} className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none">Last Order{sortArrow('last_order_date')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredSales.map(row => (
                    <tr key={row.sku} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">{row.sku}</td>
                      <td className="px-4 py-3 font-mono text-xs text-blue-600">{row.asin || '—'}</td>
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
            Data sourced from Amazon All Orders flat-file report (3×30-day windows for full 90-day coverage) · Updated on every sync
          </div>
        </>
        )
      })()}

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

          {/* Sync pending banner */}
          {listingsSyncPending && (
            <div className="mb-4 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <div>
                <span className="font-semibold">Amazon report requested.</span> The listings data is being refreshed from Amazon — this usually takes 1–3 minutes.
                {' '}<button onClick={() => fetchListingIssues(true)} className="underline font-medium hover:text-amber-900">Click here to check again</button> once ready. Issues you fixed in Seller Central will disappear after the report is processed.
              </div>
            </div>
          )}

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

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: MISSING INVENTORY
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'missing' && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Missing Inventory</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                FBM size/color combinations that are out of stock while sibling SKUs in the same family are still available
              </p>
            </div>
            <button
              onClick={() => fetchMissingInventory(missingFamily, missingSeverity)}
              disabled={missingLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {missingLoading ? 'Scanning…' : 'Refresh'}
            </button>
          </div>

          {/* Totals banner — cards are clickable to filter by severity */}
          {missingTotals && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <button
                onClick={() => {
                  const next = missingSeverity === 'critical' ? 'all' : 'critical'
                  setMissingSeverity(next)
                  fetchMissingInventory(missingFamily, next)
                }}
                className={`rounded-xl p-3 text-center transition-all border-2 ${
                  missingSeverity === 'critical'
                    ? 'bg-red-100 border-red-400 ring-2 ring-red-300'
                    : 'bg-red-50 border-red-200 hover:border-red-400 hover:bg-red-100'
                }`}
              >
                <div className="text-2xl font-bold text-red-700">{missingTotals.critical_gaps}</div>
                <div className="text-xs text-red-600 font-medium">Critical (Out of Stock)</div>
                <div className="text-[10px] text-red-400 mt-0.5">{missingSeverity === 'critical' ? 'Click to clear filter' : 'Click to filter'}</div>
              </button>
              <button
                onClick={() => {
                  const next = missingSeverity === 'warning' ? 'all' : 'warning'
                  setMissingSeverity(next)
                  fetchMissingInventory(missingFamily, next)
                }}
                className={`rounded-xl p-3 text-center transition-all border-2 ${
                  missingSeverity === 'warning'
                    ? 'bg-amber-100 border-amber-400 ring-2 ring-amber-300'
                    : 'bg-amber-50 border-amber-200 hover:border-amber-400 hover:bg-amber-100'
                }`}
              >
                <div className="text-2xl font-bold text-amber-700">{missingTotals.warning_gaps}</div>
                <div className="text-xs text-amber-600 font-medium">Warning (&lt;5 units)</div>
                <div className="text-[10px] text-amber-400 mt-0.5">{missingSeverity === 'warning' ? 'Click to clear filter' : 'Click to filter'}</div>
              </button>
              <button
                onClick={() => {
                  setMissingSeverity('all')
                  fetchMissingInventory(missingFamily, 'all')
                }}
                className={`rounded-xl p-3 text-center transition-all border-2 ${
                  missingSeverity === 'all'
                    ? 'bg-gray-100 border-gray-400 ring-2 ring-gray-300'
                    : 'bg-gray-50 border-gray-200 hover:border-gray-400 hover:bg-gray-100'
                }`}
              >
                <div className="text-2xl font-bold text-gray-700">{missingTotals.total_gaps}</div>
                <div className="text-xs text-gray-500 font-medium">Total Gaps</div>
                <div className="text-[10px] text-gray-400 mt-0.5">Click to show all</div>
              </button>
              <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold text-blue-700">{missingTotals.families_affected}</div>
                <div className="text-xs text-blue-600 font-medium">Families Affected</div>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {/* Search bar */}
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" /></svg>
              <input
                type="text"
                placeholder="Search SKU, ASIN, or family…"
                value={missingSearchQuery}
                onChange={e => setMissingSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-rose-300"
              />
            </div>
            <select
              value={missingSeverity}
              onChange={e => {
                setMissingSeverity(e.target.value)
                fetchMissingInventory(missingFamily, e.target.value)
              }}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-rose-300"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical Only</option>
              <option value="warning">Warning Only</option>
            </select>
            <select
              value={missingFamily}
              onChange={e => {
                setMissingFamily(e.target.value)
                fetchMissingInventory(e.target.value, missingSeverity)
              }}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-rose-300 max-w-xs"
            >
              <option value="">All Families</option>
              {missingSummary.map(s => (
                <option key={s.family} value={s.family}>
                  {s.family} ({s.critical_gaps} critical)
                </option>
              ))}
            </select>
            {(missingFamily || missingSeverity !== 'all' || missingSearchQuery) && (
              <button
                onClick={() => { setMissingFamily(''); setMissingSeverity('all'); setMissingSearchQuery(''); fetchMissingInventory('', 'all') }}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Family summary cards (top 10) */}
          {!missingFamily && missingSummary.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Top Families by Gap Count</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {missingSummary.slice(0, 9).map(s => (
                  <button
                    key={s.family}
                    onClick={() => { setMissingFamily(s.family); fetchMissingInventory(s.family, missingSeverity) }}
                    className="text-left p-3 rounded-xl border border-gray-200 bg-white hover:border-rose-300 hover:bg-rose-50 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-semibold text-gray-800 truncate max-w-[140px]">{s.family}</span>
                      <span className="flex items-center gap-1">
                        {s.critical_gaps > 0 && (
                          <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-bold">{s.critical_gaps}</span>
                        )}
                        {s.warning_gaps > 0 && (
                          <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full font-bold">{s.warning_gaps}</span>
                        )}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {s.sizes_affected} size{s.sizes_affected !== 1 ? 's' : ''} · {s.colors_affected} color{s.colors_affected !== 1 ? 's' : ''} · missing: {s.missing_sizes.join(', ')}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Gap detail table */}
          {(() => {
            const q = missingSearchQuery.trim().toLowerCase()
            const filteredGaps = q
              ? missingGaps.filter(g =>
                  g.sku.toLowerCase().includes(q) ||
                  (g.asin || '').toLowerCase().includes(q) ||
                  g.family.toLowerCase().includes(q)
                )
              : missingGaps
            return missingLoading ? (
              <div className="text-center py-12 text-gray-400">Scanning inventory gaps…</div>
            ) : filteredGaps.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                {q ? (
                  <>
                    <div className="text-4xl mb-3">🔍</div>
                    <p className="font-medium text-gray-600">No gaps match &ldquo;{missingSearchQuery}&rdquo;</p>
                    <p className="text-sm mt-1">Try a different SKU, ASIN, or family name.</p>
                  </>
                ) : (
                  <>
                    <div className="text-4xl mb-3">✅</div>
                    <p className="font-medium text-gray-600">No inventory gaps detected</p>
                    <p className="text-sm mt-1">All size/color combinations in each family are stocked.</p>
                  </>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">SKU</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">ASIN</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Family</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Size</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Color</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Qty</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Siblings Stocked</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Max Sibling Qty</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Severity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredGaps.map(gap => (
                      <tr key={gap.sku} className={`hover:bg-gray-50 transition-colors ${
                        gap.severity === 'critical' ? 'bg-red-50/30' : 'bg-amber-50/20'
                      }`}>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-700">{gap.sku}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-500">
                          {gap.asin ? (
                            <a
                              href={`https://www.amazon.com/dp/${gap.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {gap.asin}
                            </a>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{gap.family}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-700">
                            {gap.size_token}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-center font-mono text-xs text-gray-600">{gap.color_token}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-gray-900">{gap.quantity}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            gap.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {gap.status}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-center text-gray-600">
                          {gap.stocked_colors} / {gap.total_colors_for_size}
                        </td>
                        <td className="px-3 py-2.5 text-center font-medium text-gray-700">{gap.max_qty_in_sibling}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            gap.severity === 'critical'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}>
                            {gap.severity}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })()}

          <div className="mt-3 text-xs text-gray-400 text-center">
            Gaps detected by comparing FBM stock levels across all SKUs in the same design family · Refreshed on every inventory sync
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: ADS MANAGER
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'ads' && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Ads Manager</h2>
              <p className="text-sm text-gray-500 mt-0.5">Amazon Advertising — Sponsored Products campaigns, keywords, and performance</p>
            </div>
            {adsStatus?.configured && (
              <button
                onClick={async () => {
                  setAdsSyncing(true)
                  try {
                    await fetch('/api/ads/sync', { method: 'POST' })
                    await fetchAdsData()
                  } finally {
                    setAdsSyncing(false)
                  }
                }}
                disabled={adsSyncing}
                className="px-4 py-2 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50 transition-colors"
              >
                {adsSyncing ? 'Syncing…' : 'Sync Now'}
              </button>
            )}
          </div>

          {adsLoading ? (
            <div className="text-center py-12 text-gray-400">Loading Ads data…</div>
          ) : !adsStatus?.configured ? (
            /* ── Setup Wizard ── */
            <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-8 text-center">
              <div className="text-4xl mb-3">📣</div>
              <h3 className="text-lg font-semibold text-yellow-900 mb-2">Amazon Ads API — Setup Required</h3>
              <p className="text-sm text-yellow-800 mb-6 max-w-lg mx-auto">
                Your Ads API application is being processed by Amazon. Once approved, add your credentials
                in <strong>Settings → Amazon Ads</strong> to unlock campaign management, keyword bidding,
                and performance analytics.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto text-left">
                {[
                  { step: '1', title: 'Register LWA App', desc: 'Go to advertising.amazon.com → Developer Center → Create Application' },
                  { step: '2', title: 'Get Credentials', desc: 'Copy Client ID, Client Secret, and Refresh Token from your LWA app' },
                  { step: '3', title: 'Add to Settings', desc: 'Paste credentials in Settings → Amazon Ads and save' },
                ].map(s => (
                  <div key={s.step} className="bg-white rounded-lg border border-yellow-200 p-4">
                    <div className="w-7 h-7 rounded-full bg-yellow-600 text-white text-sm font-bold flex items-center justify-center mb-2">{s.step}</div>
                    <div className="text-sm font-semibold text-gray-900 mb-1">{s.title}</div>
                    <div className="text-xs text-gray-500">{s.desc}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-6">
                Ads API approval typically takes 1–2 business days after submitting your application.
              </p>
            </div>
          ) : (
            <>
              {/* ── Summary Cards ── */}
              {adsSummary && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="text-xs text-gray-500 mb-1">30d Ad Spend</div>
                    <div className="text-2xl font-bold text-gray-900">${adsSummary.totalSpend.toLocaleString()}</div>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="text-xs text-gray-500 mb-1">30d Ad Sales</div>
                    <div className="text-2xl font-bold text-green-700">${adsSummary.totalSales.toLocaleString()}</div>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="text-xs text-gray-500 mb-1">Avg ACoS</div>
                    <div className={`text-2xl font-bold ${
                      adsSummary.avgAcos === null ? 'text-gray-400'
                      : adsSummary.avgAcos < 20 ? 'text-green-700'
                      : adsSummary.avgAcos < 35 ? 'text-yellow-700'
                      : 'text-red-700'
                    }`}>
                      {adsSummary.avgAcos !== null ? `${adsSummary.avgAcos}%` : '—'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="text-xs text-gray-500 mb-1">Active Campaigns</div>
                    <div className="text-2xl font-bold text-blue-700">{adsSummary.activeCampaigns}</div>
                    <div className="text-xs text-gray-400">{adsSummary.totalCampaigns} total</div>
                  </div>
                </div>
              )}

              {/* ── Campaigns Table ── */}
              {adsCampaigns.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-4xl mb-3">📊</div>
                  <p className="font-medium text-gray-700">No campaigns synced yet</p>
                  <p className="text-sm mt-1 text-gray-500">Click &quot;Sync Now&quot; to pull your campaigns from Amazon Ads.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {adsCampaigns.map(c => (
                    <div key={c.campaign_id} className={`rounded-xl border p-4 ${
                      c.state === 'enabled' ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50'
                    }`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                              c.state === 'enabled' ? 'bg-green-100 text-green-700'
                              : c.state === 'paused' ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-gray-100 text-gray-500'
                            }`}>
                              {c.state}
                            </span>
                            <span className="text-xs text-gray-400">{c.campaign_type}</span>
                            {c.daily_budget && (
                              <span className="text-xs text-gray-400">${c.daily_budget}/day</span>
                            )}
                          </div>
                          <p className="text-sm font-medium text-gray-900 truncate" title={c.name}>{c.name}</p>
                        </div>
                        <div className="text-right shrink-0 grid grid-cols-2 gap-x-4 gap-y-0.5">
                          <div className="text-xs text-gray-500">Spend</div>
                          <div className="text-xs text-gray-500">Sales</div>
                          <div className="text-sm font-bold text-gray-900">${c.perf_30d.cost.toLocaleString()}</div>
                          <div className="text-sm font-bold text-green-700">${c.perf_30d.sales.toLocaleString()}</div>
                          {c.perf_30d.acos !== null && (
                            <>
                              <div className="text-xs text-gray-500">ACoS</div>
                              <div className="text-xs text-gray-500">RoAS</div>
                              <div className={`text-xs font-semibold ${
                                c.perf_30d.acos < 20 ? 'text-green-700'
                                : c.perf_30d.acos < 35 ? 'text-yellow-700'
                                : 'text-red-700'
                              }`}>{c.perf_30d.acos}%</div>
                              <div className="text-xs font-semibold text-blue-700">
                                {c.perf_30d.roas !== null ? `${c.perf_30d.roas}x` : '—'}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {adsStatus?.stats.lastSynced && (
                <div className="mt-3 text-xs text-gray-400 text-center">
                  Last synced: {new Date(adsStatus.stats.lastSynced).toLocaleString()}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}


