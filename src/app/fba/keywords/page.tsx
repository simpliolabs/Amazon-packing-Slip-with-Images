'use client'

/**
 * /fba/keywords — Keyword Seed Pool dashboard (read-only).
 * ─────────────────────────────────────────────────────────────────────────────
 * Surfaces keyword_seed_pool (migration 032): each row is one niche seed researched ONCE
 * and reused by every same-niche listing for 14 days (0 extra Jungle Scout credits). Auth +
 * chrome come from middleware + src/app/fba/layout.tsx (DashboardLayout) — this page writes none.
 */
import { useCallback, useEffect, useState } from 'react'
import { KeyRound, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'

type TopKeyword = { keyword: string; searchVolume: number }
type Pool = {
  seedKey: string
  keywordCount: number
  contributorCount: number
  contributorAsins: string[]
  reuseCount: number
  competitorBrand: string | null
  competitorAsin: string | null
  sovPercentage: number | null
  seedSource: string | null
  fetchedAt: string
  expiresAt: string | null
  fresh: boolean
  daysLeft: number | null
  topKeywords: TopKeyword[]
}
type Totals = {
  seeds: number
  freshSeeds: number
  listingsServed: number
  totalReuses: number
  estCreditsSaved: number
}

const SOURCE_CONFIG: Record<string, { label: string; cls: string }> = {
  vision: { label: 'Vision', cls: 'text-purple-700 bg-purple-50 border-purple-200' },
  agent: { label: 'Agent', cls: 'text-blue-700 bg-blue-50 border-blue-200' },
  category: { label: 'Category', cls: 'text-teal-700 bg-teal-50 border-teal-200' },
  manual: { label: 'Manual', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  title: { label: 'Title', cls: 'text-gray-600 bg-gray-100 border-gray-200' },
  rules: { label: 'Rules', cls: 'text-gray-600 bg-gray-100 border-gray-200' },
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function KeywordPoolPage() {
  const [pools, setPools] = useState<Pool[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/fba/keywords', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load')
      setPools(Array.isArray(json.pools) ? json.pools : [])
      setTotals(json.totals ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-[#2E9CE6]" />
            Keyword Seed Pool
          </h1>
          <p className="text-sm text-gray-500 mt-1 max-w-2xl">
            Each niche is researched on Jungle Scout <span className="font-medium">once</span> and shared by every
            same-niche listing for 14 days. Listings reusing a pool spend ~1 credit (their own rank only) instead of 4–7.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary stat cards */}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard label="Niche pools" value={`${totals.freshSeeds} / ${totals.seeds}`} hint="fresh / total" accent="#2E9CE6" />
          <StatCard label="Listings served" value={totals.listingsServed} hint="across all pools" accent="#10b981" />
          <StatCard label="Cross-listing reuses" value={totals.totalReuses} hint="pool hits saved JS" accent="#8b5cf6" />
          <StatCard label="~Credits saved" value={`~${totals.estCreditsSaved}`} hint="est. JS credits (≈3/reuse)" accent="#f59e0b" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 px-4 py-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl">
          Failed to load pool: {error}
        </div>
      )}

      {/* Table card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-8"></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Niche seed</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Keywords</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Listings</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Competitor</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Freshness</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && pools.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                    Loading seed pool…
                  </td>
                </tr>
              )}

              {!loading && pools.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <KeyRound className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-700">No seed pools yet</p>
                    <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
                      Pools fill in as listings are researched. The first research of a niche seeds it; every
                      same-niche listing then reuses that pool for 14 days at 0 extra Jungle Scout credits.
                    </p>
                  </td>
                </tr>
              )}

              {pools.map((p) => {
                const isOpen = expanded === p.seedKey
                const src = (p.seedSource && SOURCE_CONFIG[p.seedSource]) || null
                return (
                  <FragmentRow
                    key={p.seedKey}
                    pool={p}
                    isOpen={isOpen}
                    src={src}
                    onToggle={() => setExpanded(isOpen ? null : p.seedKey)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Showing up to 500 pools, newest first. Credits-saved is an estimate (~3 niche-research credits skipped per reuse;
        each reusing listing still spends ~1 for its own organic-rank read).
      </p>
    </div>
  )
}

function StatCard({ label, value, hint, accent }: { label: string; value: string | number; hint: string; accent: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 border-l-4" style={{ borderLeftColor: accent }}>
      <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{hint}</div>
    </div>
  )
}

function FragmentRow({
  pool: p,
  isOpen,
  src,
  onToggle,
}: {
  pool: Pool
  isOpen: boolean
  src: { label: string; cls: string } | null
  onToggle: () => void
}) {
  return (
    <>
      <tr className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-3 text-gray-400">
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
        <td className="px-4 py-3 font-medium text-gray-900">{p.seedKey}</td>
        <td className="px-4 py-3 text-right tabular-nums text-gray-700">{p.keywordCount}</td>
        <td className="px-4 py-3 text-right tabular-nums text-gray-700">
          {p.contributorCount}
          {p.reuseCount > 0 && (
            <span className="ml-1.5 text-xs font-medium text-[#8b5cf6]">+{p.reuseCount} reused</span>
          )}
        </td>
        <td className="px-4 py-3 text-gray-700">
          {p.competitorBrand ? (
            <span>
              {p.competitorBrand}
              {p.sovPercentage != null && <span className="text-gray-400"> · {p.sovPercentage}%</span>}
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-4 py-3">
          {src ? (
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${src.cls}`}>
              {src.label}
            </span>
          ) : (
            <span className="text-gray-300">{p.seedSource || '—'}</span>
          )}
        </td>
        <td className="px-4 py-3">
          {p.fresh ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border text-green-700 bg-green-50 border-green-200">
              Fresh{p.daysLeft != null ? ` · ${p.daysLeft}d` : ''}
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border text-gray-500 bg-gray-100 border-gray-200">
              Expired
            </span>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-gray-50/60">
          <td />
          <td colSpan={6} className="px-4 py-3">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Top keywords by volume
                </div>
                {p.topKeywords.length > 0 ? (
                  <ul className="space-y-1">
                    {p.topKeywords.map((k) => (
                      <li key={k.keyword} className="flex items-center justify-between text-sm">
                        <span className="text-gray-700">{k.keyword}</span>
                        <span className="tabular-nums text-gray-400">{k.searchVolume.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-sm text-gray-400">No keywords stored</span>
                )}
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  Listings sharing this pool ({p.contributorCount})
                </div>
                {p.contributorAsins.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {p.contributorAsins.map((asin) => (
                      <span key={asin} className="px-2 py-0.5 rounded-md text-xs font-mono text-gray-600 bg-white border border-gray-200">
                        {asin}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-sm text-gray-400">—</span>
                )}
                <div className="text-xs text-gray-400 mt-2">
                  Researched {fmtDate(p.fetchedAt)} · expires {fmtDate(p.expiresAt)}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
