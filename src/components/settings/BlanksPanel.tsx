'use client'

/**
 * Settings → Blanks (handoff/BLANKS_IN_PORTAL_DESIGN.md §5.3, §6 step 4). The PO-editable garment
 * blank catalog: add a blank, edit its facts, deactivate one (never delete — deleting would
 * silently re-point every family that resolved to it). Any style_code/match_pattern change runs the
 * blast-radius preview (POST /api/fba/blanks/impact) and shows a confirm step before saving.
 *
 * Design language: slate canvas, rounded-2xl white cards, SVG icons only, left accent — matches the
 * FBA optimizer pages (src/app/fba/listing/[asin]/page.tsx), per the design doc's explicit ask.
 */
import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'

const GARMENT_FAMILIES = ['tee', 'long_sleeve_tee', 'sweatshirt', 'hoodie', 'kids_tee'] as const

interface Blank {
  id: number
  style_code: string | null
  match_pattern: string
  brand: string | null
  brand_in_copy: boolean
  garment_family: string | null
  fit: string | null
  sleeve: string | null
  neck: string | null
  weight_note: string | null
  material: string | null
  dye: string | null
  stretch: string | null
  fit_to_size: string | null
  unisex: boolean | null
  active: boolean
  notes: string | null
  updated_by?: string | null
  usedByFamilies: number
}

type FormState = {
  style_code: string
  match_pattern: string
  brand: string
  brand_in_copy: boolean
  garment_family: string
  fit: string
  sleeve: string
  neck: string
  weight_note: string
  material: string
  dye: string
  stretch: string
  fit_to_size: string
  unisex: boolean
  notes: string
}

const EMPTY_FORM: FormState = {
  style_code: '', match_pattern: '', brand: '', brand_in_copy: true, garment_family: 'tee',
  fit: '', sleeve: '', neck: '', weight_note: '', material: '', dye: '', stretch: '', fit_to_size: '',
  unisex: false, notes: '',
}

function blankToForm(b: Blank): FormState {
  return {
    style_code: b.style_code ?? '', match_pattern: b.match_pattern ?? '', brand: b.brand ?? '',
    brand_in_copy: b.brand_in_copy !== false, garment_family: b.garment_family ?? 'tee',
    fit: b.fit ?? '', sleeve: b.sleeve ?? '', neck: b.neck ?? '', weight_note: b.weight_note ?? '',
    material: b.material ?? '', dye: b.dye ?? '', stretch: b.stretch ?? '', fit_to_size: b.fit_to_size ?? '',
    unisex: b.unisex === true, notes: b.notes ?? '',
  }
}

interface ImpactResult { resolvesTodayCount: number; wouldResolveCount: number; sampleAsins: string[] }

const Icon = {
  Tag: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" /><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none" /></svg>),
  Plus: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>),
  Pencil: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>),
  Power: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10" /></svg>),
  Alert: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>),
  X: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={p.className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>),
  Loader: (p: { className?: string }) => (<svg viewBox="0 0 24 24" className={`${p.className ?? ''} animate-spin`} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M21 12a9 9 0 11-6.219-8.56" /></svg>),
}

export default function BlanksPanel() {
  const [blanks, setBlanks] = useState<Blank[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Form modal: null = closed; 'new' = create; a Blank = editing that row.
  const [editing, setEditing] = useState<Blank | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Blast-radius confirm step (design doc §5.3): populated after a preview call, cleared on close.
  const [impact, setImpact] = useState<ImpactResult | null>(null)
  const [impactChecking, setImpactChecking] = useState(false)
  const [impactError, setImpactError] = useState<string | null>(null)

  const [togglingId, setTogglingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const resp = await fetch('/api/fba/blanks')
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to load blanks')
      setBlanks(Array.isArray(data.blanks) ? data.blanks : [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load blanks')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  function openNew() {
    setForm(EMPTY_FORM)
    setImpact(null)
    setImpactError(null)
    setSaveError(null)
    setEditing('new')
  }
  function openEdit(b: Blank) {
    setForm(blankToForm(b))
    setImpact(null)
    setImpactError(null)
    setSaveError(null)
    setEditing(b)
  }
  function closeForm() {
    setEditing(null)
    setImpact(null)
    setImpactError(null)
    setSaveError(null)
  }

  const identityChanged = editing !== 'new' && editing
    ? form.style_code.trim().toUpperCase() !== (editing.style_code ?? '').trim().toUpperCase() || form.match_pattern.trim() !== (editing.match_pattern ?? '').trim()
    : true // creating is always a "new identity"

  async function runImpactPreview() {
    setImpactChecking(true)
    setImpactError(null)
    try {
      const resp = await fetch('/api/fba/blanks/impact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editing !== 'new' && editing ? editing.id : null,
          style_code: form.style_code.trim() || null,
          match_pattern: form.match_pattern.trim() || null,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Impact preview failed')
      setImpact(data)
    } catch (e) {
      setImpactError(e instanceof Error ? e.message : 'Impact preview failed')
    } finally {
      setImpactChecking(false)
    }
  }

  async function doSave() {
    setSaving(true)
    setSaveError(null)
    const payload = {
      style_code: form.style_code.trim(),
      match_pattern: form.match_pattern.trim(),
      brand: form.brand.trim() || null,
      brand_in_copy: form.brand_in_copy,
      garment_family: form.garment_family,
      fit: form.fit.trim() || null,
      sleeve: form.sleeve.trim() || null,
      neck: form.neck.trim() || null,
      weight_note: form.weight_note.trim() || null,
      material: form.material.trim() || null,
      dye: form.dye.trim() || null,
      stretch: form.stretch.trim() || null,
      fit_to_size: form.fit_to_size.trim() || null,
      unisex: form.unisex,
      notes: form.notes.trim() || null,
    }
    try {
      const resp = editing === 'new'
        ? await fetch('/api/fba/blanks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/fba/blanks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editing!.id, ...payload }) })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Save failed')
      toast.success(editing === 'new' ? `Blank "${payload.style_code}" created` : `Blank "${payload.style_code}" updated`)
      closeForm()
      load()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(b: Blank) {
    setTogglingId(b.id)
    try {
      const resp = await fetch('/api/fba/blanks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.id, active: !b.active }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Update failed')
      toast.success(b.active ? `Deactivated "${b.style_code}"` : `Reactivated "${b.style_code}"`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setTogglingId(null)
    }
  }

  const readyToSave = form.style_code.trim() && form.match_pattern.trim() && !identityChanged || (identityChanged && impact != null)

  return (
    <div className="p-4 lg:p-6 max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2"><Icon.Tag className="w-5 h-5 text-violet-600" /> Blanks</h1>
          <p className="text-sm text-slate-500 mt-0.5 max-w-xl">
            The garment blank catalog — what each family/SKU IS (brand, fit, fabric, garment family). Add or correct a blank here — no deploy required. Assign it to a listing from that listing&rsquo;s page; a regenerate is needed for the assignment to reach live copy.
          </p>
        </div>
        <button
          onClick={openNew}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-4 py-2.5 transition-colors cursor-pointer shadow-sm shadow-violet-200">
          <Icon.Plus className="w-4 h-4" /> Add Blank
        </button>
      </div>

      {loadError && (
        <div className="mb-4 flex items-start gap-2.5 rounded-2xl border-l-4 border-red-500 bg-red-50 p-4">
          <Icon.Alert className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-800">{loadError}</p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-400">Loading blanks…</div>
        ) : blanks.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">No blanks yet. Add the first one.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Style Code</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Brand</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">In Copy</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Garment Family</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Fit / Sleeve / Neck</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Material</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Weight</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Unisex</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Used By</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-500">Status</th>
                  <th className="text-right px-3 py-2 font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {blanks.map((b) => (
                  <tr key={b.id} className={`hover:bg-slate-50 ${!b.active ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2.5 font-mono font-semibold text-slate-800">{b.style_code || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-700">{b.brand || '—'}</td>
                    <td className="px-3 py-2.5">
                      {b.brand_in_copy
                        ? <span className="text-[10px] font-medium bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Yes</span>
                        : <span className="text-[10px] font-medium bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">No</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{b.garment_family || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600">{[b.fit, b.sleeve, b.neck].filter(Boolean).join(' / ') || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600 max-w-[220px] truncate" title={b.material || ''}>{b.material || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600 max-w-[180px] truncate" title={b.weight_note || ''}>{b.weight_note || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600">{b.unisex ? 'Yes' : '—'}</td>
                    <td className="px-3 py-2.5">
                      <span className="text-[11px] font-semibold bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">{b.usedByFamilies} famil{b.usedByFamilies === 1 ? 'y' : 'ies'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {b.active
                        ? <span className="text-[10px] font-medium bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Active</span>
                        : <span className="text-[10px] font-medium bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded">Inactive</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => openEdit(b)} title="Edit" className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer">
                          <Icon.Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => toggleActive(b)}
                          disabled={togglingId === b.id}
                          title={b.active ? 'Deactivate' : 'Reactivate'}
                          className={`p-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${b.active ? 'text-red-500 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}>
                          {togglingId === b.id ? <Icon.Loader className="w-3.5 h-3.5" /> : <Icon.Power className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add / Edit form modal ── */}
      {editing !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white rounded-t-2xl">
              <h2 className="text-sm font-bold text-slate-900">{editing === 'new' ? 'Add Blank' : `Edit "${editing.style_code}"`}</h2>
              <button onClick={closeForm} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"><Icon.X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Style Code" required>
                  <input value={form.style_code} onChange={(e) => setForm((f) => ({ ...f, style_code: e.target.value.toUpperCase() }))}
                    placeholder="e.g. 1717" className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" />
                </Field>
                <Field label="Garment Family" required>
                  <select value={form.garment_family} onChange={(e) => setForm((f) => ({ ...f, garment_family: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200 bg-white">
                    {GARMENT_FAMILIES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </Field>
              </div>

              <Field label="Match Pattern" required hint="Case-insensitive regex over the listing hay (title/SKU/attributes) — the legacy fallback when no child SKU carries this code.">
                <input value={form.match_pattern} onChange={(e) => setForm((f) => ({ ...f, match_pattern: e.target.value }))}
                  placeholder="e.g. \bcomfort\s*colors?\b" className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand">
                  <input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" />
                </Field>
                <Field label="Brand appears in customer-facing copy?">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700 mt-1">
                    <input type="checkbox" checked={form.brand_in_copy} onChange={(e) => setForm((f) => ({ ...f, brand_in_copy: e.target.checked }))} className="rounded border-slate-300" />
                    {form.brand_in_copy ? 'Yes — brand name may ship in title/copy' : 'No — the Gildan rule (facts only, brand name never in copy)'}
                  </label>
                </Field>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Fit"><input value={form.fit} onChange={(e) => setForm((f) => ({ ...f, fit: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
                <Field label="Sleeve"><input value={form.sleeve} onChange={(e) => setForm((f) => ({ ...f, sleeve: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
                <Field label="Neck"><input value={form.neck} onChange={(e) => setForm((f) => ({ ...f, neck: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
              </div>

              <Field label="Material"><input value={form.material} onChange={(e) => setForm((f) => ({ ...f, material: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
              <Field label="Weight Note" hint='e.g. "lightweight 4.5 oz ring-spun"'><input value={form.weight_note} onChange={(e) => setForm((f) => ({ ...f, weight_note: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Dye"><input value={form.dye} onChange={(e) => setForm((f) => ({ ...f, dye: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
                <Field label="Stretch"><input value={form.stretch} onChange={(e) => setForm((f) => ({ ...f, stretch: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
                <Field label="Fit to Size"><input value={form.fit_to_size} onChange={(e) => setForm((f) => ({ ...f, fit_to_size: e.target.value }))} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>
              </div>

              <Field label="Unisex sizing">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 mt-1">
                  <input type="checkbox" checked={form.unisex} onChange={(e) => setForm((f) => ({ ...f, unisex: e.target.checked }))} className="rounded border-slate-300" />
                  Cut on a unisex size chart
                </label>
              </Field>

              <Field label="Notes"><textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-200" /></Field>

              {/* ── Blast radius (design doc §5.3): required before saving an identity change ── */}
              {identityChanged && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5">
                  <div className="flex items-start gap-2.5">
                    <Icon.Alert className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-amber-800">Style code or match pattern changed — check the blast radius before saving</p>
                      {!impact && !impactError && (
                        <button onClick={runImpactPreview} disabled={impactChecking || !form.style_code.trim() || !form.match_pattern.trim()}
                          className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg px-3 py-1.5 disabled:opacity-50 transition-colors cursor-pointer">
                          {impactChecking ? <><Icon.Loader className="w-3.5 h-3.5" /> Checking…</> : 'Preview blast radius'}
                        </button>
                      )}
                      {impactError && <p className="text-xs text-red-700 mt-1.5">{impactError}</p>}
                      {impact && (
                        <div className="mt-2 text-xs text-amber-900 space-y-1">
                          <p><strong>{impact.resolvesTodayCount}</strong> famil{impact.resolvesTodayCount === 1 ? 'y' : 'ies'} resolve{impact.resolvesTodayCount === 1 ? 's' : ''} to this blank today · <strong>{impact.wouldResolveCount}</strong> famil{impact.wouldResolveCount === 1 ? 'y' : 'ies'} would resolve here after this save.</p>
                          {impact.sampleAsins.length > 0 && (
                            <p className="text-amber-800">Newly affected: {impact.sampleAsins.join(', ')}{impact.wouldResolveCount > impact.sampleAsins.length ? '…' : ''}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {saveError && <p className="text-xs text-red-600">{saveError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100 sticky bottom-0 bg-white rounded-b-2xl">
              <button onClick={closeForm} className="text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg px-4 py-2 transition-colors cursor-pointer">Cancel</button>
              <button
                onClick={doSave}
                disabled={saving || !readyToSave}
                title={identityChanged && !impact ? 'Preview the blast radius first' : undefined}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-4 py-2 disabled:opacity-50 transition-colors cursor-pointer">
                {saving ? <><Icon.Loader className="w-3.5 h-3.5" /> Saving…</> : editing === 'new' ? 'Create Blank' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-600 mb-1">{label}{required && <span className="text-red-500 ml-0.5">*</span>}</label>
      {children}
      {hint && <p className="text-[10px] text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}
