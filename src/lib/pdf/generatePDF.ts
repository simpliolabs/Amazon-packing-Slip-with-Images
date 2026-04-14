import type { Order } from '@/types/database'

/**
 * Generate and download a single packing slip PDF
 */
export async function generateSinglePDF(order: Order): Promise<void> {
  const { pdf } = await import('@react-pdf/renderer')
  const { default: PackingSlipDocument } = await import('./PackingSlipDocument')
  const React = await import('react')

  const blob = await pdf(
    React.createElement(PackingSlipDocument, { order }) as any
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

  const zip = new JSZip()
  const folder = zip.folder('packing-slips')

  if (!folder) throw new Error('Failed to create ZIP folder')

  // Generate PDFs in parallel (with concurrency limit)
  const CONCURRENCY = 3
  for (let i = 0; i < orders.length; i += CONCURRENCY) {
    const batch = orders.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (order) => {
        const blob = await pdf(
          React.createElement(PackingSlipDocument, { order }) as any
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
