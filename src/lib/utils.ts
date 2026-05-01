import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDateShort(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Format a ship-by date from Amazon's UTC timestamp to the seller's timezone.
 * Amazon's LatestShipDate is always in UTC (e.g., 2026-05-02T06:59:59Z means
 * May 1, 11:59 PM PDT). We convert to America/Los_Angeles to match what
 * Seller Central displays.
 */
export function formatShipDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  })
}

export function getStatusColor(status: string): string {
  const statusMap: Record<string, string> = {
    Unshipped: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    PartiallyShipped: 'bg-blue-100 text-blue-800 border-blue-200',
    Shipped: 'bg-green-100 text-green-800 border-green-200',
    Canceled: 'bg-red-100 text-red-800 border-red-200',
    Pending: 'bg-gray-100 text-gray-800 border-gray-200',
    PendingAvailability: 'bg-orange-100 text-orange-800 border-orange-200',
    InvoiceUnconfirmed: 'bg-purple-100 text-purple-800 border-purple-200',
    Unfulfillable: 'bg-red-100 text-red-800 border-red-200',
  }
  return statusMap[status] || 'bg-gray-100 text-gray-800 border-gray-200'
}

export function getTotalItems(orderItems: Array<{ qty: number }>): number {
  return orderItems.reduce((sum, item) => sum + item.qty, 0)
}
