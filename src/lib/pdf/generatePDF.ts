import type { Order, OrderItem } from '@/types/database'

/**
 * Fetch an image from a URL and convert to base64 string.
 * Includes a timeout to prevent hanging on slow CDN responses.
 */
async function imageToBase64(url: string, timeoutMs = 10000): Promise<string | undefined> {
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
 * Pre-fetch all unique product images from one or more orders as base64.
 * Returns a map of ASIN → base64 string.
 */
async function prefetchAllProductImages(orders: Order[]): Promise<Record<string, string>> {
  const uniqueImages = new Map<string, string>()
  for (const order of orders) {
    const items: OrderItem[] = Array.isArray(order.order_items)
      ? (order.order_items as unknown as OrderItem[])
      : []
    for (const item of items) {
      if (item.image_url && item.asin && !uniqueImages.has(item.asin)) {
        uniqueImages.set(item.asin, item.image_url)
      }
    }
  }

  // Fetch in batches of 5 to avoid overwhelming the browser
  const entries = Array.from(uniqueImages.entries())
  const map: Record<string, string> = {}
  const batchSize = 5
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async ([asin, url]) => {
        const b64 = await imageToBase64(url, 10000)
        return [asin, b64] as [string, string | undefined]
      })
    )
    for (const [asin, b64] of results) {
      if (b64) map[asin] = b64
    }
  }
  return map
}

/**
 * Helper: wrap a promise with a timeout. Rejects if the promise doesn't
 * resolve within the given milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/**
 * Generate and download a single packing slip PDF
 */
export async function generateSinglePDF(order: Order): Promise<void> {
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
    prefetchAllProductImages([order]),
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
 * Generate a single combined PDF containing all orders (one per page).
 * Used for both bulk download and bulk print.
 * Accepts an optional progress callback: (phase, detail) => void
 */
export async function generateCombinedPDF(
  orders: Order[],
  onProgress?: (phase: string, detail?: string) => void,
): Promise<Blob> {
  onProgress?.('loading', 'Loading PDF engine…')

  const [
    { pdf },
    { default: PackingSlipDocument },
    React,
  ] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./PackingSlipDocument'),
    import('react'),
  ])

  onProgress?.('images', `Fetching images for ${orders.length} orders…`)

  // Pre-fetch logos + all product images in parallel
  const [logoBase64, amazonLogoBase64, qrCodeBase64, productImagesBase64] = await Promise.all([
    imageToBase64('/theceo_logo_registered.png'),
    imageToBase64('/amazon_logo.png'),
    imageToBase64('/qr_code.png'),
    prefetchAllProductImages(orders),
  ])

  onProgress?.('rendering', `Rendering ${orders.length} packing slips…`)

  // Render each order as a separate PDF blob, then merge with pdf-lib.
  // Each render has a 30-second timeout to prevent hanging.
  const pdfBlobs: Blob[] = []
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i]
    onProgress?.('rendering', `Rendering slip ${i + 1} of ${orders.length}…`)
    try {
      const element = React.createElement(PackingSlipDocument, {
        order,
        logoBase64,
        amazonLogoBase64,
        qrCodeBase64,
        productImagesBase64,
      } as any) as any

      // Wrap pdf().toBlob() with a 30s timeout per order to prevent infinite hangs
      const blob = await withTimeout(
        pdf(element).toBlob(),
        30000,
        `PDF render for order ${order.id}`,
      )
      pdfBlobs.push(blob)
    } catch (err) {
      console.error(`Failed to render PDF for order ${order.id}:`, err)
      // Skip failed orders and continue with the rest
    }
  }

  if (pdfBlobs.length === 0) {
    throw new Error('No PDFs were generated successfully')
  }

  // If only one order, return it directly
  if (pdfBlobs.length === 1) {
    return pdfBlobs[0]
  }

  onProgress?.('merging', `Merging ${pdfBlobs.length} PDFs…`)

  // Merge all PDFs into one using pdf-lib
  const { PDFDocument } = await import('pdf-lib')
  const mergedPdf = await PDFDocument.create()

  for (const blob of pdfBlobs) {
    try {
      const arrayBuffer = await blob.arrayBuffer()
      const pdfDoc = await PDFDocument.load(arrayBuffer)
      const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices())
      for (const page of pages) {
        mergedPdf.addPage(page)
      }
    } catch (err) {
      console.error('Failed to merge a PDF page:', err)
    }
  }

  const mergedBytes = await mergedPdf.save()
  return new Blob([mergedBytes.buffer as ArrayBuffer], { type: 'application/pdf' })
}

/**
 * Generate and download multiple packing slips as a single combined PDF.
 */
export async function generateBulkPDF(
  orders: Order[],
  onProgress?: (phase: string, detail?: string) => void,
): Promise<void> {
  const blob = await generateCombinedPDF(orders, onProgress)

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `packing-slips-${new Date().toISOString().split('T')[0]}.pdf`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Generate a combined PDF and open it in a new window for printing.
 */
export async function generateBulkPrint(
  orders: Order[],
  onProgress?: (phase: string, detail?: string) => void,
): Promise<void> {
  const blob = await generateCombinedPDF(orders, onProgress)

  const url = URL.createObjectURL(blob)
  const printWindow = window.open(url, '_blank')
  if (printWindow) {
    printWindow.addEventListener('load', () => {
      printWindow.print()
    })
  }
}
