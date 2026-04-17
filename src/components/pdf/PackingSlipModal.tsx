'use client'

import { useState, useEffect } from 'react'
import { X, Download, Printer, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Order, OrderItem, ShipTo } from '@/types/database'
import { formatDate, formatDateShort } from '@/lib/utils'

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
  'Black', 'White', 'Red', 'Orange', 'Yellow', 'Purple', 'Lavender', 'Violet',
  'Maroon', 'Burgundy', 'Wine', 'Rust', 'Mustard', 'Gold', 'Tan', 'Brown',
  'Teal', 'Aqua', 'Coral', 'Peach', 'Espresso', 'Seafoam', 'Butter',
  'Granite', 'Sandstone', 'Brick', 'Moss', 'Olive', 'Pepper',
  'Crunchberry', 'Yam', 'Lagoon', 'Blossom', 'Chalky Mint', 'Flo Blue',
  'Island Reef', 'Orchid', 'Berry', 'Citrus', 'Crimson', 'Graphite',
  'Ice Blue', 'Ivory', 'Khaki', 'Neon Pink', 'Neon Green', 'Neon Orange',
  'Sapphire', 'Seafoam', 'Terracotta', 'Watermelon', 'Chambray',
  'Bright Salmon', 'Blue Jean', 'Blue Spruce', 'Burnt Orange',
  'Candy Pink', 'Chili', 'Crimson', 'Denim', 'Faded Blue',
  'Hemp', 'Ivory', 'Jean', 'Lagoon Blue', 'Light Green',
  'Midnight', 'Moss', 'Mustard', 'Neon Blue', 'Old Gold',
  'Periwinkle', 'Pigment Black', 'Red Orange', 'Sage',
  'Sandstone', 'Smoke', 'Vineyard', 'Washed Denim',
  'Navy', 'Green', 'Blue', 'Pink', 'Gray', 'Grey',
  'Coral Silk',
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

/**
 * Fallback: extract color from the title's trailing segments.
 * Amazon titles often end with "- Color - Size" pattern.
 * We look for the segment before the size segment.
 */
function extractColorFromTitleSegments(title: string, detectedSize: string | null): string | null {
  // Split by " - " delimiter
  const segments = title.split(/\s*[-–]\s*/).map(s => s.trim()).filter(Boolean)
  if (segments.length < 2) return null

  // Find the size segment index
  if (detectedSize) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]
      if (seg.toLowerCase() === detectedSize.toLowerCase() ||
          seg.match(new RegExp(`^${detectedSize.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))) {
        // The segment before the size is likely the color
        if (i > 0) {
          const colorCandidate = segments[i - 1]
          // Validate: should be 1-3 words, not too long, not a product description
          if (colorCandidate.split(/\s+/).length <= 3 && colorCandidate.length <= 30) {
            return colorCandidate
          }
        }
      }
    }
  }

  // Last resort: take the second-to-last segment if last looks like a size
  const last = segments[segments.length - 1]
  const sizePattern = /^(XX?S|[SMLX]|XX?L|[2-6]?X[LS]|Small|Medium|Large|X-Small|X-Large|2X-Large|3X-Large|4X-Large|5X-Large|6X-Large|One Size|Plus Size)$/i
  if (sizePattern.test(last) && segments.length >= 3) {
    const colorCandidate = segments[segments.length - 2]
    if (colorCandidate.split(/\s+/).length <= 3 && colorCandidate.length <= 30) {
      return colorCandidate
    }
  }

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

  // Fallback: extract color from title segments if not found in known list
  if (!color) {
    color = extractColorFromTitleSegments(title, size)
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

/**
 * Print the packing slip using an iframe for clean, reliable output.
 * This avoids all CSS conflicts with the parent page.
 */
function handlePrint(orderId: string) {
  const content = document.getElementById('packing-slip-print')
  if (!content) return

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.top = '-10000px'
  iframe.style.left = '-10000px'
  iframe.style.width = '8.5in'
  iframe.style.height = '11in'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument || iframe.contentWindow?.document
  if (!doc) { document.body.removeChild(iframe); return }

  // Get all stylesheets from the parent page
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map(el => el.outerHTML)
    .join('\n')

  doc.open()
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>${orderId}</title>
      ${styles}
      <style>
        @page {
          size: letter portrait;
          margin: 0.5in;
        }
        html, body {
          margin: 0;
          padding: 0;
          background: white;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        body {
          padding: 0.25in;
        }
        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        img {
          max-width: 100%;
        }
        /* Page break handling — never split these elements across pages */
        tr {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        table {
          break-inside: auto;
          page-break-inside: auto;
        }
        thead {
          display: table-header-group;
        }
        /* Keep the feedback/review card together */
        .review-card {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        /* Keep the footer together */
        .slip-footer {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        /* Keep feedback + footer together if possible */
        .review-footer-group {
          break-inside: avoid;
          page-break-inside: avoid;
        }
      </style>
    </head>
    <body>
      ${content.innerHTML}
    </body>
    </html>
  `)
  doc.close()

  // Wait for images to load before printing
  const images = Array.from(doc.querySelectorAll('img'))
  const imagePromises = images.map(img => {
    if (img.complete) return Promise.resolve()
    return new Promise<void>((resolve) => {
      img.onload = () => resolve()
      img.onerror = () => resolve()
      // Timeout after 5 seconds
      setTimeout(resolve, 5000)
    })
  })

  Promise.all(imagePromises).then(() => {
    // Small delay to ensure rendering is complete
    setTimeout(() => {
      iframe.contentWindow?.print()
      // Clean up after print dialog closes
      setTimeout(() => {
        document.body.removeChild(iframe)
      }, 1000)
    }, 500)
  })
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
      const content = document.getElementById('packing-slip-print')
      if (!content) throw new Error('Content not found')

      const html2canvas = (await import('html2canvas')).default
      const { jsPDF } = await import('jspdf')

      // Letter size in points: 612 x 792
      const letterWidth = 8.5 // inches
      const letterHeight = 11 // inches
      const dpi = 2 // scale factor for quality

      const canvas = await html2canvas(content, {
        scale: dpi,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        width: content.scrollWidth,
        height: content.scrollHeight,
      })

      const imgData = canvas.toDataURL('image/jpeg', 0.95)
      const imgWidthPx = canvas.width
      const imgHeightPx = canvas.height

      // Calculate how the content maps to letter pages
      const pdfPageWidthIn = letterWidth - 1 // 0.5in margins each side
      const pdfPageHeightIn = letterHeight - 1 // 0.5in margins each side
      const pdfPageWidthPt = pdfPageWidthIn * 72
      const pdfPageHeightPt = pdfPageHeightIn * 72

      // Scale image to fit page width
      const scale = pdfPageWidthPt / imgWidthPx
      const scaledHeight = imgHeightPx * scale

      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'pt',
        format: 'letter',
      })

      // If content fits on one page
      if (scaledHeight <= pdfPageHeightPt) {
        pdf.addImage(imgData, 'JPEG', 36, 36, pdfPageWidthPt, scaledHeight)
      } else {
        // Multi-page: slice the canvas into page-sized chunks
        const pageHeightPx = pdfPageHeightPt / scale
        const totalPages = Math.ceil(imgHeightPx / pageHeightPx)

        for (let page = 0; page < totalPages; page++) {
          if (page > 0) pdf.addPage('letter', 'portrait')

          const srcY = page * pageHeightPx
          const srcH = Math.min(pageHeightPx, imgHeightPx - srcY)
          const destH = srcH * scale

          // Create a sub-canvas for this page
          const pageCanvas = document.createElement('canvas')
          pageCanvas.width = imgWidthPx
          pageCanvas.height = srcH * dpi
          const ctx = pageCanvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(
              canvas,
              0, srcY * dpi, imgWidthPx, srcH * dpi,
              0, 0, imgWidthPx, srcH * dpi
            )
            const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.95)
            pdf.addImage(pageImgData, 'JPEG', 36, 36, pdfPageWidthPt, destH)
          }
        }
      }

      pdf.save(`${order.id}.pdf`)

      await fetch('/api/downloads/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, downloadType: 'single' }),
      })
      toast.success('Packing slip downloaded')
    } catch (err) {
      console.error('PDF download error:', err)
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
              onClick={() => handlePrint(order.id)}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
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
              {downloading ? 'Generating...' : 'Download PDF'}
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
              <img src="/theceo_logo_registered.png" alt="TheCEO" className="h-14 w-14 object-contain" />
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
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-28">Image</th>
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
                              className="w-24 h-24 object-contain rounded bg-white"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-24 h-24 bg-gray-100 rounded flex items-center justify-center">
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
            <div className="review-footer-group">
            <div className="review-card flex rounded-lg border border-[#2E9CE6] overflow-hidden bg-[#EFF8FF]">
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
            <div className="slip-footer flex justify-between items-center pt-3 border-t border-gray-100 mt-3">
              <span className="text-xs text-gray-400">Generated: {formatDate(new Date().toISOString())}</span>
              <span className="text-xs font-bold text-[#2E9CE6]">TheCEO.Store</span>
              <span className="text-xs text-gray-400 font-mono">{order.id}</span>
            </div>
            </div>{/* end review-footer-group */}
          </div>
        </div>
      </div>
    </div>
  )
}
