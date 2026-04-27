'use client'

import { useState, useEffect } from 'react'
import { X, Printer, ChevronUp, ChevronDown } from 'lucide-react'
import type { Order, OrderItem, ShipTo, CustomizationData } from '@/types/database'
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
  'Granite', 'Sand', 'Sandstone', 'Brick', 'Moss', 'Olive', 'Pepper',
  'Crunchberry', 'Yam', 'Lagoon', 'Blossom', 'Chalky Mint', 'Flo Blue',
  'Island Reef', 'Orchid', 'Berry', 'Citrus', 'Crimson', 'Graphite',
  'Ice Blue', 'Khaki', 'Neon Pink', 'Neon Green', 'Neon Orange',
  'Sapphire', 'Terracotta', 'Watermelon', 'Turquoise', 'Lilac', 'Team Purple',
  'Bright Salmon', 'Blue Jean', 'Blue Spruce', 'Burnt Orange',
  'Candy Pink', 'Chili', 'Faded Blue',
  'Hemp', 'Jean', 'Lagoon Blue',
  'Midnight', 'Neon Blue', 'Old Gold',
  'Periwinkle', 'Pigment Black', 'Red Orange', 'Sage',
  'Smoke', 'Vineyard', 'Coral Silk',
  'Navy', 'Green', 'Blue', 'Pink', 'Gray', 'Grey',
]
const STYLES: [string, string][] = [
  ['Long Sleeve', 'Long Sleeve'], ['V-Neck', 'V-Neck'], ['V Neck', 'V-Neck'],
  ['Vneck', 'V-Neck'], ['Crop Top', 'Crop Top'], ['Crop Tee', 'Crop Top'],
  ['Tank Top', 'Tank Top'], ['Tank', 'Tank Top'], ['Muscle Tee', 'Muscle Tee'],
  ['Raglan', 'Raglan'], ['Pullover Hoodie', 'Pullover Hoodie'],
  ['Zip-Up Hoodie', 'Zip-Up Hoodie'], ['Zip Hoodie', 'Zip-Up Hoodie'],
  ['Hoodie', 'Pullover Hoodie'], ['Crewneck Sweatshirt', 'Crewneck Sweatshirt'],
  ['Crewneck', 'Crewneck Sweatshirt'], ['Sweatshirt', 'Crewneck Sweatshirt'],
  ['Comfort Colors', 'Comfort Colors / Short Sleeve'],
  ['T-Shirt', 'Short Sleeve'], ['Tee', 'Short Sleeve'],
]

// SKU color code → color name mapping
const SKU_COLOR_CODES: Record<string, string> = {
  WH: 'White', WHT: 'White', WT: 'White',
  BK: 'Black', BLK: 'Black',
  NV: 'Navy', NVY: 'Navy',
  RD: 'Red',
  BL: 'Blue', BLU: 'Blue',
  GR: 'Green', GRN: 'Green',
  GY: 'Gray', GRY: 'Gray', GREY: 'Grey',
  PK: 'Pink', PNK: 'Pink',
  PU: 'Purple', PUR: 'Purple',
  OR: 'Orange', ORG: 'Orange',
  YL: 'Yellow', YLW: 'Yellow',
  BR: 'Brown', BRN: 'Brown',
  TL: 'Teal',
  CR: 'Coral',
  MN: 'Maroon', MRN: 'Maroon',
  BG: 'Burgundy',
  RS: 'Rust',
  MOS: 'Moss',
  OLV: 'Olive', OL: 'Olive',
  PPR: 'Pepper',
  SND: 'Sandstone',
  GRN8: 'Granite', GRNT: 'Granite',
  ESP: 'Espresso',
  SFM: 'Seafoam',
  BTR: 'Butter',
  SAG: 'Sage',
  IVY: 'Ivory', IV: 'Ivory',
  CRM: 'Cream',
  KHK: 'Khaki', KH: 'Khaki',
  LAV: 'Lavender',
  PCH: 'Peach',
  AQ: 'Aqua',
  GLD: 'Gold',
  TAN: 'Tan',
  SMK: 'Smoke',
  MID: 'Midnight',
  VIN: 'Vineyard',
  HMP: 'Hemp',
  YAM: 'Yam',
  LAG: 'Lagoon',
  BLS: 'Blue Spruce',
  BLO: 'Blossom',
  BRY: 'Berry',
  CIT: 'Citrus',
  CRI: 'Crimson',
  GPH: 'Graphite',
  SPH: 'Sapphire',
  TRC: 'Terracotta',
  WTR: 'Watermelon',
  BJN: 'Blue Jean',

  FBL: 'Flo Blue',
  IRF: 'Island Reef',
  ORC: 'Orchid',
  PRW: 'Periwinkle',
  PBK: 'Pigment Black',
  CSK: 'Coral Silk',
  CMT: 'Chalky Mint',
  CRB: 'Crunchberry',
  BSL: 'Bright Salmon',
  BOR: 'Burnt Orange',
  CPK: 'Candy Pink',
  CHL: 'Chili',
  FDB: 'Faded Blue',
  OGD: 'Old Gold',
  ROR: 'Red Orange',
  BAY: 'Bay',
  BLJN: 'Blue Jean',
  MUS: 'Mustard', MSTD: 'Mustard',
  IVO: 'Ivory',
  VIO: 'Violet',
  VOLT: 'Volt',
  LTG: 'Light Green',
  LTGN: 'Light Green',
  SC: 'Soft Cream',
  SA: 'Sand',
  CHM: 'Chambray',
  BJ: 'Blue Jean',

  // Additional short codes found in live orders
  CS: 'Coral Silk',
  WTM: 'Watermelon', WTML: 'Watermelon',
  TQ: 'Turquoise',
  BLJ: 'Blue Jean',
  DN: 'Denim',
  LIL: 'Lilac',
  PP: 'Pepper',
  SH: 'Sapphire',
  TP: 'Team Purple',
}

// SKU size code → size name mapping
const SKU_SIZE_CODES: Record<string, string> = {
  XS: 'X-Small', '2XS': 'XX-Small',
  S: 'Small', SM: 'Small',
  M: 'Medium', MD: 'Medium', MED: 'Medium',
  L: 'Large', LG: 'Large',
  XL: 'X-Large',
  '2XL': '2X-Large', XXL: '2X-Large',
  '3XL': '3X-Large', XXXL: '3X-Large',
  '4XL': '4X-Large', '5XL': '5X-Large', '6XL': '6X-Large',
}

// Words that should NOT be treated as colors in fallback parsing
const NON_COLOR_WORDS = new Set([
  'regular', 'slim', 'relaxed', 'fitted', 'classic', 'standard', 'unisex',
  'alpha', 'numeric', 'us', 'uk', 'eu', 'men', 'women', 'adult', 'youth',
  'graphic', 'vintage', 'retro', 'modern', 'apparel', 'shirt', 'tee',
])

/**
 * Extract color, size, and style codes from SKU segments.
 * SKU formats:
 *   BTFFTW64000XL-WH           → color=White
 *   TCEO-Later-Gator-LS-L-MOS  → style=Long Sleeve, size=Large, color=Moss
 *   640002XL-WH-Soccer-Cup-TS-Germany → color=White
 */
function parseSkuCodes(sku: string): { color?: string; size?: string; style?: string } {
  if (!sku) return {}
  const result: { color?: string; size?: string; style?: string } = {}

  // Split SKU into segments by hyphens
  const segments = sku.split('-').map(s => s.trim()).filter(Boolean)

  for (const seg of segments) {
    const upper = seg.toUpperCase()

    // Check for Long Sleeve indicator
    if (upper === 'LS') {
      result.style = 'Long Sleeve'
      continue
    }
    // Check for Short Sleeve indicator
    if (upper === 'SS') {
      result.style = 'Short Sleeve'
      continue
    }

    // Check color codes (exact match on uppercase) — keep FIRST match only
    if (!result.color && SKU_COLOR_CODES[upper]) {
      result.color = SKU_COLOR_CODES[upper]
      continue
    }

    // Check size codes (exact match on uppercase)
    if (SKU_SIZE_CODES[upper]) {
      result.size = SKU_SIZE_CODES[upper]
      continue
    }
  }

  // Also check the last 2-3 chars of the last segment for color codes
  // e.g., "BTFFTW64000XL-WH" → last segment is "WH"
  // Already handled above since segments split by "-"

  // Check for embedded size suffix in first segment like "64000XL" or "BC30012XL"
  // Match size suffix directly — no greedy \d+ prefix that would eat digits from style numbers
  if (!result.size) {
    const firstSeg = segments[0] || ''
    const sizeMatch = firstSeg.match(/(6XL|5XL|4XL|3XL|2XL|XXL|XXXL|XL|XS)$/i)
    if (sizeMatch) {
      const sizeCode = sizeMatch[1].toUpperCase()
      result.size = SKU_SIZE_CODES[sizeCode] || sizeCode
    }
  }

  return result
}

function parseAttrs(title: string, sku: string, aiDetectedColor?: string | null) {
  const t = title || ''

  // ── 1. Parse SKU codes FIRST (most reliable per-variant source) ──
  const skuData = parseSkuCodes(sku)

  // ── 2. Parse from title as fallback ──
  let size = skuData.size || SIZES.find(s => t.toLowerCase().includes(s.toLowerCase())) || ''

  // ── Color priority: SKU code > AI-detected > title match > segment fallback ──
  let color = ''

  // Layer 1: SKU color code (most reliable — seller-assigned per-variant)
  if (skuData.color) {
    color = skuData.color
  }

  // Layer 2: AI-detected color (good when SKU has no color code)
  if (!color && aiDetectedColor) {
    color = aiDetectedColor
  }

  // Layer 3: Known color name in title
  if (!color) {
    color = COLORS.find(c => {
      const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      return re.test(t)
    }) || ''
  }

  // Layer 4: Fallback — extract color from title segments
  if (!color) {
    const segments = t.split(/\s*[-–—,]\s*/).map(s => s.trim()).filter(Boolean)
    if (segments.length >= 2) {
      for (let i = segments.length - 1; i >= Math.max(0, segments.length - 3); i--) {
        const seg = segments[i]
        if (SIZES.some(s => s.toLowerCase() === seg.toLowerCase())) continue
        if (seg.split(/\s+/).length > 3) continue
        if (NON_COLOR_WORDS.has(seg.toLowerCase())) continue
        if (seg.split(/\s+/).length > 2) continue
        if (seg.length > 1 && seg.length < 30) {
          color = seg
          break
        }
      }
    }
  }

  if (!color) color = '—'
  if (!size) size = '—'

  // ── 4. Style detection with smart Comfort Colors + Long Sleeve combo ──
  let style = '—'
  const titleLower = t.toLowerCase()
  const hasComfortColors = titleLower.includes('comfort colors')
  const hasLongSleeve = titleLower.includes('long sleeve') || skuData.style === 'Long Sleeve'

  if (hasComfortColors && hasLongSleeve) {
    style = 'Comfort Colors / Long Sleeve'
  } else if (hasLongSleeve) {
    style = 'Long Sleeve'
  } else {
    for (const [keyword, label] of STYLES) {
      if (titleLower.includes(keyword.toLowerCase())) { style = label; break }
    }
  }

  // ── 5. Variant extraction from SKU (e.g., "TS-Germany" → "Germany") ──
  let variant = ''
  if (sku) {
    const tsMatch = sku.match(/TS-([A-Za-z]+)$/i)
    if (tsMatch) {
      const v = tsMatch[1]
      const skipValues = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XS', 'CS']
      if (!skipValues.includes(v.toUpperCase())) {
        variant = v
      }
    }
  }

  return { size, color, style, variant }
}

/**
 * Extract a design key from a SKU for image sharing.
 * Items with the same design key are the same product in different sizes,
 * so they should share the same image.
 */
function extractDesignKey(sku: string): string {
  if (!sku) return ''
  let key = sku.replace(/\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)/gi, '')
  const sizeTokens = new Set(['XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','LS','SS'])
  const parts = key.split('-').filter(p => !sizeTokens.has(p.toUpperCase()) && p !== '')
  return parts.join('-').toUpperCase()
}

/**
 * Build a map from design key → image_url for SKU-based image sharing.
 * When multiple items share the same design (same product, different sizes),
 * the first item's image is used for all.
 */
function buildDesignImageMap(items: OrderItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    const dk = extractDesignKey(item.sku)
    if (dk && item.image_url && !map.has(dk)) {
      map.set(dk, item.image_url)
    }
  }
  return map
}

function cleanTitle(title: string): string {
  if (!title) return ''
  let t = title
  for (const s of SIZES) {
    t = t.replace(new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '')
  }
  for (const c of COLORS) {
    t = t.replace(new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '')
  }
  t = t.replace(/\s*[-–—,]\s*[-–—,]\s*/g, ' - ')
  t = t.replace(/\s*[-–—,]\s*$/, '')
  t = t.replace(/\s{2,}/g, ' ').trim()
  return t
}

/**
 * Convert an image URL to a base64 data URL to avoid CORS issues with html2canvas.
 */
async function imageToBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    return url // fallback to original URL
  }
}

/**
 * Print the packing slip using an iframe for clean, reliable output.
 */
function handlePrint(orderId: string) {
  const content = document.getElementById('packing-slip-print')
  if (!content) return

  // Set the main document title to the order ID so browser uses it as the Save-as-PDF filename
   const originalTitle = document.title
   document.title = orderId

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.top = '-10000px'
  iframe.style.left = '-10000px'
  iframe.style.width = '8.5in'
  iframe.style.height = '11in'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument || iframe.contentWindow?.document
  if (!doc) { document.body.removeChild(iframe); document.title = originalTitle; return }

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
          margin: 0;
        }
        html, body {
          margin: 0;
          padding: 0;
          background: white;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        body {
          padding: 0.4in;
        }
        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        img {
          max-width: 100%;
        }
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
        .review-card {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .slip-footer {
          break-inside: avoid;
          page-break-inside: avoid;
        }
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
      setTimeout(resolve, 5000)
    })
  })

  Promise.all(imagePromises).then(() => {
    setTimeout(() => {
      iframe.contentWindow?.print()
      // Restore original title and clean up
      setTimeout(() => {
        document.title = originalTitle
        document.body.removeChild(iframe)
      }, 1000)
    }, 500)
  })
}

interface PackingSlipModalProps {
  order: Order
  orders?: Order[]
  onClose: () => void
  onNavigate?: (order: Order) => void
}

export default function PackingSlipModal({ order, orders = [], onClose, onNavigate }: PackingSlipModalProps) {
  const [mounted, setMounted] = useState(false)
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({})

  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

  // Build design-key → image map for SKU-based image sharing
  const designImageMap = buildDesignImageMap(items)

  // Pre-fetch all product images as base64 on mount to avoid CORS issues
  useEffect(() => {
    setMounted(true)
    document.body.style.overflow = 'hidden'

    // Convert all product images to base64 (including shared design images)
    const fetchImages = async () => {
      const urls: Record<string, string> = {}
      const allImageUrls = new Set<string>()
      for (const item of items) {
        if (item.image_url) allImageUrls.add(item.image_url)
      }
      // Also include design-shared images
      for (const url of designImageMap.values()) {
        allImageUrls.add(url)
      }
      for (const url of allImageUrls) {
        urls[url] = await imageToBase64(url)
      }
      setImageDataUrls(urls)
    }
    fetchImages()

    return () => { document.body.style.overflow = '' }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shipTo = order.ship_to as ShipTo | null
  const visibleItems = items.filter(i => i.qty > 0)
  const totalQty = visibleItems.reduce((s, i) => s + i.qty, 0)

  const shipBy = order.raw_data &&
    typeof order.raw_data === 'object' &&
    !Array.isArray(order.raw_data) &&
    'LatestShipDate' in order.raw_data
    ? formatDateShort(String((order.raw_data as Record<string, unknown>).LatestShipDate))
    : null

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
            {/* Navigation Arrows */}
            {orders.length > 1 && onNavigate && (() => {
              const currentIndex = orders.findIndex(o => o.id === order.id)
              const hasPrev = currentIndex > 0
              const hasNext = currentIndex < orders.length - 1
              return (
                <div className="flex flex-col gap-0.5 border border-gray-200 rounded-lg p-1">
                  <button
                    onClick={() => hasPrev && onNavigate(orders[currentIndex - 1])}
                    disabled={!hasPrev}
                    className="p-0.5 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Previous order"
                  >
                    <ChevronUp size={16} className="text-gray-600" />
                  </button>
                  <button
                    onClick={() => hasNext && onNavigate(orders[currentIndex + 1])}
                    disabled={!hasNext}
                    className="p-0.5 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Next order"
                  >
                    <ChevronDown size={16} className="text-gray-600" />
                  </button>
                </div>
              )
            })()}
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
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-[135px]">Image</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide">Product</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide w-36">Size / Color / Style</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleItems.map((item, index) => {
                    const attrs = parseAttrs(item.title, item.sku, item.ai_detected_color)
                    const title = cleanTitle(item.title)
                    // Use pre-fetched base64 image if available.
                    // SKU-based image sharing: if this item's design key matches
                     // another item, always use the first matching item's image.
                     // This fixes cases where Amazon returns wrong images for size variants.
                     const dk = extractDesignKey(item.sku)
                     const sharedImage = dk ? designImageMap.get(dk) : undefined
                     const effectiveImageUrl = sharedImage || item.image_url || null
                    const imgSrc = effectiveImageUrl
                      ? (imageDataUrls[effectiveImageUrl] || effectiveImageUrl)
                      : null
                    return (
                      <tr key={`${item.asin}-${index}`} className={index % 2 === 1 ? 'bg-gray-50' : 'bg-white'}>
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#2E9CE6] text-white text-xs font-bold">
                            {item.qty}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {imgSrc ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={imgSrc}
                              alt={item.title}
                              className="w-[115px] h-[115px] object-contain rounded bg-white"
                              crossOrigin="anonymous"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            />
                          ) : (
                            <div className="w-[115px] h-[115px] bg-gray-100 rounded flex items-center justify-center">
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
                            {item.customization && item.customization.surfaces && item.customization.surfaces.length > 0 && (
                              <div className="mt-1.5 pt-1.5 border-t border-dashed border-orange-300">
                                <p className="text-[10px] font-bold text-orange-600 uppercase tracking-wide mb-0.5">Customization</p>
                                {item.customization.surfaces.map((surface, si) => (
                                  <div key={si}>
                                    {item.customization!.surfaces.length > 1 && (
                                      <p className="text-[10px] text-orange-500 font-semibold">{surface.label}</p>
                                    )}
                                    {Object.entries(surface.options).map(([key, value]) => (
                                      <p key={key} className="text-xs">
                                        <span className="text-orange-400 uppercase text-[10px]">{key}: </span>
                                        <span className="font-semibold text-gray-900">{value}</span>
                                      </p>
                                    ))}
                                  </div>
                                ))}
                              </div>
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
