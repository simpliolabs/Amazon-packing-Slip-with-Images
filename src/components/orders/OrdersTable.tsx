'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  Search,
  Printer,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Package,
  Calendar,
} from 'lucide-react'
import { formatDate, getStatusColor, getTotalItems, cn } from '@/lib/utils'
import type { Order, OrderItem, ShipTo } from '@/types/database'
import PackingSlipModal from '@/components/pdf/PackingSlipModal'

// ── Shipping service level badge helper ──────────────────────────────────────
function ShipBadge({ level }: { level: string | null | undefined }) {
  if (!level) return null
  const l = level.toLowerCase()
  if (l.includes('sameday') || l.includes('same_day') || l.includes('overnight') || l.includes('nextday') || l.includes('next_day')) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-red-600 text-white uppercase tracking-wide animate-pulse">
        !! SHIP NOW
      </span>
    )
  }
  if (l.includes('priority') || l.includes('secondday') || l.includes('second_day') || l.includes('2day') || l.includes('twoday')) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-red-500 text-white uppercase tracking-wide">
        🚀 PRIORITY
      </span>
    )
  }
  if (l.includes('expedited') || l.includes('express')) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-orange-500 text-white uppercase tracking-wide">
        ⚡ EXPEDITED
      </span>
    )
  }
  if (l.includes('standard') || l.includes('ground')) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-blue-600 text-white uppercase tracking-wide">
        📦 STANDARD
      </span>
    )
  }
  if (l.includes('free') || l.includes('economy')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-200 text-gray-600">
        FREE Shipping
      </span>
    )
  }
  // Fallback: show the raw level in a neutral badge
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 uppercase tracking-wide">
      {level}
    </span>
  )
}

interface OrdersTableProps {
  userRole: 'admin' | 'packer'
}

interface OrdersResponse {
  orders: Order[]
  total: number
  page: number
  totalPages: number
}

type Tab = 'active' | 'shipped' | 'all'

const TABS: { key: Tab; label: string; description: string }[] = [
  { key: 'active', label: 'Active', description: 'Unshipped & Pending' },
  { key: 'shipped', label: 'Shipped', description: 'Completed orders' },
  { key: 'all', label: 'All Orders', description: 'Everything' },
]

export default function OrdersTable({ userRole }: OrdersTableProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<Tab>('active')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [bulkPrinting, setBulkPrinting] = useState(false)
  const [printStatusText, setPrintStatusText] = useState('')
  const [lastSync, setLastSync] = useState<string | null>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchOrders = useCallback(async (currentPage = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(currentPage),
        limit: '25',
        tab,
      })
      if (search) params.set('search', search)
      if (dateFrom) params.set('dateFrom', dateFrom)
      if (dateTo) params.set('dateTo', dateTo)

      const res = await fetch(`/api/orders?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to fetch orders')

      const data: OrdersResponse = await res.json()
      setOrders(data.orders)
      setTotal(data.total)
      setTotalPages(data.totalPages)
    } catch {
      toast.error('Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [search, tab, dateFrom, dateTo])

  const fetchLastSync = useCallback(async () => {
    try {
      const res = await fetch('/api/sync')
      const data = await res.json()
      if (data.lastSync?.completed_at) {
        setLastSync(data.lastSync.completed_at)
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchOrders(page)
  }, [fetchOrders, page])

  useEffect(() => {
    fetchLastSync()
    const interval = setInterval(() => {
      fetchOrders(page)
      fetchLastSync()
    }, 30 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchLastSync, fetchOrders, page])

  // Listen for sync-complete event from Sync Now button to refresh data
  useEffect(() => {
    const handleSyncComplete = () => {
      fetchOrders(page)
      fetchLastSync()
    }
    window.addEventListener('sync-complete', handleSyncComplete)
    return () => window.removeEventListener('sync-complete', handleSyncComplete)
  }, [fetchOrders, fetchLastSync, page])

  function handleSearchChange(value: string) {
    setSearch(value)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      setPage(1)
    }, 400)
  }

  function handleTabChange(newTab: Tab) {
    setTab(newTab)
    setPage(1)
    setSelectedOrders(new Set())
  }

  function toggleSelectOrder(orderId: string) {
    setSelectedOrders((prev) => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedOrders.size === orders.length) {
      setSelectedOrders(new Set())
    } else {
      setSelectedOrders(new Set(orders.map((o) => o.id)))
    }
  }

  async function handleBulkPrint() {
    if (selectedOrders.size === 0) {
      toast.error('Select at least one order')
      return
    }
    setBulkPrinting(true)
    setPrintStatusText('Loading…')
    try {
      const selectedOrderObjects = orders.filter((o) => selectedOrders.has(o.id))

      const { generateBulkPrintHTML } = await import('@/lib/pdf/bulkPrintHTML')
      await generateBulkPrintHTML(selectedOrderObjects, (phase, detail) => {
        setPrintStatusText(detail || phase)
      })

      toast.success(`Opened ${selectedOrders.size} packing slips for printing`)
    } catch (err) {
      toast.error('Bulk print failed. Please try again.')
      console.error(err)
    } finally {
      setBulkPrinting(false)
      setPrintStatusText('')
    }
  }

  const getItemCount = (order: Order) => {
    const items = Array.isArray(order.order_items) ? order.order_items : []
    return getTotalItems(items as Array<{ qty: number }>)
  }

  const getCustomerName = (order: Order): string => {
    if (order.buyer_name) return order.buyer_name
    if (order.ship_to && typeof order.ship_to === 'object' && 'name' in order.ship_to) {
      return (order.ship_to as ShipTo).name || '—'
    }
    return '—'
  }

  const hasCustomization = (order: Order): boolean => {
    const items = Array.isArray(order.order_items) ? order.order_items : []
    return items.some((item: OrderItem) => 
      item.customization && item.customization.surfaces && item.customization.surfaces.length > 0
    )
  }

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">FBM Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {total} order{total !== 1 ? 's' : ''}
            <span className="ml-1 text-gray-400">· Last 7 days</span>
            {lastSync && (
              <span className="ml-2 text-gray-400">
                · Last sync: {formatDate(lastSync)}
              </span>
            )}
          </p>
        </div>

        {selectedOrders.size > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleBulkPrint}
              disabled={bulkPrinting}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Printer size={16} className={bulkPrinting ? 'animate-pulse' : ''} />
              {bulkPrinting
                ? printStatusText || 'Preparing…'
                : `Print ${selectedOrders.size} Slip${selectedOrders.size > 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleTabChange(key)}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-md transition-all',
              tab === key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              placeholder="Search by Order ID, customer name or email…"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] focus:border-transparent"
            />
          </div>

          {/* Date range */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <Calendar
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
                className="pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] bg-white"
              />
            </div>
            <span className="text-gray-400 text-sm">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] bg-white"
            />
          </div>

          <button
            onClick={() => fetchOrders(page)}
            className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg text-sm transition-colors"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={orders.length > 0 && selectedOrders.size === orders.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-[#2E9CE6] focus:ring-[#2E9CE6] cursor-pointer"
                  />
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Order ID
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Customer
                </th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Items
                </th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    <RefreshCw size={20} className="animate-spin mx-auto mb-2" />
                    Loading orders…
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                    <Package size={24} className="mx-auto mb-2 opacity-50" />
                    {tab === 'active'
                      ? 'No active orders in the last 7 days'
                      : tab === 'shipped'
                        ? 'No shipped orders in the last 7 days'
                        : 'No orders found'}
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr
                    key={order.id}
                    className={cn(
                      'hover:bg-gray-50 transition-colors',
                      selectedOrders.has(order.id) && 'bg-blue-50/50'
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedOrders.has(order.id)}
                        onChange={() => toggleSelectOrder(order.id)}
                        className="w-4 h-4 rounded border-gray-300 text-[#2E9CE6] focus:ring-[#2E9CE6] cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      <div className="flex items-center gap-2">
                        <span>{order.id}</span>
                        {hasCustomization(order) && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 uppercase tracking-wide">
                            Custom
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {formatDate(order.purchase_date)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {getCustomerName(order)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 text-center">
                      {getItemCount(order)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <span
                          className={cn(
                            'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                            getStatusColor(order.order_status ?? '')
                          )}
                        >
                          {order.order_status}
                        </span>
                        <ShipBadge level={(order as Order & { ship_service_level?: string | null }).ship_service_level} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <Printer size={12} />
                        Packing Slip
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Packing Slip Modal */}
      {selectedOrder && (
        <PackingSlipModal
          order={selectedOrder}
          orders={orders}
          onClose={() => setSelectedOrder(null)}
          onNavigate={(order) => setSelectedOrder(order)}
        />
      )}
    </div>
  )
}
