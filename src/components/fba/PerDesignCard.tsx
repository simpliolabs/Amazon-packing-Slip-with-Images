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

import { useEffect, useState } from 'react'
import type { PerDesignGroup } from '@/lib/fba/perDesign'
import { SOURCE_LABEL, type ChildGarmentResolution } from '@/lib/fba/garmentPerDesign'

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
const PencilIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
)
const XIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
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
  onSave: () => void
  /** Ship ONE field of this design to its SKUs. Opens the existing push preview modal scoped to the
   *  design — the seller confirms there; this never fires a live push directly. */
  onShipField: (field: 'title' | 'bullets' | 'description') => void
  onVerify: () => void
  /** Persist a per-design name override (migration 034). value='' clears it back to auto-detect.
   *  DB-only — relabels the card + seeds the NEXT regen; nothing pushes to Amazon. */
  onRenameDesign?: (designKey: string, value: string) => void
  /** PER-DESIGN AUDIENCE (migration 070, PO 2026-08-26 — the garment per-design ruling applied to
   *  audience). `assignedAudienceLean` is the RAW map entry for THIS design ('' = unassigned, so
   *  the select shows "Inherit family default" rather than a resolved value the seller could not
   *  tell apart from an explicit choice). `familyAudienceLean` is the family's own audience_lean
   *  (029) — the value this design falls back to when unassigned; shown so the seller can see what
   *  "inherit" currently means without leaving the card. Same idiom as the family Garment row: a
   *  select + a source badge, no auto-regen (PO decision C — assigning changes what the generator
   *  believes, never a live rewrite). */
  assignedAudienceLean?: string
  familyAudienceLean?: string | null
  audienceSaving?: boolean
  onAssignAudience?: (designKey: string, value: string) => void
  /** PER-DESIGN GARMENT (PO 2026-09-03 — B0DSCDZC6K "Business B*tch" shipped a Tee title for a
   *  design the PO says IS a sweatshirt, because a wrong `scope='child'` blank_assignments row was
   *  visible/editable only via hand-written SQL). Same select+badge idiom as the family Garment row
   *  (page.tsx) and the AUDIENCE row above: `designGarment` is this design's RESOLVED blank AND
   *  which precedence level decided it (child assignment / SKU code / family assignment / legacy
   *  match) — undefined/null while garment data is still loading. Assigning writes a
   *  `scope='child'` row for EVERY SKU in this design (never a live rewrite/push — same
   *  "Regenerate to apply" contract as Audience/family Garment). Clearing is gated behind an inline
   *  confirm that shows `designGarment.fallback` — what resolution the design would fall back to —
   *  BEFORE the delete fires, so a clear can never silently reintroduce a wrong garment. */
  designGarment?: ChildGarmentResolution | null
  garmentActiveBlanks?: { id: number; style_code: string | null; brand: string | null }[]
  garmentSaving?: boolean
  garmentJustSaved?: boolean
  onAssignGarment?: (designKey: string, styleCode: string) => void
  onClearGarment?: (designKey: string) => void
}

const AUDIENCE_LABEL: Record<string, string> = {
  unisex: 'Unisex', lean_female: 'Lean Female', lean_male: 'Lean Male', female: 'Female', male: 'Male',
}

// Small inline "Ship →" affordance shown next to each editable field's label.
const ShipFieldButton = ({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={`Ship this design's ${label.toLowerCase()} to its SKUs (opens a preview to confirm)`}
    className="inline-flex items-center gap-1 text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-0.5 rounded font-medium disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
  >
    <SendIcon className="w-3 h-3" /> Ship →
  </button>
)

const BULLET_SLOTS = 5

export function PerDesignCard({
  group, fallbackBullets, fallbackDescription,
  expanded, onToggle, edit, dirty, busy, status,
  onEditTitle, onEditBullet, onEditDescription, onSave, onShipField, onVerify, onRenameDesign,
  assignedAudienceLean, familyAudienceLean, audienceSaving, onAssignAudience,
  designGarment, garmentActiveBlanks, garmentSaving, garmentJustSaved, onAssignGarment, onClearGarment,
}: PerDesignCardProps) {
  // Resolved display values: live edit > group's own per-child content > broadcast fallback.
  const title = edit?.title ?? group.title
  const bullets = edit?.bullets ?? (group.bullets.length ? group.bullets : fallbackBullets)
  const description = edit?.description ?? (group.description || fallbackDescription)
  const chip = STATUS_CHIP[status]

  // ── Inline design-name editor (DB-only override, migration 034) ──
  // Reset the draft whenever the resolved name changes (e.g. after a save/regen relabels the card).
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(group.designName)
  useEffect(() => { setNameDraft(group.designName) }, [group.designName])
  const submitName = () => {
    setEditingName(false)
    // Empty submit = clear back to auto-detect. Only POST when the value actually changed.
    const next = nameDraft.trim()
    if (next !== group.designName.trim()) onRenameDesign?.(group.designKey, next)
  }
  const cancelName = () => { setEditingName(false); setNameDraft(group.designName) }

  // ── Garment clear confirmation (local UI state only — the fallback preview itself comes from the
  //    server via designGarment.fallback, computed by resolveChildFallback in blankAssignmentImpact.ts
  //    so it can never drift from what an actual clear + reload would show). ──
  const [clearConfirming, setClearConfirming] = useState(false)

  return (
    <div className={`bg-white border border-slate-200 rounded-2xl overflow-hidden border-l-4 ${ACCENT[status]}`}>
      {/* ── Header (always visible) — editable design name + status chip + SKU count + chevron ──
          NOT a single <button>: the inline name editor needs its own input/buttons, and nesting
          interactive controls inside a button is invalid HTML. The chevron region toggles expand. */}
      <div className="w-full flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {editingName ? (
              <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitName(); else if (e.key === 'Escape') cancelName() }}
                  maxLength={80}
                  placeholder="Design name (blank = auto)"
                  className="text-sm font-bold text-slate-800 border border-violet-400 rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-violet-400 w-48"
                />
                <button
                  onClick={submitName}
                  title="Save design name (blank resets to auto-detect)"
                  className="inline-flex items-center justify-center w-6 h-6 rounded bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer"
                >
                  <CheckIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={cancelName}
                  title="Cancel"
                  className="inline-flex items-center justify-center w-6 h-6 rounded bg-white border border-slate-300 hover:bg-slate-100 text-slate-500 transition-colors cursor-pointer"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </span>
            ) : (
              <>
                <span className="text-sm font-bold text-slate-800 truncate">{group.designName}</span>
                {onRenameDesign && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setNameDraft(group.designName); setEditingName(true) }}
                    title="Rename this design (used as the anchor on the next regen)"
                    className="inline-flex items-center justify-center w-5 h-5 rounded text-slate-400 hover:text-violet-600 hover:bg-slate-100 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <PencilIcon className="w-3 h-3" />
                  </button>
                )}
              </>
            )}
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${chip.classes}`}>{chip.label}</span>
            <span className="text-[10px] text-slate-500">{group.skus.length} SKU{group.skus.length === 1 ? '' : 's'}</span>
            {dirty && <span className="text-[10px] font-semibold text-amber-600">• unsaved edits</span>}
          </div>
        </div>
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse design' : 'Expand design'}
          className="flex-shrink-0 p-1 rounded hover:bg-slate-100 transition-colors cursor-pointer"
        >
          <ChevronIcon className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* ── Body (when expanded) — editable Title / Bullets / Description ── */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-slate-50/60 border-t border-slate-100 space-y-4">
          {/* ── GARMENT (PO 2026-09-03) — this design's resolved blank + WHICH precedence level
              decided it, same select+badge idiom as the family Garment row (page.tsx). A wrong
              child-scope assignment (the B0DSCDZC6K defect class) is now visible at a glance instead
              of requiring SQL. Assigning writes scope='child' for every SKU in this design; clearing
              requires an inline confirm that shows the fallback target FIRST. ── */}
          {onAssignGarment && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Garment</label>
              {designGarment?.styleCode ? (
                <span className="font-mono text-xs font-semibold text-slate-700 bg-slate-100 rounded px-2 py-0.5">{designGarment.styleCode}</span>
              ) : (
                <span className="text-xs text-slate-400">unresolved</span>
              )}
              {designGarment?.source && (
                <span className="text-[10px] font-medium bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">
                  {SOURCE_LABEL[designGarment.source] ?? designGarment.source}
                </span>
              )}
              <select
                value={designGarment?.source === 'child-assignment' ? (designGarment.styleCode ?? '') : ''}
                onChange={(e) => e.target.value && onAssignGarment(group.designKey, e.target.value)}
                disabled={!!garmentSaving}
                title={`Assigns this blank to all ${group.skus.length} SKU${group.skus.length === 1 ? '' : 's'} in this design`}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-200 cursor-pointer disabled:opacity-50"
              >
                <option value="">Assign a blank…</option>
                {(garmentActiveBlanks ?? []).map((b) => (
                  <option key={b.id} value={b.style_code ?? ''}>{b.style_code} — {b.brand || 'no brand'}</option>
                ))}
              </select>
              {garmentSaving && <span className="text-[10px] text-slate-400">Saving…</span>}
              {/* Clear is only offered when there IS an explicit assignment to clear (source ===
                  'child-assignment'); clicking it never deletes immediately — it shows what the
                  design would fall back to and requires a second confirming click. */}
              {designGarment?.source === 'child-assignment' && onClearGarment && (
                clearConfirming ? (
                  <span className="inline-flex items-center gap-1.5 text-[10px] bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-2 py-1">
                    <span>
                      Falls back to{' '}
                      {designGarment.fallback.styleCode ? (
                        <span className="font-mono font-semibold">{designGarment.fallback.styleCode}</span>
                      ) : (
                        <span className="italic">unresolved</span>
                      )}
                      {designGarment.fallback.source && ` (${SOURCE_LABEL[designGarment.fallback.source] ?? designGarment.fallback.source})`}
                    </span>
                    <button
                      onClick={() => { setClearConfirming(false); onClearGarment(group.designKey) }}
                      className="font-semibold text-amber-900 hover:underline cursor-pointer"
                    >
                      Confirm clear
                    </button>
                    <button onClick={() => setClearConfirming(false)} className="text-slate-500 hover:underline cursor-pointer">Cancel</button>
                  </span>
                ) : (
                  <button
                    onClick={() => setClearConfirming(true)}
                    disabled={!!garmentSaving}
                    className="text-[10px] text-slate-500 hover:text-red-600 underline decoration-dotted disabled:opacity-40 cursor-pointer"
                  >
                    Clear
                  </button>
                )
              )}
              <span className="text-[10px] text-slate-400">
                {garmentJustSaved ? 'Assigned — stored copy unchanged. Regenerate to apply.' : 'Changes what the generator believes — no live copy rewrite, no Amazon push.'}
              </span>
            </div>
          )}

          {/* ── AUDIENCE (migration 070, PO 2026-08-26) — same select+badge idiom as the family
              Garment row (page.tsx). Assigning writes audience_lean_by_design ONLY; it never
              triggers a regenerate or push — the helper text says so, mirroring the Garment row's
              "Regenerate to apply" copy. Unassigned = inherit the family's own audience_lean. ── */}
          {onAssignAudience && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Audience</label>
              <select
                value={assignedAudienceLean ?? ''}
                onChange={(e) => onAssignAudience(group.designKey, e.target.value)}
                disabled={!!audienceSaving}
                title="Who is THIS design for? Overrides the family's Audience selector for this design only — the cross-gender keyword filter and the title's audience wording judge this design against its own value."
                className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-200 cursor-pointer disabled:opacity-50"
              >
                <option value="">Inherit family default{familyAudienceLean ? ` (${AUDIENCE_LABEL[familyAudienceLean] ?? familyAudienceLean})` : ' (Auto)'}</option>
                <option value="unisex">Unisex</option>
                <option value="lean_female">Lean Female</option>
                <option value="lean_male">Lean Male</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </select>
              <span className="text-[10px] font-medium bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">
                {assignedAudienceLean ? 'design assignment' : 'family default'}
              </span>
              {audienceSaving && <span className="text-[10px] text-slate-400">Saving…</span>}
              <span className="text-[10px] text-slate-400">Changes what the generator believes — no live copy rewrite. Regenerate to apply.</span>
            </div>
          )}

          {/* Title */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Title</label>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-medium ${title.length > 200 ? 'text-red-600' : title.length > 75 || (title.length > 0 && title.length < 50) ? 'text-amber-600' : 'text-slate-400'}`}>
                  {title.length}/75 chars
                </span>
                <ShipFieldButton onClick={() => onShipField('title')} disabled={busy} label="Title" />
              </div>
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
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Bullets</label>
              <ShipFieldButton onClick={() => onShipField('bullets')} disabled={busy} label="Bullets" />
            </div>
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
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-medium ${description.length > 2000 ? 'text-red-600' : 'text-slate-400'}`}>{description.length} chars</span>
                <ShipFieldButton onClick={() => onShipField('description')} disabled={busy} label="Description" />
              </div>
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
