import type { Order, OrderItem } from '@/types/database'

/**
 * Fetch an image from a URL and convert to base64 string.
 * Includes a timeout to prevent hanging on slow CDN responses.
 */
async function imageToBase64(url: string, timeoutMs = 8000): Promise<string | undefined> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return undefined
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  } catch {
    return undefined
  }
}

/**
 * Pre-fetch all unique product images from an order as base64.
 * Returns a map of ASIN → base64 string.
 */
async function prefetchProductImages(order: Order): Promise<Record<string, string>> {
  const items: OrderItem[] = Array.isArray(order.order_items)
    ? (order.order_items as unknown as OrderItem[])
    : []

  // Deduplicate by ASIN
  const uniqueImages = new Map<string, string>()
  for (const item of items) {
    if (item.image_url && item.asin && !uniqueImages.has(item.asin)) {
      uniqueImages.set(item.asin, item.image_url)
    }
  }

  // Fetch all in parallel with timeout
  const entries = Array.from(uniqueImages.entries())
  const results = await Promise.all(
    entries.map(async ([asin, url]) => {
      const b64 = await imageToBase64(url, 8000)
      return [asin, b64] as [string, string | undefined]
    })
  )

  const map: Record<string, string> = {}
  for (const [asin, b64] of results) {
    if (b64) map[asin] = b64
  }
  return map
}

/**
 * Generate and download a single packing slip PDF
 */
export async function generateSinglePDF(order: Order): Promise<void> {
  // Start all fetches in parallel: logos + product images
  const [
    { pdf },
    { default: PackingSlipDocument },
    React,
    logoBase64,
    amazonLogoBase64,
    qrCodeBase64,
    productImagesBase64,
  ] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./PackingSlipDocument'),
    import('react'),
    imageToBase64('/theceo_logo_registered.png'),
    imageToBase64('/amazon_logo.png'),
    imageToBase64('/qr_code.png'),
    prefetchProductImages(order),
  ])

  const blob = await pdf(
    React.createElement(PackingSlipDocument, {
      order,
      logoBase64,
      amazonLogoBase64,
      qrCodeBase64,
      productImagesBase64,
    } as any) as any
  ).toBlob()

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `packing-slip-${order.id}.pdf`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Generate and download multiple packing slips as a ZIP file
 */
export async function generateBulkPDF(orders: Order[]): Promise<void> {
  const { pdf } = await import('@react-pdf/renderer')
  const { default: PackingSlipDocument } = await import('./PackingSlipDocument')
  const JSZip = (await import('jszip')).default
  const React = await import('react')

  // Load logos once for all PDFs
  const [logoBase64, amazonLogoBase64, qrCodeBase64] = await Promise.all([
    imageToBase64('/theceo_logo_registered.png'),
    imageToBase64('/amazon_logo.png'),
    imageToBase64('/qr_code.png'),
  ])

  // Pre-fetch ALL product images across all orders in parallel
  const allImageMaps = await Promise.all(orders.map(prefetchProductImages))

  const zip = new JSZip()
  const folder = zip.folder('packing-slips')

  if (!folder) throw new Error('Failed to create ZIP folder')

  // Generate PDFs in parallel (with concurrency limit)
  const CONCURRENCY = 3
  for (let i = 0; i < orders.length; i += CONCURRENCY) {
    const batch = orders.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (order, batchIdx) => {
        const productImagesBase64 = allImageMaps[i + batchIdx]
        const blob = await pdf(
          React.createElement(PackingSlipDocument, {
            order,
            logoBase64,
            amazonLogoBase64,
            qrCodeBase64,
            productImagesBase64,
          } as any) as any
        ).toBlob()
        const arrayBuffer = await blob.arrayBuffer()
        folder.file(`packing-slip-${order.id}.pdf`, arrayBuffer)
      })
    )
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(zipBlob)
  const link = document.createElement('a')
  link.href = url
  link.download = `packing-slips-${new Date().toISOString().split('T')[0]}.zip`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
