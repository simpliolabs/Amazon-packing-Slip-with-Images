'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  Search,
  Download,
  FileDown,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Package,
  Calendar,
  Filter,
} from 'lucide-react'
import { formatDate, getStatusColor, getTotalItems, cn } from '@/lib/utils'
import type { Order } from '@/types/database'
import PackingSlipModal from '@/components/pdf/PackingSlipModal'

interface OrdersTableProps {
  userRole: 'admin' | 'packer'
}

interface OrdersResponse {
  orders: Order[]
  total: number
  page: number
  totalPages: number
}

const ORDER_STATUSES = [
  'All',
  'Unshipped',
  'PartiallyShipped',
  'Shipped',
  'Pending',
  'Canceled',
]

export default function OrdersTable({ userRole }: OrdersTableProps) {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('All')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchOrders = useCallback(async (currentPage = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(currentPage),
        limit: '25',
      })
      if (search) params.set('search', search)
      if (status !== 'All') params.set('status', status)
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
  }, [search, status, dateFrom, dateTo])

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
    // Auto-refresh every 30 minutes
    const interval = setInterval(() => {
      fetchOrders(page)
      fetchLastSync()
    }, 30 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchLastSync, fetchOrders, page])

  function handleSearchChange(value: string) {
    setSearch(value)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      setPage(1)
    }, 400)
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

  async function handleBulkDownload() {
    if (selectedOrders.size === 0) {
      toast.error('Select at least one order')
      return
    }
    setBulkDownloading(true)
    try {
      const selectedOrderObjects = orders.filter((o) => selectedOrders.has(o.id))

      // Dynamic import to avoid SSR issues
      const { generateBulkPDF } = await import('@/lib/pdf/generatePDF')
      await generateBulkPDF(selectedOrderObjects)

      // Log bulk download
      await fetch('/api/downloads/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: null, downloadType: 'bulk' }),
      })

      toast.success(`Downloaded ${selectedOrders.size} packing slips`)
      setSelectedOrders(new Set())
    } catch (err) {
      toast.error('Bulk download failed')
      console.error(err)
    } finally {
      setBulkDownloading(false)
    }
  }

  const getItemCount = (order: Order) => {
    const items = Array.isArray(order.order_items) ? order.order_items : []
    return getTotalItems(items as Array<{ qty: number }>)
  }

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">FBM Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {total} orders
            {lastSync && (
              <span className="ml-2 text-gray-400">
                · Last sync: {formatDate(lastSync)}
              </span>
            )}
          </p>
        </div>

        {selectedOrders.size > 0 && (
          <button
            onClick={handleBulkDownload}
            disabled={bulkDownloading}
            className="flex items-center gap-2 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <FileDown size={16} className={bulkDownloading ? 'animate-bounce' : ''} />
            {bulkDownloading
              ? 'Generating…'
              : `Download ${selectedOrders.size} Slip${selectedOrders.size > 1 ? 's' : ''}`}
          </button>
        )}
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

          {/* Status filter */}
          <div className="relative">
            <Filter
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1) }}
              className="pl-8 pr-8 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E9CE6] bg-white appearance-none cursor-pointer"
            >
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
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
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={orders.length > 0 && selectedOrders.size === orders.length}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 text-[#2E9CE6] focus:ring-[#2E9CE6]"
                  />
                </th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Order ID</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Date</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Customer</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-600">Items</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Status</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="px-4 py-3"><div className="w-4 h-4 bg-gray-200 rounded" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-36" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-28" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-32" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-8 mx-auto" /></td>
                    <td className="px-4 py-3"><div className="h-6 bg-gray-200 rounded-full w-20" /></td>
                    <td className="px-4 py-3"><div className="h-8 bg-gray-200 rounded w-24 ml-auto" /></td>
                  </tr>
                ))
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <Package size={40} className="mx-auto text-gray-300 mb-3" />
                    <p className="text-gray-500 font-medium">No orders found</p>
                    <p className="text-gray-400 text-xs mt-1">
                      {search || status !== 'All' || dateFrom || dateTo
                        ? 'Try adjusting your filters'
                        : 'Click "Sync Now" to pull orders from Amazon'}
                    </p>
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
                        className="rounded border-gray-300 text-[#2E9CE6] focus:ring-[#2E9CE6]"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-medium text-gray-900">
                        {order.id}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {formatDate(order.purchase_date)}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-gray-900 truncate max-w-[160px]">
                          {order.buyer_name || '—'}
                        </p>
                        {order.buyer_email && (
                          <p className="text-xs text-gray-400 truncate max-w-[160px]">
                            {order.buyer_email}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-gray-100 text-gray-700 text-xs font-bold">
                        {getItemCount(order)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border',
                          getStatusColor(order.order_status || '')
                        )}
                      >
                        {order.order_status || 'Unknown'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2E9CE6] hover:bg-[#1A7BC4] text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <Download size={12} />
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
              Page {page} of {totalPages} · {total} total orders
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  )
}
