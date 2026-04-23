import type { Order, OrderItem, ShipTo } from '@/types/database'

// ─── Image cache: logos and QR are loaded once and reused across all slips ───
const imageCache: Record<string, string> = {}

async function loadImageAsBase64(url: string, timeoutMs = 8000): Promise<string> {
  if (imageCache[url]) return imageCache[url]
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return url
    const blob = await res.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    imageCache[url] = dataUrl
    return dataUrl
  } catch {
    return url
  }
}

// ─── Attribute parsing (same logic as PackingSlipModal) ─────────────────────

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
  'Ice Blue', 'Khaki', 'Neon Pink', 'Neon Green', 'Neon Orange',
  'Sapphire', 'Terracotta', 'Watermelon',
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
  ICB: 'Ice Blue',
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
}

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

const NON_COLOR_WORDS = new Set([
  'regular', 'slim', 'relaxed', 'fitted', 'classic', 'standard', 'unisex',
  'alpha', 'numeric', 'us', 'uk', 'eu', 'men', 'women', 'adult', 'youth',
  'graphic', 'vintage', 'retro', 'modern', 'apparel', 'shirt', 'tee',
])

function parseSkuCodes(sku: string): { color?: string; size?: string; style?: string } {
  if (!sku) return {}
  const result: { color?: string; size?: string; style?: string } = {}
  const segments = sku.split('-').map(s => s.trim()).filter(Boolean)
  for (const seg of segments) {
    const upper = seg.toUpperCase()
    if (upper === 'LS') { result.style = 'Long Sleeve'; continue }
    if (upper === 'SS') { result.style = 'Short Sleeve'; continue }
    if (SKU_COLOR_CODES[upper]) { result.color = SKU_COLOR_CODES[upper]; continue }
    if (SKU_SIZE_CODES[upper]) { result.size = SKU_SIZE_CODES[upper]; continue }
  }
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
  // Parse SKU codes FIRST (most reliable per-variant source)
  const skuData = parseSkuCodes(sku)
  let size = skuData.size || SIZES.find(s => t.toLowerCase().includes(s.toLowerCase())) || ''
  let color = skuData.color || COLORS.find(c => {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return re.test(t)
  }) || ''
  if (!color) {
    const segments = t.split(/\s*[-–—,]\s*/).map(s => s.trim()).filter(Boolean)
    if (segments.length >= 2) {
      for (let i = segments.length - 1; i >= Math.max(0, segments.length - 3); i--) {
        const seg = segments[i]
        if (SIZES.some(s => s.toLowerCase() === seg.toLowerCase())) continue
        if (seg.split(/\s+/).length > 3) continue
        if (NON_COLOR_WORDS.has(seg.toLowerCase())) continue
        if (seg.split(/\s+/).length > 2) continue
        if (seg.length > 1 && seg.length < 30) { color = seg; break }
      }
    }
  }
  // AI-detected color fallback (Layer 2)
  if (!color && aiDetectedColor) { color = aiDetectedColor }
  if (!color) color = '—'
  if (!size) size = '—'
  let style = '—'
  const titleLower = t.toLowerCase()
  const hasComfortColors = titleLower.includes('comfort colors')
  const hasLongSleeve = titleLower.includes('long sleeve') || skuData.style === 'Long Sleeve'
  if (hasComfortColors && hasLongSleeve) style = 'Comfort Colors / Long Sleeve'
  else if (hasLongSleeve) style = 'Long Sleeve'
  else {
    for (const [keyword, label] of STYLES) {
      if (titleLower.includes(keyword.toLowerCase())) { style = label; break }
    }
  }
  let variant = ''
  if (sku) {
    const tsMatch = sku.match(/TS-([A-Za-z]+)$/i)
    if (tsMatch) {
      const v = tsMatch[1]
      const skipValues = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XS', 'CS']
      if (!skipValues.includes(v.toUpperCase())) variant = v
    }
  }
  return { size, color, style, variant }
}

function extractDesignKey(sku: string): string {
  if (!sku) return ''
  let key = sku.replace(/\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)/gi, '')
  const sizeTokens = new Set(['XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','LS','SS'])
  const parts = key.split('-').filter(p => !sizeTokens.has(p.toUpperCase()) && p !== '')
  return parts.join('-').toUpperCase()
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

function formatDateShort(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function formatDateFull(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Build one slip as an HTML string ───────────────────────────────────────

function buildSlipHTML(
  order: Order,
  logos: { ceo: string; amazon: string; qr: string },
  productImages: Record<string, string>,
): string {
  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

  // Design-key image sharing
  const designMap = new Map<string, string>()
  for (const item of items) {
    const dk = extractDesignKey(item.sku)
    if (dk && item.image_url && !designMap.has(dk)) designMap.set(dk, item.image_url)
  }

  const shipTo = order.ship_to as ShipTo | null
  const totalQty = items.reduce((s, i) => s + i.qty, 0)
  const shipBy = order.raw_data &&
    typeof order.raw_data === 'object' &&
    !Array.isArray(order.raw_data) &&
    'LatestShipDate' in order.raw_data
    ? formatDateShort(String((order.raw_data as Record<string, unknown>).LatestShipDate))
    : null

  const itemRows = items.map((item, index) => {
    const attrs = parseAttrs(item.title, item.sku, item.ai_detected_color)
    const title = cleanTitle(item.title)
    const dk = extractDesignKey(item.sku)
    const sharedImage = dk ? designMap.get(dk) : undefined
    const effectiveUrl = sharedImage || item.image_url || null
    const imgSrc = effectiveUrl ? (productImages[effectiveUrl] || effectiveUrl) : null
    const displayTitle = title.length > 100 ? title.substring(0, 97) + '...' : title

    return `
      <tr style="background:${index % 2 === 1 ? '#f9fafb' : '#fff'}">
        <td style="padding:10px 12px;vertical-align:top">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#2E9CE6;color:#fff;font-size:12px;font-weight:700">${item.qty}</span>
        </td>
        <td style="padding:10px 12px;vertical-align:top">
          ${imgSrc
            ? `<img src="${escapeHtml(imgSrc)}" alt="" style="width:115px;height:115px;object-fit:contain;border-radius:4px;background:#fff" />`
            : `<div style="width:115px;height:115px;background:#f3f4f6;border-radius:4px;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;color:#9ca3af">No Image</span></div>`
          }
        </td>
        <td style="padding:10px 12px;vertical-align:top">
          <p style="font-weight:500;color:#111827;font-size:12px;line-height:1.5;margin:0 0 4px 0">${escapeHtml(displayTitle)}</p>
          <p style="font-size:11px;color:#9ca3af;font-family:monospace;margin:0">SKU: ${escapeHtml(item.sku || '—')}</p>
        </td>
        <td style="padding:10px 12px;vertical-align:top">
          <p style="font-size:11px;margin:0 0 2px 0"><span style="color:#9ca3af;text-transform:uppercase;font-size:10px">Size: </span><span style="font-weight:600;color:#111827">${escapeHtml(attrs.size)}</span></p>
          <p style="font-size:11px;margin:0 0 2px 0"><span style="color:#9ca3af;text-transform:uppercase;font-size:10px">Color: </span><span style="font-weight:600;color:#111827">${escapeHtml(attrs.color)}</span></p>
          <p style="font-size:11px;margin:0 0 2px 0"><span style="color:#9ca3af;text-transform:uppercase;font-size:10px">Style: </span><span style="font-weight:600;color:#111827">${escapeHtml(attrs.style)}</span></p>
          ${attrs.variant ? `<p style="font-size:11px;margin:0"><span style="color:#9ca3af;text-transform:uppercase;font-size:10px">Team: </span><span style="font-weight:600;color:#111827">${escapeHtml(attrs.variant)}</span></p>` : ''}
        </td>
      </tr>`
  }).join('')

  return `
    <div class="slip-page">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid #2E9CE6">
        <img src="${escapeHtml(logos.ceo)}" alt="" style="height:56px;width:56px;object-fit:contain" />
        <span style="font-size:13px;color:#6b7280;font-weight:500">Store is on</span>
        <img src="${escapeHtml(logos.amazon)}" alt="" style="height:28px;object-fit:contain" />
      </div>

      <!-- Order Info -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;border:1px solid #e5e7eb">
          <p style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0">Order Number</p>
          <p style="font-size:13px;font-weight:700;font-family:monospace;color:#111827;margin:0;word-break:break-all">${escapeHtml(order.id)}</p>
        </div>
        <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;border:1px solid #e5e7eb">
          <p style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0">Order Date</p>
          <p style="font-size:13px;font-weight:700;color:#111827;margin:0">${formatDateShort(order.purchase_date)}</p>
        </div>
      </div>

      <!-- Ship To + Ship By -->
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:14px">
        <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;border:1px solid #e5e7eb">
          <p style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0">Ship To</p>
          <p style="font-weight:700;color:#111827;font-size:13px;margin:0">${escapeHtml(shipTo?.name || order.buyer_name || 'Customer')}</p>
          ${shipTo ? `
            <div style="font-size:11px;color:#374151;margin-top:4px;line-height:1.5">
              <p style="margin:0">${escapeHtml(shipTo.addressLine1 || '')}</p>
              ${shipTo.addressLine2 ? `<p style="margin:0">${escapeHtml(shipTo.addressLine2)}</p>` : ''}
              <p style="margin:0">${escapeHtml(shipTo.city || '')}, ${escapeHtml(shipTo.stateOrRegion || '')} ${escapeHtml(shipTo.postalCode || '')}</p>
            </div>
          ` : ''}
        </div>
        <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;border:1px solid #e5e7eb">
          <p style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0">Ship By</p>
          <p style="font-size:13px;font-weight:700;color:#dc2626;margin:0">${shipBy || '—'}</p>
          <p style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:8px 0 4px 0">Total Items</p>
          <p style="font-size:13px;font-weight:700;color:#111827;margin:0">${totalQty} unit${totalQty !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <!-- Items Table -->
      <p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px 0">Order Items</p>
      <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:14px">
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <thead>
            <tr style="background:#2E9CE6;color:#fff">
              <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:40px">Qty</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:135px">Image</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Product</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:144px">Size / Color / Style</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>
      </div>

      <!-- Review Card -->
      <div style="display:flex;border-radius:8px;border:1px solid #2E9CE6;overflow:hidden;background:#EFF8FF;break-inside:avoid">
        <div style="width:64px;background:#2E9CE6;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 8px;flex-shrink:0">
          <p style="color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:1.3;margin:0 0 10px 0">thank you<br>for your<br>order!</p>
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
            <span style="color:#facc15;font-size:14px">★</span>
            <span style="color:#facc15;font-size:14px">★</span>
            <span style="color:#facc15;font-size:14px">★</span>
            <span style="color:#facc15;font-size:14px">★</span>
          </div>
        </div>
        <div style="flex:1;padding:14px">
          <p style="font-size:11px;font-weight:700;color:#2E9CE6;margin:0 0 2px 0">FEEDBACK ON OUR AMAZON PRODUCT &amp; SERVICE</p>
          <p style="font-size:11px;font-weight:700;color:#2E9CE6;margin:0 0 8px 0">WOULD MEAN THE WORLD TO US!</p>
          <div style="display:flex;gap:2px;margin-bottom:8px">
            <span style="color:#facc15;font-size:18px">★</span>
            <span style="color:#facc15;font-size:18px">★</span>
            <span style="color:#facc15;font-size:18px">★</span>
            <span style="color:#facc15;font-size:18px">★</span>
            <span style="color:#facc15;font-size:18px">★</span>
          </div>
          <p style="font-size:11px;font-weight:600;color:#374151;margin:0 0 4px 0">How to leave a review:</p>
          <p style="font-size:11px;color:#374151;margin:0 0 2px 0">1  Go to 'Your Orders'</p>
          <p style="font-size:11px;color:#374151;margin:0 0 2px 0">2  Select the product and tap 'Write a Review.'</p>
          <p style="font-size:11px;color:#374151;margin:0 0 8px 0">3  Share your honest feedback to help others!</p>
          <p style="font-size:11px;color:#9ca3af;font-style:italic;margin:0">Your support helps us continue to bring you great products!</p>
        </div>
        <div style="width:112px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px;flex-shrink:0">
          <img src="${escapeHtml(logos.qr)}" alt="QR" style="width:80px;height:80px;margin-bottom:8px" />
          <p style="font-size:10px;font-weight:700;color:#1f2937;text-align:center;line-height:1.3;margin:0">What's on the other side of this</p>
          <p style="font-size:10px;color:#374151;text-align:center;line-height:1.3;margin:0">QR code will Change. Your. LIFE!*</p>
          <p style="font-size:10px;color:#6b7280;text-align:center;line-height:1.3;margin:0">*okay, that's a little dramatic but just scan it already.</p>
        </div>
      </div>

      <!-- Footer -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding-top:10px;border-top:1px solid #f3f4f6;margin-top:10px">
        <span style="font-size:11px;color:#9ca3af">Generated: ${formatDateFull(new Date().toISOString())}</span>
        <span style="font-size:11px;font-weight:700;color:#2E9CE6">TheCEO.Store</span>
        <span style="font-size:11px;color:#9ca3af;font-family:monospace">${escapeHtml(order.id)}</span>
      </div>
    </div>`
}

// ─── Main export: HTML-based bulk print ─────────────────────────────────────

export async function generateBulkPrintHTML(
  orders: Order[],
  onProgress?: (phase: string, detail?: string) => void,
): Promise<void> {
  onProgress?.('images', 'Loading images…')

  // 1. Pre-load shared assets (logos, QR) — cached after first call
  const [ceoLogo, amazonLogo, qrCode] = await Promise.all([
    loadImageAsBase64('/theceo_logo_registered.png'),
    loadImageAsBase64('/amazon_logo.png'),
    loadImageAsBase64('/qr_code.png'),
  ])
  const logos = { ceo: ceoLogo, amazon: amazonLogo, qr: qrCode }

  // 2. Pre-load all unique product images in parallel (batches of 8)
  onProgress?.('images', `Loading product images for ${orders.length} orders…`)
  const uniqueUrls = new Set<string>()
  for (const order of orders) {
    const items: OrderItem[] = Array.isArray(order.order_items)
      ? (order.order_items as unknown as OrderItem[])
      : []
    for (const item of items) {
      if (item.image_url) uniqueUrls.add(item.image_url)
    }
  }

  const productImages: Record<string, string> = {}
  const urlArray = Array.from(uniqueUrls)
  const batchSize = 8
  for (let i = 0; i < urlArray.length; i += batchSize) {
    const batch = urlArray.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (url) => {
        const b64 = await loadImageAsBase64(url)
        return [url, b64] as [string, string]
      })
    )
    for (const [url, b64] of results) {
      productImages[url] = b64
    }
    onProgress?.('images', `Loaded ${Math.min(i + batchSize, urlArray.length)} of ${urlArray.length} images…`)
  }

  // 3. Build all slip HTML
  onProgress?.('rendering', `Building ${orders.length} packing slips…`)
  const slipHTMLs = orders.map((order) => buildSlipHTML(order, logos, productImages))

  // 4. Open print iframe
  onProgress?.('printing', 'Opening print dialog…')

  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.top = '-10000px'
  iframe.style.left = '-10000px'
  iframe.style.width = '8.5in'
  iframe.style.height = '11in'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument || iframe.contentWindow?.document
  if (!doc) {
    document.body.removeChild(iframe)
    throw new Error('Failed to create print frame')
  }

  const originalTitle = document.title
  document.title = ' '

  doc.open()
  doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>packing-slips</title>
  <style>
    @page {
      size: letter portrait;
      margin: 0;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .slip-page {
      padding: 0.4in;
      page-break-after: always;
    }
    .slip-page:last-child {
      page-break-after: auto;
    }
    img {
      max-width: 100%;
    }
    table {
      border-collapse: collapse;
    }
    tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
  </style>
</head>
<body>
  ${slipHTMLs.join('\n')}
</body>
</html>`)
  doc.close()

  // 5. Wait for all images to load, then print
  const images = Array.from(doc.querySelectorAll('img'))
  const imagePromises = images.map(img => {
    if (img.complete) return Promise.resolve()
    return new Promise<void>((resolve) => {
      img.onload = () => resolve()
      img.onerror = () => resolve()
      setTimeout(resolve, 5000)
    })
  })

  await Promise.all(imagePromises)

  // Small delay for rendering
  await new Promise(resolve => setTimeout(resolve, 300))

  iframe.contentWindow?.print()

  // Cleanup after print dialog closes
  setTimeout(() => {
    document.title = originalTitle
    document.body.removeChild(iframe)
  }, 2000)
}
