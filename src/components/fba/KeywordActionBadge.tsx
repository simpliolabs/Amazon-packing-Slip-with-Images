/**
 * KeywordActionBadge.tsx
 * Color-coded badge for keyword action types.
 * Pure display component — no state, no side effects.
 */

type ActionType = 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED'

const CONFIG: Record<ActionType, { label: string; classes: string }> = {
  CRITICAL:  { label: 'Critical',  classes: 'bg-red-100 text-red-700 border-red-200' },
  UPGRADE:   { label: 'Upgrade',   classes: 'bg-amber-100 text-amber-700 border-amber-200' },
  REINFORCE: { label: 'Reinforce', classes: 'bg-blue-100 text-blue-700 border-blue-200' },
  DEFENDED:  { label: 'Defended',  classes: 'bg-green-100 text-green-700 border-green-200' },
  OPTIMIZED: { label: 'Optimized', classes: 'bg-gray-100 text-gray-600 border-gray-200' },
}

export function KeywordActionBadge({ type }: { type: ActionType }) {
  const cfg = CONFIG[type] ?? CONFIG.OPTIMIZED
  return (
    <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border ${cfg.classes}`}>
      {cfg.label}
    </span>
  )
}
