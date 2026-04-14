'use client'

import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
  Font,
} from '@react-pdf/renderer'
import type { Order, OrderItem, ShipTo } from '@/types/database'
import { formatDateShort } from '@/lib/utils'

// Brand colors
const BRAND_BLUE = '#2E9CE6'
const BRAND_DARK = '#1F1F1F'
const BRAND_GRAY = '#6B7280'
const BRAND_LIGHT = '#F9FAFB'
const BRAND_BORDER = '#E5E7EB'

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: BRAND_DARK,
    backgroundColor: '#FFFFFF',
    paddingTop: 30,
    paddingBottom: 40,
    paddingHorizontal: 36,
  },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: BRAND_BLUE,
  },
  logo: {
    width: 160,
    height: 72,
    objectFit: 'contain',
    marginBottom: 6,
  },
  headerSubtitle: {
    fontSize: 8,
    color: BRAND_GRAY,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Order info section
  orderInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 12,
  },
  infoBox: {
    flex: 1,
    backgroundColor: BRAND_LIGHT,
    borderRadius: 4,
    padding: 10,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
  },
  infoLabel: {
    fontSize: 7,
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
  infoValueSmall: {
    fontSize: 8,
    color: BRAND_DARK,
    lineHeight: 1.4,
  },

  // Items table
  tableTitle: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_DARK,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  table: {
    borderWidth: 1,
    borderColor: BRAND_BORDER,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 16,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: BRAND_BLUE,
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  tableHeaderCell: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: '#FFFFFF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: BRAND_BORDER,
    alignItems: 'center',
  },
  tableRowAlt: {
    backgroundColor: BRAND_LIGHT,
  },

  // Column widths
  colQty: { width: 28 },
  colImage: { width: 60 },
  colTitle: { flex: 1, paddingHorizontal: 8 },
  colSku: { width: 80 },
  colAsin: { width: 80 },

  // Product image in table
  productImage: {
    width: 52,
    height: 52,
    objectFit: 'contain',
    borderRadius: 3,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
    backgroundColor: '#FFFFFF',
  },
  noImage: {
    width: 52,
    height: 52,
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
    marginBottom: 2,
  },
  productMeta: {
    fontSize: 7,
    color: BRAND_GRAY,
  },

  // Qty badge
  qtyBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: BRAND_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyText: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#FFFFFF',
  },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 36,
    right: 36,
    borderTopWidth: 1,
    borderTopColor: BRAND_BORDER,
    paddingTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerText: {
    fontSize: 8,
    color: BRAND_GRAY,
  },
  footerBrand: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: BRAND_BLUE,
  },
  thankYou: {
    textAlign: 'center',
    fontSize: 10,
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
      addr.countryCode,
    ].filter(Boolean)
    return parts.join('\n')
  }

  const logoSrc = logoBase64
    ? `data:image/png;base64,${logoBase64}`
    : '/logo.png'

  return (
    <Document
      title={`Packing Slip — ${order.id}`}
      author="TheCEO.Store"
      subject="Amazon FBM Packing Slip"
    >
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Image src={logoSrc} style={styles.logo} />
          <Text style={styles.headerSubtitle}>Packing Slip</Text>
        </View>

        {/* Order Info */}
        <View style={styles.orderInfoRow}>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Order Number</Text>
            <Text style={styles.infoValue}>{order.id}</Text>
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Order Date</Text>
            <Text style={styles.infoValue}>
              {formatDateShort(order.purchase_date)}
            </Text>
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={styles.infoValue}>{order.order_status || '—'}</Text>
          </View>
        </View>

        {/* Ship To */}
        <View style={styles.orderInfoRow}>
          <View style={[styles.infoBox, { flex: 2 }]}>
            <Text style={styles.infoLabel}>Ship To</Text>
            <Text style={[styles.infoValueSmall, { fontFamily: 'Helvetica-Bold' }]}>
              {shipTo?.name || order.buyer_name || 'Customer'}
            </Text>
            <Text style={styles.infoValueSmall}>{formatAddress(shipTo)}</Text>
            {shipTo?.phone && (
              <Text style={[styles.infoValueSmall, { color: BRAND_GRAY, marginTop: 2 }]}>
                {shipTo.phone}
              </Text>
            )}
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Total Items</Text>
            <Text style={styles.infoValue}>
              {items.reduce((s, i) => s + i.qty, 0)} unit{items.reduce((s, i) => s + i.qty, 0) !== 1 ? 's' : ''}
            </Text>
            <Text style={[styles.infoLabel, { marginTop: 8 }]}>SKUs</Text>
            <Text style={styles.infoValue}>{items.length}</Text>
          </View>
        </View>

        {/* Items Table */}
        <Text style={styles.tableTitle}>Order Items</Text>
        <View style={styles.table}>
          {/* Table Header */}
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, styles.colImage]}>Image</Text>
            <Text style={[styles.tableHeaderCell, styles.colTitle]}>Product</Text>
            <Text style={[styles.tableHeaderCell, styles.colSku]}>SKU</Text>
            <Text style={[styles.tableHeaderCell, styles.colAsin]}>ASIN</Text>
          </View>

          {/* Table Rows */}
          {items.map((item, index) => (
            <View
              key={`${item.asin}-${index}`}
              style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : {}]}
            >
              {/* Qty */}
              <View style={[styles.colQty, { alignItems: 'center' }]}>
                <View style={styles.qtyBadge}>
                  <Text style={styles.qtyText}>{item.qty}</Text>
                </View>
              </View>

              {/* Product Image */}
              <View style={styles.colImage}>
                {item.image_url ? (
                  <Image
                    src={item.image_url}
                    style={styles.productImage}
                  />
                ) : (
                  <View style={styles.noImage}>
                    <Text style={styles.noImageText}>No{'\n'}Image</Text>
                  </View>
                )}
              </View>

              {/* Title */}
              <View style={styles.colTitle}>
                <Text style={styles.productTitle}>
                  {item.title.length > 120 ? item.title.substring(0, 117) + '...' : item.title}
                </Text>
              </View>

              {/* SKU */}
              <View style={styles.colSku}>
                <Text style={styles.productMeta}>{item.sku || '—'}</Text>
              </View>

              {/* ASIN */}
              <View style={styles.colAsin}>
                <Text style={styles.productMeta}>{item.asin}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Thank You */}
        <Text style={styles.thankYou}>Thank you for your order!</Text>
        <Text style={styles.thankYouSub}>
          Questions? Contact us at orders@theceo.store
        </Text>

        {/* Footer */}
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
