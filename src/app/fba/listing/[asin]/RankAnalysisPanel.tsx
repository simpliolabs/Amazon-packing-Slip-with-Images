'use client'

/**
 * "Rank Top of Amazon" — the in-tab rank panel (task #87). Self-contained: 0-cost GET on mount (cached
 * council result or the free stored-core), POST to run the council (NDJSON-streamed), opt-in POST
 * ?competition=true for credit-bounded Share-of-Voice. The honest framing (what content CAN vs CANNOT do)
 * is enforced server-side; this only renders it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RankAnalysisResult, RankPlaybookRow } from '@/lib/fba/rankAnalysis'

const ACTION_BADGE: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-700',
  UPGRADE: 'bg-amber-100 text-amber-700',
  REINFORCE: 'bg-green-100 text-green-700',
  DEFENDED: 'bg-blue-100 text-blue-700',
  OPTIMIZED: 'bg-slate-100 text-slate-600',
}

const COMPETITION_NOTE: Record<string, string> = {
  js_disabled: 'Jungle Scout is not connected — competitor data unavailable. Add a key in Settings.',
  budget_exhausted: 'Monthly Jungle Scout budget is exhausted — competitor data was not pulled.',
  no_sov_data: 'Jungle Scout returned no competitor data for these keywords.',
}

const Check = () => (
  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const Cross = () => (
  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
)

export default function RankAnalysisPanel({ asin }: { asin: string }) {
  const [data, setData] = useState<RankAnalysisResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<false | 'council' | 'competition'>(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const runAbortRef = useRef<AbortController | null>(null)
  // Abort any in-flight POST stream on unmount / ASIN change so it can't setState a dead instance or
  // leave an orphaned server request. (The parent also keys this panel by asin, remounting on nav.)
  useEffect(() => () => runAbortRef.current?.abort(), [])

  // 0-cost GET on mount: cached council result (with stale flag) or the free stored-core.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    fetch(`/api/fba/rank-analysis/${asin}`)
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j?.error) setError(j.error); else setData(j) })
      .catch((e) => { if (alive) setError(String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [asin])

  const run = useCallback(async (withCompetition: boolean) => {
    const ac = new AbortController()
    runAbortRef.current = ac
    setRunning(withCompetition ? 'competition' : 'council')
    setError('')
    setProgress('Starting…')
    try {
      const resp = await fetch(`/api/fba/rank-analysis/${asin}${withCompetition ? '?competition=true' : ''}`, { method: 'POST', signal: ac.signal })
      if (resp.status === 409) { setError('An analysis is already running for this ASIN — try again in ~90s.'); return }
      if (!resp.ok || !resp.body) throw new Error(`Request failed (${resp.status})`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let final: RankAnalysisResult | null = null
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          let msg: { type?: string; message?: string; error?: string; result?: RankAnalysisResult }
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.type === 'progress') setProgress(msg.message || '…')
          else if (msg.type === 'result' && msg.result) final = msg.result
          else if (msg.type === 'error') throw new Error(msg.error || 'Analysis failed')
        }
      }
      if (final) setData(final)
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError(e instanceof Error ? e.message : String(e))   // ignore navigation aborts
    } finally {
      if (runAbortRef.current === ac) runAbortRef.current = null
      setRunning(false)
      setProgress('')
    }
  }, [asin])

  const busy = running !== false
  const showComp = !!data?.competitionRan

  return (
    <div className="mt-4 bg-white border border-slate-200 rounded-2xl overflow-hidden border-l-4 border-l-violet-500">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
        <div>
          <h3 className="text-sm font-bold text-slate-900">Rank Top of Amazon</h3>
          <p className="text-[11px] text-slate-500">What your content can — and can&apos;t — do for organic rank.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {data?.stale && <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Content changed — refresh</span>}
            <button
              onClick={() => run(false)} disabled={busy}
              title="Rebuilds the rank playbook from your CURRENT content + keywords, then runs the AI analyst council (3 analysts → adversary → judge) for the honest verdict. No Jungle Scout credits — uses your OpenAI key (~a cent)."
              className="text-xs px-3 py-2 min-h-[40px] rounded-lg bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 cursor-pointer">
              {running === 'council' ? 'Analyzing…' : data?.analyzed ? 'Refresh analysis' : 'Run analysis'}
            </button>
            <button
              onClick={() => run(true)} disabled={busy}
              title="Everything Refresh analysis does, PLUS live Share-of-Voice per top keyword: which competitor owns the clicks, their share %, and whether YOU appear in the top listings. Uses up to 10 Jungle Scout credits."
              className="text-xs px-3 py-2 min-h-[40px] rounded-lg border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-50 cursor-pointer">
              {running === 'competition' ? 'Checking competitors…' : 'Analyze competition'}
            </button>
          </div>
          <p className="text-[10px] text-slate-400">Refresh analysis = free re-check on current content (AI verdict, no credits) · Analyze competition = + who owns the clicks per keyword (up to 10 JS credits)</p>
        </div>
      </div>

      {/* Progress / error */}
      {busy && progress && <div className="px-4 py-2 text-[11px] text-violet-700 bg-violet-50 border-b border-violet-100">{progress}</div>}
      {error && <div className="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">{error}</div>}

      {loading && <div className="px-4 py-6 text-xs text-slate-400">Loading rank analysis…</div>}

      {!loading && data && !data.analyzed && (
        <div className="px-4 py-6 text-xs text-slate-500">
          No keyword intelligence yet for this listing. Generate it from the <span className="font-medium">Intelligence</span> sync, then run the analysis.
        </div>
      )}

      {!loading && data?.analyzed && data.verdict && (
        <>
          {/* Verdict */}
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
            <p className="text-xs text-slate-800 font-medium">{data.verdict.headline}</p>
            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">Content CAN do</p>
                <ul className="space-y-1">
                  {(data.verdict.contentCanDo ?? []).map((c, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] text-slate-700"><Check />{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Content CAN&apos;T do (needs other levers)</p>
                <ul className="space-y-1">
                  {(data.verdict.contentCannotDo ?? []).map((c, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] text-slate-600"><Cross />{c}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <span className="text-[10px] bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full">{data.verdict.indexedCoverage}</span>
              {data.verdict.criticalGaps > 0 && <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{data.verdict.criticalGaps} high-opportunity gap{data.verdict.criticalGaps === 1 ? '' : 's'}</span>}
              {showComp && data.creditsSpent > 0 && <span className="text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">Competition: {data.creditsSpent} credit{data.creditsSpent === 1 ? '' : 's'} used</span>}
            </div>
            <p className="text-[11px] italic text-slate-500 mt-2">{data.verdict.honestNote}</p>
            {data.councilFailedOpen && <p className="text-[10px] text-amber-600 mt-1">AI narrative was unavailable — showing the deterministic baseline.</p>}
            {data.competitionStatus && data.competitionStatus !== 'ok' && data.competitionStatus !== 'not_run' && COMPETITION_NOTE[data.competitionStatus] && (
              <p className="text-[11px] text-slate-500 mt-1">{COMPETITION_NOTE[data.competitionStatus]}</p>
            )}
          </div>

          {/* Playbook table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Keyword</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Action</th>
                  <th className="text-center px-3 py-2 font-medium text-slate-500">You cover</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">What content does</th>
                  {showComp && <th className="text-left px-3 py-2 font-medium text-slate-500">Top competitor</th>}
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Beyond content</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data.rows ?? []).map((r: RankPlaybookRow, i) => (
                  <tr key={i} className="hover:bg-slate-50 align-top">
                    <td className="px-3 py-2 text-slate-800">
                      {r.keyword}
                      <span className="block text-[10px] text-slate-400">{(r.volume ?? 0).toLocaleString()} vol · opp {r.opportunityScore}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${ACTION_BADGE[r.actionType] || 'bg-slate-100 text-slate-600'}`}>{r.actionType}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-center" title={r.youCover ? (r.coveredIn ?? []).join(', ') : 'not covered'}>
                        {r.youCover ? <Check /> : <Cross />}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {r.contentAction}
                      {/* Outcome loop (#89): honest share-movement line (correlation, never causation). Renders
                          nothing until ≥2 months of share history exist. */}
                      {r.shareSignal && (
                        <span className={`block text-[10px] mt-0.5 ${r.shareSignal.direction === 'rose' ? 'text-emerald-600' : 'text-amber-600'}`}>
                          {r.shareSignal.text}
                        </span>
                      )}
                    </td>
                    {showComp && (
                      <td className="px-3 py-2 text-slate-600">
                        {r.sovStatus === 'ok' && r.topCompetitorBrand ? (
                          <>
                            <span className="text-slate-800">{r.topCompetitorBrand}</span>
                            <span className="block text-[10px] text-slate-400">
                              ~{r.theirShare}% of clicks{r.sellerVisible === false ? ' · you’re not in top listings' : r.sellerVisible ? ' · you’re in top listings' : ''}
                            </span>
                          </>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                    )}
                    <td className="px-3 py-2 text-slate-500">{r.nonContentReality || <span className="text-slate-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
