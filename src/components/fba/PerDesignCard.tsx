/**
 * PerDesignCard.tsx
 * Collapsible, editable card for ONE design in a multi-design apparel family.
 * Presentational only — all state (edit values, expand, busy, status) is driven by props;
 * the page owns the edit state and the save/ship/verify handlers (stubbed in PR-B, wired in PR-C).
 *
 * Body resolution (per plan B2):
 *   title       = edit?.title       ?? group.title
 *   bullets     = edit?.bullets     ?? (group.bullets.length ? group.bullets : fallbackBullets)
 *   description = edit?.description  ?? (group.description || fallbackDescription)
 * fallback* are the broadcast recommended_* — used when this design's per-child set is empty
 * (per-design bullets/description only populate on a FULL regen).
 */

import type { PerDesignGroup } from '@/lib/fba/perDesign'

// ── Inline SVG icons (no emoji — matches the app's Icon set in page.tsx) ──
type IconProps = { className?: string }
const ChevronIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
)
const SendIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
)
const SaveIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
)
const CheckIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
)

type DesignStatus = 'matches' | 'needs-update' | 'unknown'

const STATUS_CHIP: Record<DesignStatus, { label: string; classes: string }> = {
  'matches':      { label: 'Live matches', classes: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  'needs-update': { label: 'Needs update', classes: 'bg-amber-100 text-amber-700 border-amber-200' },
  'unknown':      { label: 'Not verified', classes: 'bg-slate-100 text-slate-600 border-slate-200' },
}

const ACCENT: Record<DesignStatus, string> = {
  'matches':      'border-l-emerald-400',
  'needs-update': 'border-l-amber-400',
  'unknown':      'border-l-violet-400',
}

interface PerDesignCardProps {
  group: PerDesignGroup
  fallbackBullets: string[]; fallbackDescription: string // recommended_* — used when group's set is empty
  expanded: boolean; onToggle: () => void
  edit: { title?: string; bullets?: string[]; description?: string } | undefined
  dirty: boolean; busy: boolean
  status: DesignStatus
  onEditTitle: (v: string) => void
  onEditBullet: (i: number, v: string) => void
  onEditDescription: (v: string) => void
  onSave: () => void; onShip: () => void; onVerify: () => void
}

const BULLET_SLOTS = 5

export function PerDesignCard({
  group, fallbackBullets, fallbackDescription,
  expanded, onToggle, edit, dirty, busy, status,
  onEditTitle, onEditBullet, onEditDescription, onSave, onShip, onVerify,
}: PerDesignCardProps) {
  // Resolved display values: live edit > group's own per-child content > broadcast fallback.
  const title = edit?.title ?? group.title
  const bullets = edit?.bullets ?? (group.bullets.length ? group.bullets : fallbackBullets)
  const description = edit?.description ?? (group.description || fallbackDescription)
  const chip = STATUS_CHIP[status]

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl overflow-hidden border-l-4 ${ACCENT[status]}`}>
      {/* ── Header (always visible) — design name + status chip + SKU count + chevron ── */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-slate-800 truncate">{group.designName}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${chip.classes}`}>{chip.label}</span>
            <span className="text-[10px] text-slate-500">{group.skus.length} SKU{group.skus.length === 1 ? '' : 's'}</span>
            {dirty && <span className="text-[10px] font-semibold text-amber-600">• unsaved edits</span>}
          </div>
        </div>
        <ChevronIcon className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* ── Body (when expanded) — editable Title / Bullets / Description ── */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-slate-50/60 border-t border-slate-100 space-y-4">
          {/* Title */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Title</label>
              <span className={`text-[10px] font-medium ${title.length > 200 ? 'text-red-600' : title.length > 75 || (title.length > 0 && title.length < 50) ? 'text-amber-600' : 'text-slate-400'}`}>
                {title.length}/75 chars
              </span>
            </div>
            <textarea
              value={title}
              onChange={(e) => onEditTitle(e.target.value)}
              rows={3}
              maxLength={200}
              className="w-full text-xs text-slate-900 border border-slate-300 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-violet-400 resize-y"
              placeholder="Title for this design…"
            />
          </div>

          {/* Bullets — exactly 5 slots */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1 block">Bullets</label>
            <div className="space-y-2">
              {Array.from({ length: BULLET_SLOTS }).map((_, i) => {
                const val = bullets[i] ?? ''
                return (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] font-mono text-slate-400">Bullet {i + 1}</span>
                      <span className={`text-[10px] font-medium ${val.length > 500 ? 'text-red-600' : 'text-slate-400'}`}>{val.length} chars</span>
                    </div>
                    <textarea
                      value={val}
                      onChange={(e) => onEditBullet(i, e.target.value)}
                      rows={2}
                      maxLength={500}
                      className="w-full text-xs text-slate-900 border border-slate-300 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-violet-400 resize-y"
                      placeholder={`Bullet ${i + 1}…`}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          {/* Description */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Description</label>
              <span className={`text-[10px] font-medium ${description.length > 2000 ? 'text-red-600' : 'text-slate-400'}`}>{description.length} chars</span>
            </div>
            <textarea
              value={description}
              onChange={(e) => onEditDescription(e.target.value)}
              rows={5}
              maxLength={2000}
              className="w-full text-xs text-slate-900 border border-slate-300 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-violet-400 resize-y"
              placeholder="Description for this design…"
            />
          </div>

          {/* ── Footer actions ── */}
          <div className="flex items-center gap-2 flex-wrap border-t border-slate-200 pt-3">
            <button
              onClick={onSave}
              disabled={!dirty || busy}
              className="inline-flex items-center gap-1.5 text-[11px] bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <SaveIcon className="w-3.5 h-3.5" /> Save
            </button>
            <button
              onClick={onShip}
              disabled={busy}
              title="Ship this design's title, bullets, and description to its SKUs"
              className="inline-flex items-center gap-1.5 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <SendIcon className="w-3.5 h-3.5" /> Ship this design
            </button>
            <button
              onClick={onVerify}
              disabled={busy}
              title="Check whether Amazon's live content matches this design"
              className="inline-flex items-center gap-1.5 text-[11px] bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <CheckIcon className="w-3.5 h-3.5" /> Verify
            </button>
            <span className="text-[10px] text-slate-400">{group.skus.length} SKU{group.skus.length === 1 ? '' : 's'}: {group.skus.join(', ')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
