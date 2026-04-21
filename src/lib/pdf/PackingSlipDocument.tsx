'use client'

import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
} from '@react-pdf/renderer'
import type { Order, OrderItem, ShipTo } from '@/types/database'
import { formatDateShort } from '@/lib/utils'

// Brand colors
const BRAND_BLUE = '#2E9CE6'
const BRAND_DARK = '#1F1F1F'
const BRAND_GRAY = '#6B7280'
const BRAND_LIGHT = '#F9FAFB'
const BRAND_BORDER = '#E5E7EB'
const BRAND_RED = '#DC2626'
const REVIEW_BG = '#EFF8FF'
const STAR_GOLD = '#F59E0B'

// ─── Dynamic attribute parser ─────────────────────────────────────────────────

const SIZES = [
  'XX-Small', 'X-Small', 'Extra Small',
  '6X-Large', '5X-Large', '4X-Large', '3X-Large', '2X-Large', 'X-Large', 'Extra Large',
  '6XL', '5XL', '4XL', '3XL', '2XL', 'XXL', 'XXXL', 'XL',
  'Small', 'Medium', 'Large',
  'S/M', 'M/L', 'L/XL',
  'Plus Size', 'One Size',
]

const COLORS = [
  'Light Green', 'Dark Green', 'Forest Green', 'Sage Green', 'Mint Green',
  'Light Blue', 'Dark Blue', 'Navy Blue', 'Royal Blue', 'Sky Blue', 'Baby Blue', 'True Navy',
  'Light Pink', 'Dark Pink', 'Hot Pink', 'Dusty Pink', 'Blush Pink',
  'Light Grey', 'Dark Grey', 'Heather Grey', 'Dark Heather',
  'Light Gray', 'Dark Gray', 'Heather Gray',
  'Off White', 'Cream', 'Ivory', 'Natural',
  'Washed Denim', 'Denim', 'Chambray',
  'Black', 'White', 'Red', 'Orange', 'Yellow', 'Purple', 'Lavender', 'Violet',
  'Maroon', 'Burgundy', 'Wine', 'Rust', 'Mustard', 'Gold', 'Tan', 'Brown',
  'Teal', 'Aqua', 'Coral', 'Peach', 'Espresso', 'Seafoam', 'Butter',
  'Granite', 'Sandstone', 'Brick', 'Moss', 'Olive', 'Pepper',
  'Crunchberry', 'Yam', 'Lagoon', 'Blossom', 'Chalky Mint', 'Flo Blue',
  'Island Reef', 'Orchid', 'Berry', 'Citrus', 'Crimson', 'Graphite',
  'Ice Blue', 'Khaki', 'Neon Pink', 'Neon Green', 'Neon Orange',
  'Sapphire', 'Terracotta', 'Watermelon',
  'Bright Salmon', 'Blue Jean', 'Blue Spruce', 'Burnt Orange',
  'Candy Pink', 'Chili', 'Faded Blue', 'Hemp', 'Jean',
  'Lagoon Blue', 'Midnight', 'Neon Blue', 'Old Gold',
  'Periwinkle', 'Pigment Black', 'Red Orange', 'Sage',
  'Smoke', 'Vineyard', 'Coral Silk',
  'Navy', 'Green', 'Blue', 'Pink', 'Gray', 'Grey',
]

const STYLES: [string, string][] = [
  ['Long Sleeve', 'Long Sleeve'],
  ['V-Neck', 'V-Neck'],
  ['V Neck', 'V-Neck'],
  ['Vneck', 'V-Neck'],
  ['Crop Top', 'Crop Top'],
  ['Crop Tee', 'Crop Top'],
  ['Tank Top', 'Tank Top'],
  ['Tank', 'Tank Top'],
  ['Muscle Tee', 'Muscle Tee'],
  ['Raglan', 'Raglan'],
  ['Pullover Hoodie', 'Pullover Hoodie'],
  ['Zip-Up Hoodie', 'Zip-Up Hoodie'],
  ['Zip Hoodie', 'Zip-Up Hoodie'],
  ['Hoodie', 'Pullover Hoodie'],
  ['Crewneck Sweatshirt', 'Crewneck Sweatshirt'],
  ['Crewneck', 'Crewneck Sweatshirt'],
  ['Sweatshirt', 'Crewneck Sweatshirt'],
  ['Comfort Colors', 'Comfort Colors / Short Sleeve'],
  ['T-Shirt', 'Short Sleeve'],
  ['Tee', 'Short Sleeve'],
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
  BLS: 'Blossom',
  BRY: 'Berry',
  CIT: 'Citrus',
  CRI: 'Crimson',
  GPH: 'Graphite',
  SPH: 'Sapphire',
  TRC: 'Terracotta',
  WTR: 'Watermelon',
  BJN: 'Blue Jean',
  BSP: 'Blue Spruce',
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

interface ProductAttributes {
  size: string | null
  color: string | null
  style: string | null
  variant: string | null
}

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

  const segments = sku.split('-').map(s => s.trim()).filter(Boolean)

  for (const seg of segments) {
    const upper = seg.toUpperCase()

    if (upper === 'LS') { result.style = 'Long Sleeve'; continue }
    if (upper === 'SS') { result.style = 'Short Sleeve'; continue }
    if (SKU_COLOR_CODES[upper]) { result.color = SKU_COLOR_CODES[upper]; continue }
    if (SKU_SIZE_CODES[upper]) { result.size = SKU_SIZE_CODES[upper]; continue }
  }

  // Check for embedded size in first segment like "64000XL" or "640002XL"
  if (!result.size) {
    const firstSeg = segments[0] || ''
    const sizeMatch = firstSeg.match(/(\d+)(6XL|5XL|4XL|3XL|2XL|XXL|XXXL|XL|XS|S|M|L)$/i)
    if (sizeMatch) {
      const sizeCode = sizeMatch[2].toUpperCase()
      result.size = SKU_SIZE_CODES[sizeCode] || sizeCode
    }
  }

  return result
}

/**
 * Extract the variant/team/country from the SKU.
 */
function extractVariantFromSku(sku: string): string | null {
  if (!sku) return null
  const tsMatch = sku.match(/TS-([A-Za-z]+)$/i)
  if (tsMatch) return tsMatch[1]
  return null
}

function parseProductAttributes(title: string, sku?: string): ProductAttributes {
  const result: ProductAttributes = { size: null, color: null, style: null, variant: null }

  // ── 1. Parse SKU codes FIRST (most reliable per-variant source) ──
  const skuData = parseSkuCodes(sku || '')

  // ── 2. Use SKU values, fall back to title parsing ──
  if (skuData.size) {
    result.size = skuData.size
  } else {
    for (const size of SIZES) {
      const escaped = size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i')
      if (re.test(title)) { result.size = size; break }
    }
    if (!result.size) {
      const singleMatch = title.match(/\b(XS|[SMLX])\b/)
      if (singleMatch) result.size = singleMatch[1].toUpperCase()
    }
  }

  if (skuData.color) {
    result.color = skuData.color
  } else {
    const sortedColors = [...COLORS].sort((a, b) => b.length - a.length)
    for (const color of sortedColors) {
      const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i')
      if (re.test(title)) { result.color = color; break }
    }
  }

  // ── 4. Fallback: extract color from title trailing segments ──
  if (!result.color) {
    const segments = title.split(/\s*[-\u2013]\s*/).map(s => s.trim()).filter(Boolean)
    if (segments.length >= 3 && result.size) {
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].toLowerCase() === result.size.toLowerCase() && i > 0) {
          const candidate = segments[i - 1]
          if (candidate.split(/\s+/).length <= 3 && candidate.length <= 30) {
            // Skip non-color words
            if (!NON_COLOR_WORDS.has(candidate.toLowerCase())) {
              result.color = candidate
            }
          }
          break
        }
      }
    }
  }

  // ── 5. Style detection with smart Comfort Colors + Long Sleeve combo ──
  const titleLower = title.toLowerCase()
  const hasComfortColors = titleLower.includes('comfort colors')
  const hasLongSleeve = titleLower.includes('long sleeve') || skuData.style === 'Long Sleeve'

  if (hasComfortColors && hasLongSleeve) {
    result.style = 'Comfort Colors / Long Sleeve'
  } else if (hasLongSleeve) {
    result.style = 'Long Sleeve'
  } else {
    for (const [keyword, label] of STYLES) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i')
      if (re.test(title)) { result.style = label; break }
    }
  }
  if (!result.style) result.style = 'Short Sleeve'

  // ── 6. Extract variant (team/country) from SKU ──
  if (sku) {
    result.variant = extractVariantFromSku(sku)
  }

  return result
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: BRAND_DARK,
    backgroundColor: '#FFFFFF',
    paddingTop: 22,
    paddingBottom: 38,
    paddingHorizontal: 28,
  },

  // ── Header: logos row ──
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: BRAND_BLUE,
  },
  ceoLogo: {
    width: 56,
    height: 56,
    objectFit: 'contain',
  },
  headerConnector: {
    fontSize: 10,
    color: BRAND_GRAY,
    marginHorizontal: 10,
  },
  amazonLogo: {
    width: 76,
    height: 23,
    objectFit: 'contain',
  },

  // Info boxes row
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 8,
  },
  infoBox: {
    flex: 1,
    backgroundColor: BRAND_LIGHT,
    borderRadius: 3,
    padding: 7,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
  },
  infoLabel: {
    fontSize: 6,
    color: BRAND_GRAY,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  infoValue: {
    fontSize: 9,
    color: BRAND_DARK,
    fontFamily: 'Helvetica-Bold',
  },
  infoValueRed: {
    fontSize: 9,
    color: BRAND_RED,
    fontFamily: 'Helvetica-Bold',
  },
  infoValueSmall: {
    fontSize: 8,
    color: BRAND_DARK,
    lineHeight: 1.5,
  },
  infoValueGray: {
    fontSize: 7,
    color: BRAND_GRAY,
    marginTop: 2,
  },

  // Table
  tableTitle: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_DARK,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  table: {
    borderWidth: 1,
    borderColor: BRAND_BORDER,
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 10,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: BRAND_BLUE,
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableHeaderCell: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: '#FFFFFF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderTopColor: BRAND_BORDER,
    alignItems: 'center',
    minHeight: 114,
  },
  tableRowAlt: {
    backgroundColor: BRAND_LIGHT,
  },

  // Column widths
  colQty: { width: 22 },
  colImage: { width: 118 },
  colTitle: { flex: 1, paddingHorizontal: 7 },
  colAttrs: { width: 128 },

  // Qty badge
  qtyBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: BRAND_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyText: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#FFFFFF',
  },

  // Product image
  productImage: {
    width: 108,
    height: 108,
    objectFit: 'contain',
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  noImage: {
    width: 108,
    height: 108,
    backgroundColor: BRAND_LIGHT,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noImageText: {
    fontSize: 6,
    color: BRAND_GRAY,
    textAlign: 'center',
  },

  // Product details
  productTitle: {
    fontSize: 8,
    color: BRAND_DARK,
    lineHeight: 1.4,
    marginBottom: 3,
  },
  productSku: {
    fontSize: 7,
    color: BRAND_GRAY,
    marginTop: 2,
  },

  // Attribute rows
  attrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  attrLabel: {
    fontSize: 6,
    color: BRAND_GRAY,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    width: 32,
  },
  attrValue: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_DARK,
    flex: 1,
  },

  // ── Review / Thank You section ──
  reviewBox: {
    flexDirection: 'row',
    backgroundColor: REVIEW_BG,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: BRAND_BLUE,
    overflow: 'hidden',
    marginBottom: 10,
    minHeight: 110,
  },
  reviewBar: {
    width: 56,
    backgroundColor: BRAND_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  reviewBarText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 1.5,
  },
  reviewBarStar: {
    fontSize: 12,
    color: STAR_GOLD,
    textAlign: 'center',
    marginTop: 4,
  },
  reviewContent: {
    flex: 1,
    padding: 10,
  },
  reviewHeading: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_BLUE,
    marginBottom: 1,
  },
  reviewSubheading: {
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_BLUE,
    marginBottom: 5,
  },
  reviewStarsRow: {
    flexDirection: 'row',
    marginBottom: 5,
  },
  reviewStar: {
    fontSize: 14,
    color: STAR_GOLD,
    marginRight: 2,
  },
  reviewStepLabel: {
    fontSize: 7,
    color: BRAND_DARK,
    marginBottom: 3,
    fontFamily: 'Helvetica-Bold',
  },
  reviewStep: {
    fontSize: 7,
    color: BRAND_DARK,
    marginBottom: 2,
    paddingLeft: 4,
  },
  reviewFootnote: {
    fontSize: 6.5,
    color: BRAND_GRAY,
    marginTop: 4,
    fontStyle: 'italic',
  },
  reviewQrCol: {
    width: 90,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  qrImage: {
    width: 62,
    height: 62,
    marginBottom: 4,
  },
  qrCaption: {
    fontSize: 6,
    color: BRAND_DARK,
    textAlign: 'center',
    lineHeight: 1.4,
  },
  qrCaptionBold: {
    fontSize: 6,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_DARK,
    textAlign: 'center',
  },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 14,
    left: 28,
    right: 28,
    borderTopWidth: 1,
    borderTopColor: BRAND_BORDER,
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerText: {
    fontSize: 7,
    color: BRAND_GRAY,
  },
  footerBrand: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_BLUE,
  },
})

// ─── SKU-based image sharing ──────────────────────────────────────────────────

/**
 * Extract a design key from a SKU for image sharing.
 * Items with the same design key are the same product in different sizes.
 */
function extractDesignKey(sku: string): string {
  if (!sku) return ''
  let key = sku.replace(/\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)/gi, '')
  const sizeTokens = new Set(['XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','LS','SS'])
  const parts = key.split('-').filter(p => !sizeTokens.has(p.toUpperCase()) && p !== '')
  return parts.join('-').toUpperCase()
}

function buildDesignImageMap(items: OrderItem[]): Map<string, { url: string; asin: string }> {
  const map = new Map<string, { url: string; asin: string }>()
  for (const item of items) {
    const dk = extractDesignKey(item.sku)
    if (dk && item.image_url && !map.has(dk)) {
      map.set(dk, { url: item.image_url, asin: item.asin })
    }
  }
  return map
}

// ─── Component ────────────────────────────────────────────────────────────────

interface PackingSlipDocumentProps {
  order: Order
  logoBase64?: string
  amazonLogoBase64?: string
  qrCodeBase64?: string
  productImagesBase64?: Record<string, string>
}

export default function PackingSlipDocument({
  order,
  logoBase64,
  amazonLogoBase64,
  qrCodeBase64,
  productImagesBase64,
}: PackingSlipDocumentProps) {
  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

  // Build design-key → image map for SKU-based image sharing
  const designImageMap = buildDesignImageMap(items)

  const shipTo = order.ship_to as ShipTo | null

  const formatAddress = (addr: ShipTo | null): string => {
    if (!addr) return 'Address not available'
    const parts = [
      addr.addressLine1,
      addr.addressLine2,
      `${addr.city}, ${addr.stateOrRegion} ${addr.postalCode}`,
      addr.countryCode !== 'US' ? addr.countryCode : null,
    ].filter(Boolean)
    return parts.join('\n')
  }

  const logoSrc = logoBase64
    ? `data:image/png;base64,${logoBase64}`
    : '/theceo_logo_registered.png'

  const amazonLogoSrc = amazonLogoBase64
    ? `data:image/png;base64,${amazonLogoBase64}`
    : '/amazon_logo.png'

  const qrSrc = qrCodeBase64
    ? `data:image/png;base64,${qrCodeBase64}`
    : '/qr_code.png'

  const cleanTitle = (title: string): string => {
    let t = title
    for (let i = 0; i < 2; i++) {
      t = t.replace(/\s*[-–]\s*[A-Z][a-zA-Z\s]+$/, '').trim()
    }
    return t.replace(/\s*[-–]\s*$/, '').trim()
  }

  const totalQty = items.reduce((s, i) => s + i.qty, 0)

  return (
    <Document
      title={`Packing Slip — ${order.id}`}
      author="TheCEO.Store"
      subject="Amazon FBM Packing Slip"
    >
      <Page size="LETTER" style={styles.page}>

        {/* ── Header: CEO® logo | Store is on | Amazon logo ── */}
        <View style={styles.headerRow}>
          <Image src={logoSrc} style={styles.ceoLogo} />
          <Text style={styles.headerConnector}>Store is on</Text>
          <Image src={amazonLogoSrc} style={styles.amazonLogo} />
        </View>

        {/* ── Order Number + Date ── */}
        <View style={styles.infoRow}>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Order Number</Text>
            <Text style={styles.infoValue}>{order.id}</Text>
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Order Date</Text>
            <Text style={styles.infoValue}>{formatDateShort(order.purchase_date)}</Text>
          </View>
        </View>

        {/* ── Ship To + Ship By ── */}
        <View style={styles.infoRow}>
          <View style={[styles.infoBox, { flex: 2 }]}>
            <Text style={styles.infoLabel}>Ship To</Text>
            <Text style={[styles.infoValueSmall, { fontFamily: 'Helvetica-Bold' }]}>
              {shipTo?.name || order.buyer_name || 'Customer'}
            </Text>
            <Text style={styles.infoValueSmall}>{formatAddress(shipTo)}</Text>
            {shipTo?.phone && (
              <Text style={styles.infoValueGray}>{shipTo.phone}</Text>
            )}
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Ship By</Text>
            <Text style={styles.infoValueRed}>
              {order.raw_data && typeof order.raw_data === 'object' && !Array.isArray(order.raw_data) && 'LatestShipDate' in order.raw_data
                ? formatDateShort(String((order.raw_data as Record<string, unknown>).LatestShipDate))
                : '—'}
            </Text>
            <Text style={[styles.infoLabel, { marginTop: 7 }]}>Total Items</Text>
            <Text style={styles.infoValue}>
              {totalQty} unit{totalQty !== 1 ? 's' : ''}
            </Text>
          </View>
        </View>

        {/* ── Items Table ── */}
        <Text style={styles.tableTitle}>Order Items</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, styles.colImage]}>Image</Text>
            <Text style={[styles.tableHeaderCell, styles.colTitle]}>Product</Text>
            <Text style={[styles.tableHeaderCell, styles.colAttrs]}>Size / Color / Style</Text>
          </View>

          {items.map((item, index) => {
            const attrs = parseProductAttributes(item.title, item.sku)
            const title = cleanTitle(item.title)

            return (
              <View
                key={`${item.asin}-${index}`}
                style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : {}]}
              >
                <View style={[styles.colQty, { alignItems: 'center' }]}>
                  <View style={styles.qtyBadge}>
                    <Text style={styles.qtyText}>{item.qty}</Text>
                  </View>
                </View>

                <View style={styles.colImage}>
                  {(() => {
                    // SKU-based image sharing: always use the first matching item's image.
                     // This fixes cases where Amazon returns wrong images for size variants.
                     const dk = extractDesignKey(item.sku)
                     const shared = dk ? designImageMap.get(dk) : undefined
                     const effectiveImageUrl = shared?.url || item.image_url || null
                     const effectiveAsin = shared?.asin || item.asin
                    const b64 = productImagesBase64?.[effectiveAsin]
                    const imgSrc = b64
                      ? `data:image/jpeg;base64,${b64}`
                      : effectiveImageUrl
                    return imgSrc ? (
                      <Image src={imgSrc} style={styles.productImage} />
                    ) : (
                      <View style={styles.noImage}>
                        <Text style={styles.noImageText}>No{'\n'}Image</Text>
                      </View>
                    )
                  })()}
                </View>

                <View style={styles.colTitle}>
                  <Text style={styles.productTitle}>
                    {title.length > 100 ? title.substring(0, 97) + '...' : title}
                  </Text>
                  <Text style={styles.productSku}>SKU: {item.sku || '—'}</Text>
                </View>

                <View style={styles.colAttrs}>
                  <View style={styles.attrRow}>
                    <Text style={styles.attrLabel}>Size:</Text>
                    <Text style={styles.attrValue}>{attrs.size || '—'}</Text>
                  </View>
                  <View style={styles.attrRow}>
                    <Text style={styles.attrLabel}>Color:</Text>
                    <Text style={styles.attrValue}>{attrs.color || '—'}</Text>
                  </View>
                  <View style={styles.attrRow}>
                    <Text style={styles.attrLabel}>Style:</Text>
                    <Text style={styles.attrValue}>{attrs.style || '—'}</Text>
                  </View>
                  {attrs.variant && (
                    <View style={styles.attrRow}>
                      <Text style={styles.attrLabel}>Team:</Text>
                      <Text style={styles.attrValue}>{attrs.variant}</Text>
                    </View>
                  )}
                </View>
              </View>
            )
          })}
        </View>

        {/* ── Review / Thank You section ── */}
        <View style={styles.reviewBox}>
          {/* Blue left bar */}
          <View style={styles.reviewBar}>
            <Text style={styles.reviewBarText}>{'thank you\nfor your\norder!'}</Text>
            <Text style={styles.reviewBarStar}>{'★\n★\n★\n★'}</Text>
          </View>

          {/* Main content */}
          <View style={styles.reviewContent}>
            <Text style={styles.reviewHeading}>FEEDBACK ON OUR AMAZON PRODUCT &amp; SERVICE</Text>
            <Text style={styles.reviewSubheading}>WOULD MEAN THE WORLD TO US!</Text>
            <View style={styles.reviewStarsRow}>
              {['★', '★', '★', '★', '★'].map((s, i) => (
                <Text key={i} style={styles.reviewStar}>{s}</Text>
              ))}
            </View>
            <Text style={styles.reviewStepLabel}>How to leave a review:</Text>
            <Text style={styles.reviewStep}>1  Go to &apos;Your Orders&apos;</Text>
            <Text style={styles.reviewStep}>2  Select the product and tap &apos;Write a Review.&apos;</Text>
            <Text style={styles.reviewStep}>3  Share your honest feedback to help others!</Text>
            <Text style={styles.reviewFootnote}>
              Your support helps us continue to bring you great products!
            </Text>
          </View>

          {/* QR code column */}
          <View style={styles.reviewQrCol}>
            <Image src={qrSrc} style={styles.qrImage} />
            <Text style={styles.qrCaptionBold}>{"What's on the other side of this"}</Text>
            <Text style={styles.qrCaption}>{'QR code will Change. Your. LIFE!*'}</Text>
            <Text style={styles.qrCaption}>{'*okay, that\'s a little dramatic'}</Text>
            <Text style={styles.qrCaption}>{'but just scan it already.'}</Text>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Generated: {new Date().toLocaleDateString('en-US')}
          </Text>
          <Text style={styles.footerBrand}>TheCEO.Store</Text>
          <Text style={styles.footerText}>Order: {order.id}</Text>
        </View>

      </Page>
    </Document>
  )
}
