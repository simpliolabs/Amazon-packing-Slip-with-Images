/**
 * ApiUsageMeter.tsx
 * Shows Jungle Scout API call budget: X / cap calls used this month, plus a SYSTEM WARNING as usage
 * approaches the cap (PO 2026-06-15) — the cap pauses research 50 calls before the plan's $0.05/call
 * overage, so we surface a heads-up at 80%, a stronger warning at 90%, and a paused notice at 100%.
 * Pure display component — receives stats (incl. the precomputed warningLevel/message) as props.
 */

interface Props {
  used: number
  limit: number
  provider: string
  warningLevel?: 'ok' | 'approaching' | 'critical' | 'paused'
  warningMessage?: string
}

export function ApiUsageMeter({ used, limit, provider, warningLevel = 'ok', warningMessage }: Props) {
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const barColor =
    pct >= 90 ? 'bg-red-500'
    : pct >= 70 ? 'bg-amber-500'
    : 'bg-green-500'
  const showWarn = warningLevel !== 'ok' && !!warningMessage
  const warnColor = warningLevel === 'approaching' ? 'text-amber-700' : 'text-red-700'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="font-medium text-gray-700">{provider} API:</span>
        <div className="w-24 bg-gray-200 rounded-full h-1.5">
          <div className={`h-1.5 rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <span>{used.toLocaleString()} / {limit.toLocaleString()} calls</span>
      </div>
      {showWarn && (
        <div className={`text-[11px] font-medium ${warnColor} flex items-start gap-1 max-w-xs`}>
          <span aria-hidden>{warningLevel === 'paused' ? '🛑' : '⚠️'}</span>
          <span>{warningMessage}</span>
        </div>
      )}
    </div>
  )
}
