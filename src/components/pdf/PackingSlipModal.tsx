'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { X, Download, Printer, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Order, OrderItem, ShipTo } from '@/types/database'
import { formatDate, formatDateShort } from '@/lib/utils'

// Dynamically import PDFViewer to avoid SSR issues
const PDFDownloadLink = dynamic(
  () => import('@react-pdf/renderer').then((mod) => mod.PDFDownloadLink),
  { ssr: false, loading: () => null }
)

const PackingSlipDocument = dynamic(
  () => import('@/lib/pdf/PackingSlipDocument'),
  { ssr: false, loading: () => null }
)

interface PackingSlipModalProps {
  order: Order
  onClose: () => void
}

export default function PackingSlipModal({ order, onClose }: PackingSlipModalProps) {
  const [downloading, setDownloading] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    // Prevent body scroll
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

  const shipTo = order.ship_to as ShipTo | null

  async function handleDownload() {
    setDownloading(true)
    try {
      const { generateSinglePDF } = await import('@/lib/pdf/generatePDF')
      await generateSinglePDF(order)

      // Log download
      await fetch('/api/downloads/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, downloadType: 'single' }),
      })

      toast.success('Packing slip downloaded')
    } catch {
      toast.error('Download failed')
    } finally {
      setDownloading(false)
    }
  }

  function handlePrint() {
    window.print()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Packing Slip Preview</h2>
            <p className="text-sm text-gray-500 font-mono">{order.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors no-print"
            >
              <Printer size={14} />
              Print
            </button>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#2E9CE6] hover:bg-[#1A7BC4] disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {downloading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {downloading ? 'Generating…' : 'Download PDF'}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Packing Slip Preview (HTML version for screen) */}
        <div className="flex-1 overflow-auto p-6 bg-gray-100">
          <div
            id="packing-slip-print"
            className="bg-white rounded-lg shadow-sm max-w-2xl mx-auto p-8"
          >
            {/* Logo */}
            <div className="flex justify-center mb-6 pb-4 border-b-2 border-[#2E9CE6]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.png"
                alt="TheCEO.Store"
                className="h-16 object-contain"
              />
            </div>

            {/* Order Info Grid */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Order #</p>
                <p className="text-sm font-bold font-mono text-gray-900 break-all">{order.id}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Date</p>
                <p className="text-sm font-bold text-gray-900">{formatDateShort(order.purchase_date)}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Status</p>
                <p className="text-sm font-bold text-gray-900">{order.order_status || '—'}</p>
              </div>
            </div>

            {/* Ship To */}
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 mb-5">
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Ship To</p>
              <p className="font-bold text-gray-900">{shipTo?.name || order.buyer_name || 'Customer'}</p>
              {shipTo && (
                <div className="text-sm text-gray-700 mt-1 space-y-0.5">
                  <p>{shipTo.addressLine1}</p>
                  {shipTo.addressLine2 && <p>{shipTo.addressLine2}</p>}
                  <p>{shipTo.city}, {shipTo.stateOrRegion} {shipTo.postalCode}</p>
                  <p>{shipTo.countryCode}</p>
                  {shipTo.phone && <p className="text-gray-500">{shipTo.phone}</p>}
                </div>
              )}
            </div>

            {/* Items Table */}
            <p className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">Order Items</p>
            <div className="border border-gray-200 rounded-lg overflow-hidden mb-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#2E9CE6] text-white">
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-10">Qty</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-16">Image</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide">Product</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-24">SKU</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-24">ASIN</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item, index) => (
                    <tr key={`${item.asin}-${index}`} className={index % 2 === 1 ? 'bg-gray-50' : 'bg-white'}>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#2E9CE6] text-white text-xs font-bold">
                          {item.qty}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {item.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.image_url}
                            alt={item.title}
                            className="w-14 h-14 object-contain rounded border border-gray-200 bg-white"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none'
                            }}
                          />
                        ) : (
                          <div className="w-14 h-14 bg-gray-100 rounded border border-gray-200 flex items-center justify-center">
                            <span className="text-xs text-gray-400 text-center">No Image</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-gray-900 text-xs leading-relaxed">{item.title}</p>
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-xs text-gray-500 font-mono">{item.sku || '—'}</span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="text-xs text-gray-500 font-mono">{item.asin}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Thank You */}
            <div className="text-center py-4 border-t border-gray-200">
              <p className="font-bold text-gray-900 text-base mb-1">Thank you for your order!</p>
              <p className="text-sm text-gray-500">Questions? Contact us at orders@theceo.store</p>
            </div>

            {/* Footer */}
            <div className="flex justify-between items-center pt-3 border-t border-gray-100 mt-2">
              <span className="text-xs text-gray-400">Generated: {formatDate(new Date().toISOString())}</span>
              <span className="text-xs font-bold text-[#2E9CE6]">TheCEO.Store</span>
              <span className="text-xs text-gray-400 font-mono">{order.id}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Print-only styles */}
      <style jsx global>{`
        @media print {
          body > *:not(#packing-slip-print) {
            display: none !important;
          }
          #packing-slip-print {
            display: block !important;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            padding: 20px;
            box-shadow: none;
          }
        }
      `}</style>
    </div>
  )
}
