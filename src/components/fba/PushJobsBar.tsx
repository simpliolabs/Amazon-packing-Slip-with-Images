'use client'

/**
 * Global push-job status bar (PR #184).
 * Mounted once in the /fba layout, so it is visible on EVERY portal page: queue a
 * push on a listing page, navigate anywhere (or close the tab and come back) and
 * the bar keeps reporting. Its polling is also what drives the server's read-side
 * watchdog + queue self-heal — see /api/fba/push-jobs GET.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

interface JobEntry {
  id: string
  parent_asin: string
  field: string | null
  detail_field: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'
  total: number
  accepted: number
  failed: number
  message: string | null
}

const FIELD_LABEL: Record<string, string> = {
  title: 'Title', bullets: 'Bullets', description: 'Description', keywords: 'Backend Keywords',
}

function jobLabel(j: JobEntry): string {
  if (j.field === 'details' && j.detail_field) return j.detail_field
  return FIELD_LABEL[j.field ?? ''] ?? (j.field || 'Push')
}

const ACTIVE_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000

export default function PushJobsBar() {
  const [jobs, setJobs] = useState<JobEntry[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards the re-schedule: an in-flight fetch resolving AFTER effect cleanup must not
  // start a new timer (dev strict-mode double-mount would otherwise stack pollers).
  const stopped = useRef(false)

  const poll = useCallback(async () => {
    let delay = IDLE_POLL_MS
    try {
      // Skip the fetch entirely while the tab is hidden — resume on focus below.
      if (document.visibilityState === 'visible') {
        const res = await fetch('/api/fba/push-jobs?active=1', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json() as { jobs?: JobEntry[] }
          const list = data.jobs ?? []
          setJobs(list)
          if (list.some((j) => j.status === 'queued' || j.status === 'running')) delay = ACTIVE_POLL_MS
        }
      }
    } catch { /* transient network error — just poll again later */ }
    if (stopped.current) return
    timer.current = setTimeout(() => { void poll() }, delay)
  }, [])

  useEffect(() => {
    stopped.current = false
    void poll()
    const repoll = () => {
      if (timer.current) clearTimeout(timer.current)
      void poll()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') repoll() }
    document.addEventListener('visibilitychange', onVisible)
    // Fired by the Ship modal right after queueing a job, so the new entry appears
    // immediately instead of waiting out the current poll interval.
    window.addEventListener('push-jobs-changed', repoll)
    return () => {
      stopped.current = true
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('push-jobs-changed', repoll)
    }
  }, [poll])

  const visible = jobs.filter((j) => !dismissed.has(j.id))
  if (visible.length === 0) return null

  return (
    <div className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 w-auto max-w-[min(92vw,720px)]">
      <div className="rounded-2xl border border-slate-200 bg-white/95 shadow-lg backdrop-blur px-3 py-2 space-y-1.5">
        {visible.map((j) => {
          const active = j.status === 'queued' || j.status === 'running'
          const dot =
            j.status === 'running' ? 'bg-blue-500 animate-pulse'
            : j.status === 'queued' ? 'bg-slate-400 animate-pulse'
            : j.status === 'done' ? (j.failed > 0 ? 'bg-amber-500' : 'bg-emerald-500')
            : j.status === 'interrupted' ? 'bg-amber-500'
            : 'bg-rose-500'
          const statusText =
            j.status === 'queued' ? 'Queued'
            : j.status === 'running' ? `Pushing… ${j.accepted + j.failed}/${j.total || '?'}`
            : j.status === 'done' ? `Done — ${j.accepted} accepted${j.failed ? `, ${j.failed} failed` : ''}`
            : j.status === 'interrupted' ? 'Interrupted — Verify on Amazon'
            : 'Failed'
          return (
            <div key={j.id} className="flex items-center gap-2 text-xs" title={j.message ?? undefined}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
              <Link
                href={`/fba/listing/${j.parent_asin}`}
                className="font-medium text-slate-700 hover:text-blue-600 whitespace-nowrap"
              >
                {j.parent_asin} · {jobLabel(j)}
              </Link>
              <span className={`whitespace-nowrap ${active ? 'text-slate-500' : j.status === 'done' && !j.failed ? 'text-emerald-600' : 'text-amber-600'}`}>
                {statusText}
              </span>
              {!active && (
                <button
                  onClick={() => setDismissed((prev) => new Set(prev).add(j.id))}
                  className="ml-auto rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Dismiss"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
