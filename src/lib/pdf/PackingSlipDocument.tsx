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

// ─── Dynamic attribute parser ─────────────────────────────────────────────────

const SIZES = [
  'XX-Small', 'X-Small', 'Extra Small',
  '6X-Large', '5X-Large', '4X-Large', '3X-Large', '2X-Large', 'X-Large', 'Extra Large',
  '6XL', '5XL', '4XL', '3XL', '2XL', 'XXL', 'XXXL', 'XL',
  'Small', 'Medium', 'Large',
  'S/M', 'M/L', 'L/XL',
  'Plus Size', 'One Size',
  // Single-letter sizes matched carefully below
]

const COLORS = [
  'Light Green', 'Dark Green', 'Forest Green', 'Sage Green', 'Mint Green',
  'Light Blue', 'Dark Blue', 'Navy Blue', 'Royal Blue', 'Sky Blue', 'Baby Blue', 'True Navy',
  'Light Pink', 'Dark Pink', 'Hot Pink', 'Dusty Pink', 'Blush Pink',
  'Light Grey', 'Dark Grey', 'Heather Grey', 'Dark Heather',
  'Light Gray', 'Dark Gray', 'Heather Gray',
  'Off White', 'Cream', 'Ivory', 'Natural',
  'Washed Denim', 'Denim', 'Chambray',
  'Black', 'White', 'Red', 'Orange', 'Yellow', 'Purple', 'Lavender',
  'Maroon', 'Burgundy', 'Wine', 'Rust', 'Mustard', 'Gold', 'Tan', 'Brown',
  'Teal', 'Aqua', 'Coral', 'Peach', 'Espresso', 'Seafoam', 'Butter',
  'Granite', 'Sandstone', 'Brick', 'Moss', 'Olive', 'Pepper',
  'Navy', 'Green', 'Blue', 'Pink', 'Gray', 'Grey',
]

const STYLES: [string, string][] = [
  ['Comfort Colors', 'Comfort Colors / Short Sleeve'],
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
  ['T-Shirt', 'Short Sleeve'],
  ['Tee', 'Short Sleeve'],
]

interface ProductAttributes {
  size: string | null
  color: string | null
  style: string | null
}

function parseProductAttributes(title: string): ProductAttributes {
  const result: ProductAttributes = { size: null, color: null, style: null }

  // Size — check multi-word first, then single-letter with word boundaries
  for (const size of SIZES) {
    const escaped = size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i')
    if (re.test(title)) {
      result.size = size
      break
    }
  }
  // Fallback: single-letter sizes XS, S, M, L
  if (!result.size) {
    const singleMatch = title.match(/\b(XS|[SMLX])\b/)
    if (singleMatch) result.size = singleMatch[1].toUpperCase()
  }

  // Color — longest match first
  const sortedColors = [...COLORS].sort((a, b) => b.length - a.length)
  for (const color of sortedColors) {
    const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i')
    if (re.test(title)) {
      result.color = color
      break
    }
  }

  // Style
  for (const [keyword, label] of STYLES) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'i')
    if (re.test(title)) {
      result.style = label
      break
    }
  }
  if (!result.style) result.style = 'Short Sleeve'

  return result
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: BRAND_DARK,
    backgroundColor: '#FFFFFF',
    paddingTop: 28,
    paddingBottom: 38,
    paddingHorizontal: 32,
  },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: 18,
    paddingBottom: 14,
    borderBottomWidth: 2,
    borderBottomColor: BRAND_BLUE,
  },
  logo: {
    width: 150,
    height: 68,
    objectFit: 'contain',
    marginBottom: 5,
  },
  headerSubtitle: {
    fontSize: 7,
    color: BRAND_GRAY,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Info boxes row
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 10,
  },
  infoBox: {
    flex: 1,
    backgroundColor: BRAND_LIGHT,
    borderRadius: 3,
    padding: 8,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
  },
  infoLabel: {
    fontSize: 6,
    color: BRAND_GRAY,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
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
    marginBottom: 5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  table: {
    borderWidth: 1,
    borderColor: BRAND_BORDER,
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 14,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: BRAND_BLUE,
    paddingVertical: 6,
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
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderTopColor: BRAND_BORDER,
    alignItems: 'center',
    minHeight: 70,
  },
  tableRowAlt: {
    backgroundColor: BRAND_LIGHT,
  },

  // Column widths
  colQty: { width: 24 },
  colImage: { width: 72 },   // 50% bigger than original 48
  colTitle: { flex: 1, paddingHorizontal: 8 },
  colAttrs: { width: 130 },  // Size / Color / Style

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
    width: 64,
    height: 64,
    objectFit: 'contain',
    borderRadius: 3,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
    backgroundColor: '#FFFFFF',
  },
  noImage: {
    width: 64,
    height: 64,
    backgroundColor: BRAND_LIGHT,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
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
    marginBottom: 5,
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

  // Footer
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 32,
    right: 32,
    borderTopWidth: 1,
    borderTopColor: BRAND_BORDER,
    paddingTop: 8,
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
  thankYou: {
    textAlign: 'center',
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_DARK,
    marginBottom: 4,
  },
  thankYouSub: {
    textAlign: 'center',
    fontSize: 8,
    color: BRAND_GRAY,
    marginBottom: 16,
  },
})

// ─── Component ────────────────────────────────────────────────────────────────

interface PackingSlipDocumentProps {
  order: Order
  logoBase64?: string
}

export default function PackingSlipDocument({
  order,
  logoBase64,
}: PackingSlipDocumentProps) {
  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

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
    : '/logo.png'

  // Clean product title — strip trailing " - Color - Size" suffixes
  const cleanTitle = (title: string): string => {
    let t = title
    // Remove up to 2 trailing " - Attribute" segments
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
      <Page size="A4" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <Image src={logoSrc} style={styles.logo} />
          <Text style={styles.headerSubtitle}>Packing Slip</Text>
        </View>

        {/* ── Order Number + Date (no Status) ── */}
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
              ? formatDateShort(String(order.raw_data.LatestShipDate))
              : '—'}
            </Text>
            <Text style={[styles.infoLabel, { marginTop: 8 }]}>Total Items</Text>
            <Text style={styles.infoValue}>
              {totalQty} unit{totalQty !== 1 ? 's' : ''}
            </Text>
          </View>
        </View>

        {/* ── Items Table ── */}
        <Text style={styles.tableTitle}>Order Items</Text>
        <View style={styles.table}>
          {/* Header */}
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, styles.colImage]}>Image</Text>
            <Text style={[styles.tableHeaderCell, styles.colTitle]}>Product</Text>
            <Text style={[styles.tableHeaderCell, styles.colAttrs]}>Size / Color / Style</Text>
          </View>

          {/* Rows */}
          {items.map((item, index) => {
            const attrs = parseProductAttributes(item.title)
            const title = cleanTitle(item.title)

            return (
              <View
                key={`${item.asin}-${index}`}
                style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : {}]}
              >
                {/* Qty badge */}
                <View style={[styles.colQty, { alignItems: 'center' }]}>
                  <View style={styles.qtyBadge}>
                    <Text style={styles.qtyText}>{item.qty}</Text>
                  </View>
                </View>

                {/* Product image (50% bigger) */}
                <View style={styles.colImage}>
                  {item.image_url ? (
                    <Image src={item.image_url} style={styles.productImage} />
                  ) : (
                    <View style={styles.noImage}>
                      <Text style={styles.noImageText}>No{'\n'}Image</Text>
                    </View>
                  )}
                </View>

                {/* Title + SKU */}
                <View style={styles.colTitle}>
                  <Text style={styles.productTitle}>
                    {title.length > 100 ? title.substring(0, 97) + '...' : title}
                  </Text>
                  <Text style={styles.productSku}>SKU: {item.sku || '—'}</Text>
                </View>

                {/* Size / Color / Style */}
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
                </View>
              </View>
            )
          })}
        </View>

        {/* ── Thank You ── */}
        <Text style={styles.thankYou}>Thank you for your order!</Text>
        <Text style={styles.thankYouSub}>
          Questions? Contact us at orders@theceo.store
        </Text>

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
