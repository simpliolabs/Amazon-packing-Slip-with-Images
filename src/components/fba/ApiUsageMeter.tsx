/**
 * ApiUsageMeter.tsx
 * Shows Jungle Scout API call budget: X / 1,000 calls used this month.
 * Pure display component — receives stats as props.
 */

interface Props {
  used: number
  limit: number
  provider: string
}

export function ApiUsageMeter({ used, limit, provider }: Props) {
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const barColor =
    pct >= 90 ? 'bg-red-500'
    : pct >= 70 ? 'bg-amber-500'
    : 'bg-green-500'

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span className="font-medium text-gray-700">{provider} API:</span>
      <div className="w-24 bg-gray-200 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span>{used.toLocaleString()} / {limit.toLocaleString()} calls</span>
    </div>
  )
}
