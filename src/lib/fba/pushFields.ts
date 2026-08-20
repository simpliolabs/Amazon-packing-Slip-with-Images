/**
 * pushFields — pure, side-effect-free helpers shared by the push-content route
 * and its stress test. Keeping the field math out of the route makes it unit-
 * testable without mocking Amazon or Supabase.
 *
 * Four content fields can be pushed to Amazon via patchListingsItem:
 *   - title       → item_name           (BROADCAST: one value to every child SKU)
 *   - bullets     → bullet_point[]       (BROADCAST: a 5-value array to every child)
 *   - description → product_description   (BROADCAST)
 *   - keywords    → generic_keyword       (PER-CHILD: a unique value per SKU)
 *
 * "Broadcast" = parent-level content that must be IDENTICAL across all children,
 * so the single recommended value is written to every (ASIN-deduped) child.
 * "Per-child" = each color/size gets its own string (backend search terms).
 *
 * Title is broadcast by default, but for CAPACITY variation families (SD cards 64/128/256GB)
 * the pipeline emits `per_child_titles` so each child carries its own capacity. The push route
 * uses the per-child title when present for a SKU; otherwise it falls back to the broadcast
 * recommended_title. Apparel never gets per_child_titles, so it remains broadcast.
 */

export type PushField = 'title' | 'bullets' | 'description' | 'keywords'

export const PUSH_FIELDS: PushField[] = ['title', 'bullets', 'description', 'keywords']

export interface FieldConfig {
  /** SP-API attribute name under /attributes/ */
  attribute: string
  /** true → same value to all children; false → per-child unique value */
  broadcast: boolean
  /** true → the value is a list (bullet_point); false → a single string */
  isArray: boolean
  /** human label for the UI / logs */
  label: string
  /** listing_content columns this field reads/writes for the cached "current" value */
  contentColumns: string[]
}

export const FIELD_CONFIG: Record<PushField, FieldConfig> = {
  title: {
    attribute: 'item_name',
    broadcast: true,
    isArray: false,
    label: 'Title',
    contentColumns: ['title'],
  },
  bullets: {
    attribute: 'bullet_point',
    broadcast: true,
    isArray: true,
    label: 'Bullets',
    contentColumns: ['bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5'],
  },
  description: {
    attribute: 'product_description',
    broadcast: true,
    isArray: false,
    label: 'Description',
    contentColumns: ['description'],
  },
  keywords: {
    attribute: 'generic_keyword',
    broadcast: false,
    isArray: false,
    label: 'Backend Keywords',
    contentColumns: ['backend_keywords'],
  },
}

export function isPushField(x: unknown): x is PushField {
  return typeof x === 'string' && (PUSH_FIELDS as string[]).includes(x)
}

// ─── byte helpers (keywords are byte-capped; titles/bullets/desc are char-capped) ──
export function getByteLength(str: string): number {
  return new TextEncoder().encode(str).length
}

/** Truncate to a byte budget on a word boundary (used for the 250-byte keyword cap). */
export function capBytes(str: string, maxBytes = 250): string {
  if (getByteLength(str) <= maxBytes) return str
  let lo = 0, hi = str.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (getByteLength(str.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  const cut = str.slice(0, lo)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > lo * 0.7 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * Defensive per-field caps. Amazon's VALIDATION_PREVIEW is the real gate; these
 * just keep us from sending pathological payloads. Limits mirror common apparel
 * category maxes (item_name ~200 chars, product_description ~2000, each bullet ~500,
 * generic_keyword 250 bytes).
 */
export function capForField(field: PushField, value: string): string {
  switch (field) {
    case 'keywords':    return capBytes(value.trim(), 250)
    case 'title':       return value.trim().slice(0, 200)
    case 'description': return value.trim().slice(0, 2000)
    case 'bullets':     return value.trim().slice(0, 500) // applied per-bullet
    default:            return value.trim()
  }
}

/**
 * PHASE 4 (foundation plan): the push-boundary title gate. Amazon auto-rewrites item_name over 75
 * chars (policy 2026-07-27) and Item Highlights 100476-rejects SKUs whose live title exceeds it —
 * the exact class the #81 heal loop exists to clean up AFTER the fact. This gate refuses BEFORE the
 * PATCH, so the mess is never made. REFUSE, never truncate: a mid-word slice ships garbage bytes to
 * a customer-facing field (the #81 gate at pushExecutor:1133 set this precedent for the heal path;
 * this extends it to the direct title push and the seller's manual override, which was previously
 * sliced at the generic 200 cap and sent).
 *
 * Pure and exported so it is TESTABLE — tonight's dead-code lesson: a 4-line inline check in an
 * untested 3,000-line file is where bugs hide. Returns the first offending row, or null when safe.
 */
export function titlePushBlocked(
  diff: readonly { sku: string; chars: number; changed: boolean }[],
): { sku: string; chars: number } | null {
  for (const d of diff) {
    if (d.changed && d.chars > 75) return { sku: d.sku, chars: d.chars }
  }
  return null
}

// ─── value resolution ──────────────────────────────────────────────────────────

export interface RecRow {
  recommended_title?: string | null
  recommended_bullets?: string[] | null
  recommended_description?: string | null
  /** Per-child titles for capacity variation families. When present, the push uses each
   *  child's specific title instead of the broadcast recommended_title. */
  per_child_titles?: { sku: string; asin: string; title: string }[] | null
  /** Per-design bullets for multi-design POD families (migration 033). When present, the push
   *  uses each child's design-specific bullets instead of the broadcast recommended_bullets. */
  per_child_bullets?: { sku: string; asin: string; bullets: string[] }[] | null
  /** Per-design descriptions for multi-design POD families (migration 033). When present, the push
   *  uses each child's design-specific description instead of the broadcast recommended_description. */
  per_child_descriptions?: { sku: string; asin: string; description: string }[] | null
}

/**
 * The proposed value for one SKU, capped and cleaned.
 * Broadcast fields ignore `sku` (same value for everyone). Keywords look it up
 * in `perChild`. Title checks per_child_titles first (capacity families), then falls back
 * to the broadcast recommended_title. Returns null when there's nothing to push.
 */
export function resolveProposed(
  field: PushField,
  rec: RecRow,
  perChild: Map<string, string>,
  sku: string,
): string | string[] | null {
  switch (field) {
    case 'keywords': {
      const v = perChild.get(sku)
      return v == null ? null : capBytes(v.trim(), 250)
    }
    case 'title': {
      // Prefer the SKU-specific title when the pipeline emitted per-child titles (capacity
      // families like SD cards 64/128/256GB). Apparel never gets per_child_titles, so this
      // path is only taken when the pipeline explicitly opted into per-child generation.
      const pct = Array.isArray(rec.per_child_titles) ? rec.per_child_titles.find((p) => p.sku === sku) : null
      const candidate = pct?.title ?? rec.recommended_title ?? ''
      const t = capForField('title', candidate)
      return t.length > 0 ? t : null
    }
    case 'description': {
      // Prefer the SKU-specific description when the pipeline emitted per-design descriptions
      // (multi-design POD families). Single-design/non-apparel families fall back to the broadcast
      // recommended_description.
      const pcd = Array.isArray(rec.per_child_descriptions) ? rec.per_child_descriptions.find((p) => p.sku === sku) : null
      const d = capForField('description', pcd?.description ?? rec.recommended_description ?? '')
      return d.length > 0 ? d : null
    }
    case 'bullets': {
      // Prefer the SKU-specific bullets when the pipeline emitted per-design bullets (multi-design
      // POD families). Single-design/non-apparel families fall back to the broadcast recommended_bullets.
      const pcb = Array.isArray(rec.per_child_bullets) ? rec.per_child_bullets.find((p) => p.sku === sku) : null
      const arr = Array.isArray(pcb?.bullets) ? pcb.bullets : (Array.isArray(rec.recommended_bullets) ? rec.recommended_bullets : [])
      const bullets = arr
        .map((b) => (b ?? '').trim())
        .filter((b) => b.length > 0)
        .slice(0, 5)
        .map((b) => capForField('bullets', b))
      return bullets.length > 0 ? bullets : null
    }
    default:
      return null
  }
}

/** Read one content row's current value for `field`, normalized to a string. */
export function currentValue(field: PushField, row: Record<string, unknown>): string {
  if (field === 'bullets') {
    return [row.bullet_1, row.bullet_2, row.bullet_3, row.bullet_4, row.bullet_5]
      .map((b) => (typeof b === 'string' ? b.trim() : ''))
      .filter(Boolean)
      .join('\n')
  }
  const col = FIELD_CONFIG[field].contentColumns[0]
  const v = row[col]
  return typeof v === 'string' ? v.trim() : ''
}

/** Normalize a proposed value (string or string[]) to a comparable/displayable string. */
export function asCompare(value: string | string[] | null): string {
  if (value == null) return ''
  return Array.isArray(value)
    ? value.map((v) => (v ?? '').trim()).filter(Boolean).join('\n')
    : value.trim()
}

// ─── Amazon patch body ───────────────────────────────────────────────────────────

export interface PatchValueEntry { value: string; marketplace_id: string; language_tag: string }

/**
 * Build the `value` array for a patchListingsItem /attributes/<x> replace op.
 * Single fields → one entry; bullets → one entry per non-empty bullet (order preserved).
 */
export function buildPatchValue(
  value: string | string[],
  marketplaceId: string,
  languageTag = 'en_US',
): PatchValueEntry[] {
  const vals = Array.isArray(value) ? value : [value]
  return vals
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => ({ value: v, marketplace_id: marketplaceId, language_tag: languageTag }))
}

// ─── BULK "Ship all core" ops assembly (element C — Title+Bullets+Description+Keywords in ONE PATCH) ──
// The "Ship all core" push batches the four content fields into a SINGLE patchListingsItem submission
// per child SKU (vs four field-at-a-time pushes). The body is MIXED: title/bullets/description are
// BROADCAST (the same value on every child) while keywords are PER-CHILD (each SKU its own backend
// string). buildCoreOps stays field-agnostic — the executor passes each field's OWN resolved value for
// the SKU (read from that field's loadDiff row), so the per-child-vs-broadcast distinction is already
// baked into `value` and this function just assembles the /attributes/<attr> replace ops.

/** One patchListingsItem replace op for a core field (already-resolved value → attribute path). */
export interface CorePatchOp { op: 'replace'; path: string; value: PatchValueEntry[] }

/** A single (core field, resolved value) pair for ONE sku — as gathered from that field's loadDiff row.
 *  `value` is a string for title/description/keywords and a string[] for bullets; it is expected to be
 *  trademark-scrubbed by the caller (mirrors executePush's scrub-at-push). `isParent` is a defensive
 *  flag: `keywords` (generic_keyword) must NEVER be built for the non-buyable variation parent, which
 *  carries no per-child backend terms. */
export interface CoreFieldRow {
  field: PushField
  value: string | string[]
  isParent?: boolean
}

/**
 * PURE, deterministic ops assembly for a bulk "Ship all core" push of ONE sku. Each changed field
 * becomes exactly one `/attributes/<attribute>` replace op carrying that field's own resolved value.
 * The mixed broadcast/per-child body is driven entirely by which rows the caller passes (the caller
 * reads each field's own per-SKU loadDiff row), so this function never needs to know the difference.
 * Throws if asked to build `generic_keyword` for the variation parent — a guaranteed-impossible state
 * (the parent is dropped from the SKU set upstream) that we assert anyway so a future caller can't
 * silently regress it.
 */
export function buildCoreOps(perSkuFieldRows: CoreFieldRow[], marketplaceId: string): CorePatchOp[] {
  const ops: CorePatchOp[] = []
  for (const r of perSkuFieldRows) {
    if (r.field === 'keywords' && r.isParent) {
      throw new Error('buildCoreOps: generic_keyword must never be built for the variation parent')
    }
    ops.push({
      op: 'replace',
      path: `/attributes/${FIELD_CONFIG[r.field].attribute}`,
      value: buildPatchValue(r.value, marketplaceId),
    })
  }
  return ops
}

// ─── ASIN dedup (FBA+FBM SKUs share one child ASIN → push once, prefer -FBA) ──────

export function dedupByAsin<T extends { sku: string; asin: string }>(rows: T[]): T[] {
  const byAsin = new Map<string, T>()
  for (const r of rows) {
    const existing = byAsin.get(r.asin)
    if (!existing || r.sku.endsWith('-FBA')) byAsin.set(r.asin, r)
  }
  return [...byAsin.values()].sort((a, b) => a.sku.localeCompare(b.sku))
}

// ─── SHIP-TRUTH DERIVATION (2026-07-09, approach A — PO-approved foundational fix) ──────────────
// The EDIT ONCE cards used to render frozen action_plan snapshot fields (verdict/current_status/
// replacement_content) written by FOUR different writers and read long after the underlying
// recommended_* columns moved on — the root of every "shipped but still red" / "card shows a
// different description than the ship modal" bug. From now on those three fields are DERIVED at
// serve time by deriveActionPlan below: displayed content := the SAME resolved value the ship
// modal pushes (resolveProposed semantics — physical adjacency in this file is the guarantee), and
// verdict := does every cached live child match its per-SKU resolved recommendation. The stored
// action_plan remains ADVISORY only (instruction/priority/seo_impact/notes — the audit's voice).
// Closed loop for free: a regen changes recommended_* → cards un-DONE; push write-through +
// heal-on-verify update listing_content → cards green. No stamps, no writers, no drift.

// Strip Amazon's appended variant dimensions (" - Light Green - XX-Large") so title comparisons
// use the seller's BASE title, not a child's suffixed one. (Moved from page.tsx — the deriver is
// server-side and the client imports THIS copy; risk-check BLOCKER: without it every variation
// child reads permanently REPLACE.)
// SIZE_TOKEN covers Amazon's size names incl. "3X-Large".."6X-Large"; the color segment may start
// with a digit ("90s Retro") — both gaps found by direct regex testing in the adversarial pass.
const SIZE_TOKEN = "(?:XS|S|M|L|XL|XXL|XXXL|[2-5]XL|[2-6]X-?Large|X-?Small|XX?X?-?Large|Small|Medium|Large|One[ -]?Size)"
export function stripVariantSuffix(title: string | null | undefined): string {
  return (title ?? '')
    .replace(new RegExp(`\\s*[-–—|]\\s*[A-Za-z0-9][\\w /&'-]*?\\s*[-–—|]\\s*${SIZE_TOKEN}\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—|]\\s*${SIZE_TOKEN}\\s*$`, 'i'), '')
    .trim()
}

/** THE comparator — extracted from verify-push (route ~353-356) so cards, cohesion, and verify all
 *  judge "matches" identically: exact-trim first, then lowercase + strip non-alphanumerics (a
 *  correctly-applied value must never read stale over case/punctuation). */
export function squashEquals(live: string, expected: string): boolean {
  if (!expected) return false
  return live.trim() === expected.trim() ||
    live.toLowerCase().replace(/[^a-z0-9]/g, '') === expected.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** listing_content row shape the deriver needs (the 9 content columns + identity). */
export interface DeriveContentRow {
  sku: string
  asin: string
  title?: string | null
  bullet_1?: string | null; bullet_2?: string | null; bullet_3?: string | null
  bullet_4?: string | null; bullet_5?: string | null
  description?: string | null
  backend_keywords?: string | null
}

type PlanItem = Record<string, unknown>

const CORE_ELEMENT_ORDER = ['title', 'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5', 'description', 'backend_keywords']

/**
 * Derive the EDIT ONCE plan from live truth. Pure. Rules (risk-checked 2026-07-09):
 * - Compare PER SKU via resolveProposed (multi-design/capacity families ship per-child values —
 *   comparing the broadcast against every child would read permanently REPLACE).
 * - contentRows are ASIN-deduped first (FBA/FBM twins share content; per_child_* maps are keyed
 *   to the FBA-preferred dedup set the pipeline generated for).
 * - Keywords come from the recommended_keywords JSON TEXT column (resolveProposed only reads the
 *   passed map) — matched by sku, falling back to asin.
 * - Title: cached child titles are variant-suffixed → stripVariantSuffix before compare; an EMPTY
 *   cached child title with a non-empty recommendation is INHERITED (= match), same as verify-push.
 * - DONE requires ≥1 actually-compared child (vacuous all-match on zero rows stays REPLACE).
 * - Stored SKIP verdicts are preserved verbatim (advisory "no change needed" may carry no content).
 * - Advisory fields (instruction/priority/seo_impact/notes) pass through from the stored item;
 *   non-core items (aplus_modules, brand_story, product_details, images…) pass through untouched.
 */
export function deriveActionPlan(
  rec: RecRow & { recommended_keywords?: string | null; action_plan?: unknown },
  contentRows: DeriveContentRow[],
  /** #175 (PO 2026-08-20: "each time I ship, a different item goes RED — very confusing"): the
   *  Amazon Catalog read-back lags an accepted push by 15min-6hr, so a mismatch right after a Ship
   *  is EXPECTED, not a defect. When the element's field has an accepted push that is (a) NEWER
   *  than the recommendation (so the mismatch can't mean "new rec not shipped yet") and (b) within
   *  the 6h propagation window, the verdict is PROPAGATING (amber), never a false RED. Serve-time
   *  only — the persist paths derive right after a regen, where the rec is always newer. */
  shipSignals?: { pushedAt: Record<string, string>; generatedAt?: string | null },
): PlanItem[] {
  const rows = dedupByAsin(contentRows.filter((r) => r && r.sku && r.asin))
  const stored: PlanItem[] = Array.isArray(rec.action_plan) ? (rec.action_plan as PlanItem[]) : []
  const storedByEl = new Map<string, PlanItem>()
  for (const it of stored) { const el = String(it?.element ?? ''); if (el && !storedByEl.has(el)) storedByEl.set(el, it) }

  // Keywords map (sku + asin keyed) from the TEXT JSON column.
  const kwBySku = new Map<string, string>()
  const kwByAsin = new Map<string, string>()
  try {
    const parsed = JSON.parse(String(rec.recommended_keywords ?? '[]')) as { sku?: string; asin?: string; keywords?: string }[]
    if (Array.isArray(parsed)) for (const e of parsed) {
      if (e?.keywords) { if (e.sku) kwBySku.set(e.sku, e.keywords); if (e.asin) kwByAsin.set(e.asin, e.keywords) }
    }
  } catch { /* unparsable legacy string — keywords card falls back to stored advisory item */ }
  const kwFor = (r: DeriveContentRow) => kwBySku.get(r.sku) ?? kwByAsin.get(r.asin)

  // Per-element: the DISPLAYED value + the per-SKU expected/cached pair. EVERY expected value goes
  // through resolveProposed (adversarial MAJOR: comparing the RAW rec against a cache holding the
  // CAPPED+COMPACTED pushed value re-created modal-vs-card drift inside the deriver itself).
  // Tokenized compare for keywords (space-separated soup: 'grand pa' ≠ 'grandpa' for Amazon, but the
  // squash fallback would equate them); squashEquals for prose fields.
  const kwCompare = (a: string, b: string): boolean => {
    const t = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ')
    return t(a) === t(b)
  }
  const elements: { element: string; display: string; pair: (r: DeriveContentRow) => { expected: string; cached: string; kw?: boolean } | null }[] = []
  const title = (rec.recommended_title ?? '').trim()
  if (title) elements.push({
    element: 'title', display: title,
    pair: (r) => {
      const exp = resolveProposed('title', rec, new Map(), r.sku)
      if (exp == null) return null
      return { expected: asCompare(exp), cached: stripVariantSuffix(r.title) }
    },
  })
  // Bullets derive from the COMPACTED resolved array (adversarial: the push filters empties and
  // writes the compacted list to bullet_1..N — positional derive from the raw array desyncs on any
  // mid-array empty). Display = the broadcast resolved bullets; compare = each row's own resolved set.
  const displayBullets = (resolveProposed('bullets', rec, new Map(), rows[0]?.sku ?? '') as string[] | null) ?? []
  displayBullets.forEach((bl, i) => {
    const col = `bullet_${i + 1}` as keyof DeriveContentRow
    elements.push({
      element: `bullet_${i + 1}`, display: bl,
      pair: (r) => {
        const arr = resolveProposed('bullets', rec, new Map(), r.sku) as string[] | null
        const exp = (arr?.[i] ?? '').trim()
        if (!exp) return null
        return { expected: exp, cached: typeof r[col] === 'string' ? (r[col] as string) : '' }
      },
    })
  })
  const desc = (rec.recommended_description ?? '').trim()
  if (desc) elements.push({
    element: 'description', display: desc,
    pair: (r) => {
      const exp = resolveProposed('description', rec, new Map(), r.sku)
      if (exp == null) return null
      return { expected: asCompare(exp), cached: r.description ?? '' }
    },
  })
  const kwDisplay = kwBySku.size > 0 ? [...kwBySku.values()][0] : (kwByAsin.size > 0 ? [...kwByAsin.values()][0] : '')
  if (kwDisplay) elements.push({
    element: 'backend_keywords', display: kwDisplay,
    pair: (r) => {
      const raw = kwFor(r)
      if (!raw?.trim()) return null
      // Same cap the push applies (resolveProposed 'keywords' case) — cap parity.
      return { expected: capBytes(raw.trim(), 250), cached: r.backend_keywords ?? '', kw: true }
    },
  })

  const derivedByEl = new Map<string, PlanItem>()
  for (const el of elements) {
    const prior = storedByEl.get(el.element)
    // Stored SKIP = the audit's deliberate "no change needed" — preserve verbatim.
    if (prior && String(prior.verdict ?? '') === 'SKIP') { derivedByEl.set(el.element, prior); continue }
    let compared = 0
    let allMatch = true
    for (const r of rows) {
      const p = el.pair(r)
      if (!p) continue
      // EMPTY CACHE = NOT COMPARED (adversarial: the push deliberately skips offerless/backfilled
      // blank rows — #242/#250 — so an empty cached field must neither block DONE forever nor count
      // as an "inherited" match; verify-push's inherited rule applies to LIVE reads, not the cache).
      if (p.cached.trim().length === 0) continue
      compared++
      const match = p.kw ? kwCompare(p.cached, p.expected) : squashEquals(p.cached, p.expected)
      if (!match) allMatch = false
    }
    const done = compared >= 1 && allMatch
    const label = el.element === 'backend_keywords' ? 'backend keywords' : el.element.replace('_', ' ')
    // Advisory inheritance is CONFLICT-SAFE (adversarial MAJOR): instruction/priority stamped for a
    // DIFFERENT verdict (cooling's "measuring — locked", sectionOptimal's "already strong") must not
    // ride under a contradicting derived verdict. Keep notes/seo_impact always; keep instruction/
    // priority only when the stored verdict agrees with the derived one.
    let derivedVerdict = done ? 'DONE' : 'REPLACE'
    let propagatingSince: string | null = null
    if (derivedVerdict === 'REPLACE' && shipSignals?.pushedAt) {
      const pushField = el.element === 'title' ? 'title'
        : el.element.startsWith('bullet') ? 'bullets'
        : el.element === 'description' ? 'description'
        : el.element === 'keywords' || el.element === 'backend_keywords' ? 'keywords'
        : null
      const pushedAtStr = pushField ? shipSignals.pushedAt[pushField] : undefined
      if (pushedAtStr) {
        const pushed = new Date(pushedAtStr).getTime()
        const gen = shipSignals.generatedAt ? new Date(shipSignals.generatedAt).getTime() : 0
        const PROPAGATION_WINDOW_MS = 6 * 3600 * 1000
        if (Number.isFinite(pushed) && pushed > gen && Date.now() - pushed < PROPAGATION_WINDOW_MS) {
          derivedVerdict = 'PROPAGATING'
          propagatingSince = pushedAtStr
        }
      }
    }
    const priorAgrees = prior != null && String(prior.verdict ?? '') === derivedVerdict
    const advisory: PlanItem = prior
      ? (priorAgrees ? { ...prior } : Object.fromEntries(Object.entries(prior).filter(([k]) => k !== 'instruction' && k !== 'priority')))
      : {}
    const minsAgo = propagatingSince ? Math.max(1, Math.round((Date.now() - new Date(propagatingSince).getTime()) / 60000)) : 0
    derivedByEl.set(el.element, {
      priority: derivedVerdict === 'DONE' || derivedVerdict === 'PROPAGATING' ? 'NONE' : 'MEDIUM',
      instruction: derivedVerdict === 'DONE'
        ? 'No action required — the live content already matches. The copy box stays below if you need it.'
        : derivedVerdict === 'PROPAGATING'
          ? 'No action needed — Amazon accepted this push and is still applying it. Re-check after propagation; do NOT re-ship.'
          : 'Ship the recommended version below so every variant matches.',
      ...advisory,
      element: el.element,
      verdict: derivedVerdict,
      current_status: done
        ? `Live ${label} matches the recommended version across all ${compared} cached variant${compared === 1 ? '' : 's'}.`
        : derivedVerdict === 'PROPAGATING'
          ? `Accepted by Amazon ${minsAgo}m ago — propagating (variation families can take up to 6 hours). The cached read still shows the pre-push value; this is expected, not a failure.`
          : compared === 0
            ? `No cached variant content to compare yet — sync or push to establish live state.`
            : `Your live ${label} differs from the recommended version below.`,
      replacement_content: el.display,
    })
  }

  // Assemble: core elements in canonical order, then every non-core stored item untouched, in order.
  const out: PlanItem[] = []
  for (const elName of CORE_ELEMENT_ORDER) { const d = derivedByEl.get(elName); if (d) out.push(d) }
  for (const it of stored) {
    const el = String(it?.element ?? '')
    if (!CORE_ELEMENT_ORDER.includes(el)) out.push(it)
    else if (!derivedByEl.has(el)) out.push(it)  // core element with no derivable content (e.g. SKIP with empty columns)
  }
  return out
}

// ─── cache-sync payload (what to write back to listing_content after a live push) ──

/** Map a pushed value to the listing_content column update for that field. */
export function cacheUpdateFor(field: PushField, value: string | string[]): Record<string, string | null> {
  if (field === 'bullets') {
    const arr = Array.isArray(value) ? value : [value]
    const out: Record<string, string | null> = {}
    for (let i = 0; i < 5; i++) out[`bullet_${i + 1}`] = arr[i] ?? null
    return out
  }
  const col = FIELD_CONFIG[field].contentColumns[0]
  return { [col]: Array.isArray(value) ? value.join('\n') : value }
}
