'use client'

import { useEffect, useState } from 'react'

type AiHealth = { status: 'ok' | 'down'; kind?: string | null; message?: string | null; occurred_at?: string | null }

/**
 * Site-wide AI-health banner (2026-07-08, PO: "Why no site wide banner notification about Failure?").
 * Polls /api/fba/ai-health (written DOWN by the AI routes on a hard quota/auth error, OK on the
 * next healthy run — self-healing, no manual dismissal needed). Renders nothing when healthy, a
 * fixed red bar on every fba page when the AI is down — so a credit outage is impossible to miss
 * regardless of which page you're on.
 */
export default function AiHealthBanner() {
  const [health, setHealth] = useState<AiHealth | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const resp = await fetch('/api/fba/ai-health', { cache: 'no-store' })
        if (!resp.ok) return
        const data = (await resp.json()) as AiHealth
        if (alive) setHealth(data)
      } catch { /* network blip — keep the last known state */ }
    }
    poll()
    const t = setInterval(poll, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (health?.status !== 'down') return null

  const title = health.kind === 'auth' ? 'AI is DOWN — OpenAI key rejected' : 'AI is DOWN — OpenAI credit exhausted'
  const detail = health.message
    || (health.kind === 'auth'
      ? 'Content generation is paused. Check the OpenAI API key in Settings. Your stored content is safe.'
      : 'Content generation is paused. Add credit at platform.openai.com/billing. Your stored content is safe.')

  return (
    // Sticky, IN-FLOW (adversarial 2026-07-08): a fixed top-0 bar covered the mobile hamburger +
    // the first rows of every page for the whole outage. Sticky inside the scrolling main pins it
    // to the top without covering the header/sidebar.
    <div className="sticky top-0 z-[60] bg-red-600 text-white shadow-lg" role="alert">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3">
        <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
        <p className="text-xs font-semibold">
          {title}
          <span className="font-normal text-red-100"> — {detail} After fixing it, run any Regenerate — a healthy run clears this banner.</span>
          {health.occurred_at && <span className="font-normal text-red-200"> (since {new Date(health.occurred_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})</span>}
        </p>
      </div>
    </div>
  )
}
