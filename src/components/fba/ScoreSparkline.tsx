/**
 * ScoreSparkline.tsx — PHASE C UI (spec §5 Phase C item 1): a 12-point SVG sparkline of
 * overall_score over time. SVG, NOT emoji/canvas (FBA design memory: "SVG not emoji").
 *
 * Fed by GET /api/fba/score-history?listing_key= (oldest→newest points). Pure presentational:
 * the caller fetches + passes the points. Renders nothing for <2 points (a single dot is not a
 * trend). The line is tinted by the net trend (up=emerald, down=red, flat=slate); the last point
 * is marked, and the y-axis is fixed to the 0..100 score domain so cards are visually comparable.
 *
 * Used on the dashboard card (compact) and the detail Outcome panel (larger via the `width`/`height`
 * props). Stateless, no client hooks — safe in a Server or Client component.
 */

export interface SparklinePoint {
  scored_at: string
  overall_score: number | null
}

interface Props {
  points: SparklinePoint[]
  width?: number
  height?: number
  /** Optional override; defaults to net trend (last vs first). */
  trend?: 'up' | 'down' | 'flat' | null
  className?: string
  /** Draw a faint reference line at the 90 "optimized" threshold. */
  showThreshold?: boolean
}

const STROKE = {
  up: 'var(--spark-up, #10b981)',     // emerald-500
  down: 'var(--spark-down, #ef4444)', // red-500
  flat: 'var(--spark-flat, #94a3b8)', // slate-400
}

export function ScoreSparkline({ points, width = 96, height = 28, trend, className, showThreshold = false }: Props) {
  const scored = points.filter((p) => p.overall_score != null) as (SparklinePoint & { overall_score: number })[]
  if (scored.length < 2) return null

  // Fixed 0..100 score domain so every sparkline is comparable; x is evenly spaced by index.
  const pad = 2
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const n = scored.length
  const x = (i: number) => pad + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => pad + (1 - Math.max(0, Math.min(100, v)) / 100) * innerH

  const first = scored[0].overall_score
  const last = scored[n - 1].overall_score
  const netTrend = trend ?? (last > first ? 'up' : last < first ? 'down' : 'flat')
  const stroke = STROKE[netTrend]

  const linePts = scored.map((p, i) => `${x(i).toFixed(1)},${y(p.overall_score).toFixed(1)}`).join(' ')
  // A soft area fill under the line for a touch of depth (no gradient defs — keep it 1 element).
  const areaPts = `${pad},${height - pad} ${linePts} ${pad + innerW},${height - pad}`
  const lastX = x(n - 1)
  const lastY = y(last)
  const threshY = y(90)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={`Score trend: ${first} to ${last} over ${n} points`}
      preserveAspectRatio="none"
    >
      {showThreshold && (
        <line x1={pad} y1={threshY} x2={pad + innerW} y2={threshY} stroke="#cbd5e1" strokeWidth={0.75} strokeDasharray="2 2" />
      )}
      <polyline points={areaPts} fill={stroke} fillOpacity={0.08} stroke="none" />
      <polyline points={linePts} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2.4} fill={stroke} />
    </svg>
  )
}
