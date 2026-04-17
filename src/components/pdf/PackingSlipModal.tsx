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

// ─── Attribute parser (mirrors PackingSlipDocument logic) ────────────────────
const SIZES = [
  'XX-Small', 'X-Small', 'Extra Small',
  '6X-Large', '5X-Large', '4X-Large', '3X-Large', '2X-Large', 'X-Large', 'Extra Large',
  '6XL', '5XL', '4XL', '3XL', '2XL', 'XXL', 'XXXL', 'XL',
  'Small', 'Medium', 'Large',
  'S/M', 'M/L', 'L/XL', 'Plus Size', 'One Size',
]
const COLORS = [
  'Light Green', 'Dark Green', 'Forest Green', 'Sage Green', 'Mint Green',
  'Light Blue', 'Dark Blue', 'Navy Blue', 'Royal Blue', 'Sky Blue', 'Baby Blue', 'True Navy',
  'Light Pink', 'Dark Pink', 'Hot Pink', 'Dusty Pink', 'Blush Pink',
  'Light Grey', 'Dark Grey', 'Heather Grey', 'Dark Heather',
  'Light Gray', 'Dark Gray', 'Heather Gray',
  'Off White', 'Cream', 'Ivory', 'Natural', 'Washed Denim', 'Denim', 'Chambray',
  'Black', 'White', 'Red', 'Orange', 'Yellow', 'Purple', 'Lavender',
  'Maroon', 'Burgundy', 'Wine', 'Rust', 'Mustard', 'Gold', 'Tan', 'Brown',
  'Teal', 'Aqua', 'Coral', 'Peach', 'Espresso', 'Seafoam', 'Butter',
  'Granite', 'Sandstone', 'Brick', 'Moss', 'Olive', 'Pepper',
  'Navy', 'Green', 'Blue', 'Pink', 'Gray', 'Grey',
]
const STYLES: [string, string][] = [
  ['Comfort Colors', 'Comfort Colors / Short Sleeve'],
  ['Long Sleeve', 'Long Sleeve'], ['V-Neck', 'V-Neck'], ['V Neck', 'V-Neck'],
  ['Vneck', 'V-Neck'], ['Crop Top', 'Crop Top'], ['Crop Tee', 'Crop Top'],
  ['Tank Top', 'Tank Top'], ['Tank', 'Tank Top'], ['Muscle Tee', 'Muscle Tee'],
  ['Raglan', 'Raglan'], ['Pullover Hoodie', 'Pullover Hoodie'],
  ['Zip-Up Hoodie', 'Zip-Up Hoodie'], ['Zip Hoodie', 'Zip-Up Hoodie'],
  ['Hoodie', 'Pullover Hoodie'], ['Crewneck Sweatshirt', 'Crewneck Sweatshirt'],
  ['Crewneck', 'Crewneck Sweatshirt'], ['Sweatshirt', 'Crewneck Sweatshirt'],
  ['T-Shirt', 'Short Sleeve'], ['Tee', 'Short Sleeve'],
]

function extractVariantFromSku(sku: string): string | null {
  if (!sku) return null
  const tsMatch = sku.match(/TS-([A-Za-z]+)$/i)
  if (tsMatch) return tsMatch[1]
  return null
}

function parseAttrs(title: string, sku?: string) {
  let size: string | null = null, color: string | null = null, style: string | null = null
  for (const s of SIZES) {
    const re = new RegExp(`(?<![A-Za-z])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i')
    if (re.test(title)) { size = s; break }
  }
  if (!size) { const m = title.match(/\b(XS|[SMLX])\b/); if (m) size = m[1].toUpperCase() }
  const sc = [...COLORS].sort((a, b) => b.length - a.length)
  for (const c of sc) {
    const re = new RegExp(`(?<![A-Za-z])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i')
    if (re.test(title)) { color = c; break }
  }
  for (const [kw, lbl] of STYLES) {
    const re = new RegExp(`(?<![A-Za-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i')
    if (re.test(title)) { style = lbl; break }
  }
  const variant = sku ? extractVariantFromSku(sku) : null
  return { size: size || '—', color: color || '—', style: style || 'Short Sleeve', variant }
}

function cleanTitle(title: string): string {
  let t = title
  for (let i = 0; i < 2; i++) t = t.replace(/\s*[-–]\s*[A-Z][a-zA-Z\s]+$/, '').trim()
  return t.replace(/\s*[-–]\s*$/, '').trim()
}

interface PackingSlipModalProps {
  order: Order
  onClose: () => void
}

export default function PackingSlipModal({ order, onClose }: PackingSlipModalProps) {
  const [downloading, setDownloading] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

  const shipTo = order.ship_to as ShipTo | null
  const totalQty = items.reduce((s, i) => s + i.qty, 0)

  const shipBy = order.raw_data &&
    typeof order.raw_data === 'object' &&
    !Array.isArray(order.raw_data) &&
    'LatestShipDate' in order.raw_data
    ? formatDateShort(String((order.raw_data as Record<string, unknown>).LatestShipDate))
    : null

  async function handleDownload() {
    setDownloading(true)
    try {
      const { generateSinglePDF } = await import('@/lib/pdf/generatePDF')
      await generateSinglePDF(order)
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

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
              onClick={() => window.print()}
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
              {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {downloading ? 'Generating…' : 'Download PDF'}
            </button>
            <button onClick={onClose} className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Packing Slip Preview (HTML) */}
        <div className="flex-1 overflow-auto p-6 bg-gray-100">
          <div
            id="packing-slip-print"
            className="bg-white rounded-lg shadow-sm max-w-2xl mx-auto p-8"
          >
            {/* ── Header: CEO logo | Store is on | Amazon logo ── */}
            <div className="flex items-center justify-center gap-4 mb-5 pb-4 border-b-2 border-[#2E9CE6]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/theceo_logo_registered.png" alt="TheCEO®" className="h-14 w-14 object-contain" />
              <span className="text-sm text-gray-500 font-medium">Store is on</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/amazon_logo.png" alt="Amazon" className="h-7 object-contain" />
            </div>

            {/* Order Info */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Order Number</p>
                <p className="text-sm font-bold font-mono text-gray-900 break-all">{order.id}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Order Date</p>
                <p className="text-sm font-bold text-gray-900">{formatDateShort(order.purchase_date)}</p>
              </div>
            </div>

            {/* Ship To + Ship By */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="col-span-2 bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Ship To</p>
                <p className="font-bold text-gray-900 text-sm">{shipTo?.name || order.buyer_name || 'Customer'}</p>
                {shipTo && (
                  <div className="text-xs text-gray-700 mt-1 space-y-0.5">
                    <p>{shipTo.addressLine1}</p>
                    {shipTo.addressLine2 && <p>{shipTo.addressLine2}</p>}
                    <p>{shipTo.city}, {shipTo.stateOrRegion} {shipTo.postalCode}</p>
                    {shipTo.phone && <p className="text-gray-400">{shipTo.phone}</p>}
                  </div>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Ship By</p>
                <p className="text-sm font-bold text-red-600">{shipBy || '—'}</p>
                <p className="text-xs text-gray-500 uppercase tracking-wide mt-2 mb-1">Total Items</p>
                <p className="text-sm font-bold text-gray-900">{totalQty} unit{totalQty !== 1 ? 's' : ''}</p>
              </div>
            </div>

            {/* Items Table */}
            <p className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">Order Items</p>
            <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#2E9CE6] text-white">
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-10">Qty</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-16">Image</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide">Product</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-36">Size / Color / Style</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item, index) => {
                    const attrs = parseAttrs(item.title, item.sku)
                    const title = cleanTitle(item.title)
                    return (
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
                              className="w-16 h-16 object-contain rounded border border-gray-200 bg-white"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-16 h-16 bg-gray-100 rounded border border-gray-200 flex items-center justify-center">
                              <span className="text-xs text-gray-400 text-center">No Image</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-medium text-gray-900 text-xs leading-relaxed mb-1">
                            {title.length > 100 ? title.substring(0, 97) + '...' : title}
                          </p>
                          <p className="text-xs text-gray-400 font-mono">SKU: {item.sku || '—'}</p>
                        </td>
                        <td className="px-3 py-3">
                          <div className="space-y-0.5">
                            <p className="text-xs"><span className="text-gray-400 uppercase text-[10px]">Size: </span><span className="font-semibold text-gray-900">{attrs.size}</span></p>
                            <p className="text-xs"><span className="text-gray-400 uppercase text-[10px]">Color: </span><span className="font-semibold text-gray-900">{attrs.color}</span></p>
                            <p className="text-xs"><span className="text-gray-400 uppercase text-[10px]">Style: </span><span className="font-semibold text-gray-900">{attrs.style}</span></p>
                            {attrs.variant && (
                              <p className="text-xs"><span className="text-gray-400 uppercase text-[10px]">Team: </span><span className="font-semibold text-gray-900">{attrs.variant}</span></p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Review / Thank You section */}
            <div className="flex rounded-lg border border-[#2E9CE6] overflow-hidden bg-[#EFF8FF]">
              {/* Blue left bar */}
              <div className="w-16 bg-[#2E9CE6] flex flex-col items-center justify-center py-4 px-2 shrink-0">
                <p className="text-white text-xs font-bold text-center leading-tight mb-3">thank you<br />for your<br />order!</p>
                <div className="flex flex-col items-center gap-0.5">
                  {['★', '★', '★', '★'].map((s, i) => (
                    <span key={i} className="text-yellow-400 text-sm">{s}</span>
                  ))}
                </div>
              </div>

              {/* Main content */}
              <div className="flex-1 p-4">
                <p className="text-xs font-bold text-[#2E9CE6] mb-0.5">FEEDBACK ON OUR AMAZON PRODUCT &amp; SERVICE</p>
                <p className="text-xs font-bold text-[#2E9CE6] mb-2">WOULD MEAN THE WORLD TO US!</p>
                <div className="flex gap-0.5 mb-2">
                  {['★', '★', '★', '★', '★'].map((s, i) => (
                    <span key={i} className="text-yellow-400 text-lg">{s}</span>
                  ))}
                </div>
                <p className="text-xs font-semibold text-gray-700 mb-1">How to leave a review:</p>
                <p className="text-xs text-gray-700 mb-0.5">1  Go to &apos;Your Orders&apos;</p>
                <p className="text-xs text-gray-700 mb-0.5">2  Select the product and tap &apos;Write a Review.&apos;</p>
                <p className="text-xs text-gray-700 mb-2">3  Share your honest feedback to help others!</p>
                <p className="text-xs text-gray-400 italic">Your support helps us continue to bring you great products!</p>
              </div>

              {/* QR code */}
              <div className="w-28 flex flex-col items-center justify-center p-3 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/qr_code.png" alt="QR Code" className="w-20 h-20 mb-2" />
                <p className="text-[10px] font-bold text-gray-800 text-center leading-tight">What&apos;s on the other side of this</p>
                <p className="text-[10px] text-gray-700 text-center leading-tight">QR code will Change. Your. LIFE!*</p>
                <p className="text-[10px] text-gray-500 text-center leading-tight">*okay, that&apos;s a little dramatic but just scan it already.</p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-between items-center pt-3 border-t border-gray-100 mt-3">
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
          body > *:not(#packing-slip-print) { display: none !important; }
          #packing-slip-print {
            display: block !important;
            position: fixed;
            top: 0; left: 0;
            width: 100%;
            padding: 20px;
            box-shadow: none;
          }
        }
      `}</style>
    </div>
  )
}
