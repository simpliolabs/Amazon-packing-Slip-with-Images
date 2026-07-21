All anchors verified against live code. Here is the implementation plan.

---

# Self-Healing Item Highlights (`title_differentiation`) — Implementation Plan

**Goal:** Replace the hardcoded `2026-07-27` write-gate on Amazon's Item Highlights attribute with a persisted probe flag. A `VALIDATION_PREVIEW` (never a live write) classifies `accepted` vs `"currently unsupported"`, persists `{supported, probed_at}` in `app_settings`, and drives `isWriteBlockedPreLaunch`. The July-27 date remains only as the fallback when never probed.

**Design invariant:** one marketplace-wide flag (not per-ASIN); tri-state (`true`/`false`/`null`); `null`→date fallback; transient errors never flip the flag; `isWriteBlockedPreLaunch` stays a **pure synchronous** function — the async DB read happens once per request in each caller and is threaded in.

All paths are `C:/Users/Admin/AppData/Local/Temp/fba-portal/…`.

---

## File 1 — `src/lib/fba/productDetailAttrs.ts`

Current state: `isWriteBlockedPreLaunch` at **lines 173–178**, pure/sync, date-gated at line 174; `buildDetailPatchValue` at lines 155–165 returns `[{value, marketplace_id, language_tag:'en_US'}]` (empty `[]` for blank input — line 162).

### 1a. Add the field-identity helper (extract the duplicated matcher)

Insert **above** `isWriteBlockedPreLaunch` (before line 173):

```ts
/** True when (fieldName, spApiKey) names Amazon's Item Highlights attribute
 *  (schema key `title_differentiation`, docs key `item_highlights`, display "Item Highlight(s)").
 *  Single source of truth — server gate, client Auto-Push filter, and both push hooks all call this. */
export function isItemHighlightsField(
  fieldName: string | null | undefined,
  spApiKey: string | null | undefined,
): boolean {
  if (spApiKey === 'title_differentiation' || spApiKey === 'item_highlights') return true
  const f = (fieldName ?? '').toLowerCase().replace(/[\s_-]+/g, '')
  return f === 'itemhighlight' || f === 'itemhighlights' || f === 'titledifferentiation'
}
```

### 1b. Add the persisted-state type + app_settings helpers

`SupabaseClient` is already available in this module's ecosystem; import the type if not present: `import type { SupabaseClient } from '@supabase/supabase-js'`. Insert after the helpers:

```ts
export const ITEM_HIGHLIGHTS_STATE_KEY = 'item_highlights_api_state'

/** Persisted probe result. `supported` is the marketplace-wide verdict; `probed_at` throttles refresh. */
export interface ItemHighlightsApiState { supported: boolean; probed_at: string } // probed_at = ISO

/** READ — mirrors the single-key app_settings pattern (familyReconcile.ts:81 / getSellerId).
 *  Returns null when never probed OR on any parse/read failure (→ date fallback). Never throws. */
export async function getItemHighlightsApiState(
  db: SupabaseClient,
): Promise<ItemHighlightsApiState | null> {
  try {
    const { data } = await db
      .from('app_settings').select('value')
      .eq('key', ITEM_HIGHLIGHTS_STATE_KEY).maybeSingle()
    const raw = (data as { value?: string } | null)?.value
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.supported === 'boolean'
      ? { supported: parsed.supported, probed_at: parsed.probed_at ?? new Date().toISOString() }
      : null
  } catch { return null }
}

/** WRITE — mirrors openai/credentials/route.ts:78 upsert with explicit onConflict. Best-effort. */
export async function setItemHighlightsApiState(
  db: SupabaseClient,
  supported: boolean,
): Promise<void> {
  const now = new Date().toISOString()
  try {
    await db.from('app_settings').upsert(
      { key: ITEM_HIGHLIGHTS_STATE_KEY, value: JSON.stringify({ supported, probed_at: now }), updated_at: now } as never,
      { onConflict: 'key' },
    )
  } catch (e) {
    console.warn('[item-highlights] state write failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}
```

> `as never` (or `as any` per repo convention at openai/credentials/route.ts:78) is required because the generated `app_settings` Row type has non-nullable columns the upsert omits. `value` is a plain string column (`src/types/database.ts:169-171`) — hence `JSON.stringify`/`JSON.parse`.

### 1c. Rewrite `isWriteBlockedPreLaunch` (lines 173–178) — flag-driven, field-match FIRST

**Guard-order flip is mandatory.** Today the function early-returns `false` on/after the date *before* the field match. To let the probe flag override the date **in both directions**, the field match must come first.

Replace lines 173–178 with:

```ts
/** apiSupported (the persisted probe verdict):
 *    true  → Amazon accepts writes → NEVER block (even before July 27).
 *    false → "currently unsupported" → BLOCK (even after July 27).
 *    null / undefined → never probed → fall back to the July-27-2026 launch date. */
export function isWriteBlockedPreLaunch(
  fieldName: string | null | undefined,
  spApiKey: string | null | undefined,
  now = new Date(),
  opts?: { apiSupported?: boolean | null },
): boolean {
  if (!isItemHighlightsField(fieldName, spApiKey)) return false
  const flag = opts?.apiSupported
  if (flag === true) return false          // probe says writable → never block
  if (flag === false) return true          // probe says unsupported → block regardless of date
  return now < new Date('2026-07-27T00:00:00Z')   // never probed → legacy date fallback
}
```

Existing callers that pass only `(field, spApiKey)` keep compiling (the 4th arg is optional) and get pure date-fallback behavior until wired in Files 2–3.

### 1d. Add the probe function `probeItemHighlightsWritable`

**Placement decision:** the probe needs `patchSkuDetail`, `ENDPOINT`, `MARKETPLACE_ID`, `getAccessToken`, `getSellerId`, `tryGetProductType`, `discoverSkusForAsin` — all currently **module-private/local to `pushExecutor.ts`**. Put the probe **in `pushExecutor.ts`** (File 6) to reuse them, and re-export it. Keep only the *classification-independent* pieces here. (See File 6 §6c for the probe body.) In this file, add nothing further for the probe itself — `productDetailAttrs.ts` owns only the pure gate + state helpers.

---

## File 2 — `src/lib/sync/syncListingContent.ts` (Consumer 1: scorer docking)

Current: `fetchScoringContext` computes `productDetailsGaps` at lines 580–583 calling `isWriteBlockedPreLaunch(p.field_name, p.sp_api_key)`; reads `brand_name` from `app_settings` at lines 612–617 (same function, `supabase` in scope). Import already present (line 42).

### 2a. Read the flag once, near the top of the product-details block

Immediately **before** line 580 (inside the `if (Array.isArray(pdi))` block), add:

```ts
        const ihState = await getItemHighlightsApiState(supabase)
        maybeRefreshItemHighlightsProbe(supabase, ihState)   // lazy throttle — File 5, fire-and-forget
```

### 2b. Thread `apiSupported` into the filter (lines 580–583)

```ts
        ctx.productDetailsGaps = pdi.filter((p: { field_name?: string; sp_api_key?: string; current_value?: unknown; is_enum?: boolean; enum_valid?: boolean }) =>
          !isWriteBlockedPreLaunch(p.field_name, p.sp_api_key, new Date(), { apiSupported: ihState?.supported ?? null }) &&
          (isEmpty(p.current_value) || (p.is_enum === true && p.enum_valid === false)),
        ).length
```

### 2c. Update the import at line 42

Add `getItemHighlightsApiState` (and `maybeRefreshItemHighlightsProbe` from wherever File 5 lands — see note) to the existing `from '@/lib/fba/productDetailAttrs'` import.

---

## File 3 — `src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`

Two edits: Consumer 2 (regen re-score, lines 950–959) and the GET response (client flag, lines 1489–1512). `supabase = getAdminSupabase()` is in scope at both (regen block and GET at ~line 1368).

### 3a. Consumer 2 — regen re-score (lines 950–959)

The dynamic import at line 951 must also pull the state helper and pass the flag, so THIS regen's score matches the next sync (the #85 no-flip-flop invariant — both read the same `app_settings` row):

```ts
            if (Array.isArray(result.product_details_improvements)) {
              const { isWriteBlockedPreLaunch, getItemHighlightsApiState } = await import('@/lib/fba/productDetailAttrs')
              const ihState = await getItemHighlightsApiState(supabase)
              const isEmpty = (v: string | null) => !v || !String(v).trim()
              ctx.productDetailsGaps = result.product_details_improvements.filter((p) =>
                !isWriteBlockedPreLaunch(p.field_name, (p as unknown as { sp_api_key?: string }).sp_api_key, new Date(), { apiSupported: ihState?.supported ?? null }) &&
                (isEmpty(p.current_value) || (p.is_enum === true && p.enum_valid === false)),
              ).length
            }
```

### 3b. GET — expose `item_highlights_writable` to the client (lines 1489–1512)

The `bulkEligibleDetails` filter reads `aiRecs`, which is populated by THIS GET. Compute the single boolean server-side so the client needs **zero** date logic. Insert just **before** the `return NextResponse.json({...})` at line 1489:

```ts
  const { getItemHighlightsApiState: _getIhState, isWriteBlockedPreLaunch: _isBlocked } = await import('@/lib/fba/productDetailAttrs')
  const ihState = await _getIhState(supabase)
  // Single source of truth incl. the date fallback: writable == "not blocked for the IH field".
  const item_highlights_writable =
    _isBlocked('item_highlights', 'title_differentiation', new Date(), { apiSupported: ihState?.supported ?? null }) === false
```

(If `isWriteBlockedPreLaunch` / `getItemHighlightsApiState` are already statically imported at the top of the route, use the static symbols and drop the dynamic import.)

Then add the field into the returned `recommendations` object, alongside `field_pushed_at` at line 1506:

```ts
      field_pushed_at,
      item_highlights_writable,    // ← NEW: server-probed marketplace flag (undefined on legacy → client treats as blocked)
```

---

## File 4 — `src/app/fba/listing/[asin]/page.tsx` (Consumer 3: client Auto-Push filter)

Current: `AiRecommendations` interface ~lines 87–106 (`field_pushed_at?` at 105); `bulkEligibleDetails` at 1565–1578 with the inline date+regex check at **line 1576**.

### 4a. Add the flag to the interface (near line 105)

```ts
  /** Server-probed: Amazon's Listings API currently accepts title_differentiation writes.
   *  Undefined on legacy responses → client treats Item Highlights as still write-blocked. */
  item_highlights_writable?: boolean
```

### 4b. Rewire `bulkEligibleDetails` (line 1576) — drop the inline date+regex

Replace line 1576 (the `!((/title_differentiation.../).test... Date.now() < Date.parse('2026-07-27...'))` clause) with a read of the server flag. Import `isItemHighlightsField` from `@/lib/fba/productDetailAttrs` (shared matcher — no re-inlined regex):

```ts
  const bulkEligibleDetails = useMemo(() => {
    const rows = aiRecs?.product_details_improvements ?? []
    const ihWritable = aiRecs?.item_highlights_writable   // boolean | undefined
    return rows.filter((pd) =>
      (pd.pushable ?? isPushableDetail(pd.field_name)) &&
      pd.enum_valid !== false &&
      (pd.recommended_value ?? '').trim() !== '' &&
      (pd.current_value ?? '').trim() !== pd.recommended_value.trim() &&
      // Item Highlights: excluded from Auto Push while Amazon's API refuses writes. Driven by the
      // server probe flag (item_highlights_writable), NOT a hardcoded date. undefined (legacy GET)
      // → treat as blocked so old cached responses stay safe.
      !(isItemHighlightsField(pd.field_name, pd.sp_api_key) && ihWritable !== true),
    )
  }, [aiRecs])
```

> `ihWritable !== true` is the safe tri-state read: only an explicit `true` unblocks; `undefined` and `false` both keep it excluded.

---

## File 5 — The trigger (lazy-throttled probe, no new scheduler dependency)

**Decision:** primary trigger is a **lazy >24h throttle on the read path** (matches the repo's on-demand/self-healing convention; avoids the Coolify manual-cron-wiring dependency that a new `vercel.json` entry would incur — a new cron endpoint stays dead until the PO wires an external scheduler with `x-cron-secret`).

Add to `src/lib/fba/pushExecutor.ts` (co-located with the probe, File 6), exported:

```ts
const IH_PROBE_THROTTLE_MS = 24 * 60 * 60 * 1000

/** Fire-and-forget daily refresh of the Item Highlights flag. Never blocks the caller,
 *  never throws, never overwrites a good flag on a transient/inconclusive result. */
export function maybeRefreshItemHighlightsProbe(
  db: SupabaseClient,
  state: ItemHighlightsApiState | null,
): void {
  const fresh = state && (Date.now() - Date.parse(state.probed_at)) < IH_PROBE_THROTTLE_MS
  if (fresh) return
  void (async () => {
    try {
      const verdict = await probeItemHighlightsWritable()      // 'supported' | 'blocked' | 'unknown'
      if (verdict === 'supported') await setItemHighlightsApiState(db, true)
      else if (verdict === 'blocked') await setItemHighlightsApiState(db, false)
      // 'unknown' → leave the last-known flag untouched (transient/no-productType/HTTP)
    } catch { /* best-effort */ }
  })()
}
```

Call sites (both already read `state` per request):
- **`syncListingContent.ts`** — added in §2a.
- **`ai-recommendations/route.ts` GET** — add `maybeRefreshItemHighlightsProbe(supabase, ihState)` right after the §3b `getItemHighlightsApiState` read (fire-and-forget; the GET returns the current/last-known flag this request, the refresh lands for the next).

> **Optional zero-wiring cron alternative** (if the PO later wants a scheduled refresh without a new endpoint): call `maybeRefreshItemHighlightsProbe(db, await getItemHighlightsApiState(db))` once at the top of the already-external-scheduled `src/app/api/fba/cron-verify-pushes/route.ts` GET. The >24h throttle guarantees at most one probe/day. Do **not** add a new `/api/fba/cron-probe-*` endpoint — it would be dead until manually wired on Coolify.

---

## File 6 — `src/lib/fba/pushExecutor.ts` (probe + belt-and-suspenders hooks)

`patchSkuDetail` at 951–981; `ENDPOINT`/`MARKETPLACE_ID` exported at 82–83; `getSellerId` at 200; `tryGetProductType` imported at line 66; `discoverSkusForAsin` module-private at 287; `getAccessToken` imported at 34; `createAdminClient` imported at line 19. Push hook A at 2762–2773 (classifier line 2766), hook B at 3468–3472 (classifier line 3469).

### 6a. Imports

Add to the existing `@/lib/fba/productDetailAttrs` import: `getItemHighlightsApiState, setItemHighlightsApiState, isItemHighlightsField, type ItemHighlightsApiState`. Add `DetailAttribute` type if not already imported. Ensure `SupabaseClient` type is importable for §5/§6c signatures.

### 6b. Export `discoverSkusForAsin` (line 287)

Change `async function discoverSkusForAsin(` → `export async function discoverSkusForAsin(` so the probe can confirm liveness. (Alternatively inline the same `identifiers=<ASIN>&includedData=summaries` GET; exporting is cleaner.)

### 6c. Add `probeItemHighlightsWritable`

```ts
/** Probe whether Amazon currently accepts Listings-API writes to title_differentiation
 *  (Item Highlights) for a representative LIVE SKU — WITHOUT writing (VALIDATION_PREVIEW only).
 *    'supported' → preview.ok (Amazon validated the write clean)
 *    'blocked'   → preview failed AND joined error matches /currently unsupported/i
 *    'unknown'   → no live SKU, no productType, HTTP transport failure, or any other rejection
 *                  (do NOT persist as blocked — a transient blip must never flip the flag). */
export async function probeItemHighlightsWritable(): Promise<'supported' | 'blocked' | 'unknown'> {
  try {
    const sellerId = await getSellerId()
    const token = await getAccessToken()
    const db = createAdminClient()

    // Pick ONE confirmed-live child SKU (marketplace-wide flag → any live SKU answers the question).
    const { data: rows } = await db
      .from('listing_content').select('sku, asin').limit(200)
    const candidates = dedupByAsin((rows ?? []) as { sku: string; asin: string }[])
    let liveSku: string | null = null
    for (const c of candidates) {
      const skus = await discoverSkusForAsin(sellerId, token, c.asin)   // null=failed, []=offerless, [..]=live
      if (skus && skus.length > 0) { liveSku = skus[0]; break }
    }
    if (!liveSku) return 'unknown'                       // no confirmed-live SKU → inconclusive

    const productType = await tryGetProductType(sellerId, token, liveSku)
    if (!productType) return 'unknown'                   // wrong-schema preview is meaningless (#244/#245 trap)

    const attribute: DetailAttribute = { spApiKey: 'title_differentiation', scope: 'broadcast' }
    // Benign, non-empty free-text highlight (≤125 chars). Content is irrelevant — Amazon returns
    // "currently unsupported" BEFORE value validation; the flat buildDetailPatchValue shape suffices.
    const probeValue = 'Everyday comfort and a clean, versatile look that pairs easily with the rest of your wardrobe.'
    const preview = await patchSkuDetail(sellerId, token, productType, liveSku, attribute, probeValue, 'VALIDATION_PREVIEW')

    if (preview.ok) return 'supported'
    if (/^HTTP \d+:/.test(preview.error ?? '')) return 'unknown'          // transport wrapper — not a verdict
    if (preview.error && /currently unsupported/i.test(preview.error)) return 'blocked'
    return 'unknown'                                     // some OTHER validation error — don't flip the flag
  } catch { return 'unknown' }
}
```

> `dedupByAsin` is imported from `@/lib/fba/pushFields` (line 219 there). The `!/^HTTP \d+:/` guard mirrors `healEvidence.ts` — an HTTP 4xx/5xx whose body echoes "unsupported" must classify as `unknown`, never `blocked`.

### 6d. Belt-and-suspenders — Hook A (single-detail push, lines 2762–2773)

Inside the `if (!preview.ok)` block, **after** `friendlyErr` is computed (line 2766–2768), add a guarded flag write:

```ts
              if (isItemHighlightsField(ctx.attribute.spApiKey, ctx.attribute.spApiKey) &&
                  preview.error && /currently unsupported/i.test(preview.error)) {
                void setItemHighlightsApiState(createAdminClient(), false)   // self-heal → blocked
              }
```

And on a **live accept** of an Item Highlights attribute (after line 2776, `status === 'accepted'`):

```ts
            if (live.ok && isItemHighlightsField(ctx.attribute.spApiKey, ctx.attribute.spApiKey)) {
              void setItemHighlightsApiState(createAdminClient(), true)      // self-heal → writable
            }
```

> Pass `ctx.attribute.spApiKey` as both args to `isItemHighlightsField` (it also matches on `spApiKey`), or `(null, ctx.attribute.spApiKey)`. Guard is mandatory — a generic "currently unsupported" on some *other* attribute must never touch the IH flag.

### 6e. Belt-and-suspenders — Hook B (bulk per-field fallback, lines 3468–3472)

Inside the `if (!preview.ok)` block after `friendly` (line 3469–3471):

```ts
      if (isItemHighlightsField(p.attribute.spApiKey, p.attribute.spApiKey) &&
          preview.error && /currently unsupported/i.test(preview.error)) {
        void setItemHighlightsApiState(createAdminClient(), false)
      }
```

Optionally mirror the accept path after line 3475 (`if (live.ok && isItemHighlightsField(...)) setItemHighlightsApiState(..., true)`).

---

## File 7 — One-off LIVE TEST plan (post-deploy, on the SHIRT category)

Run **after** the Coolify deploy is *Published* (verify `buildCommit` in `/api/health` advanced past deploy start — the Manus two-step; staged ≠ live).

1. **Trigger the probe directly** (bypasses the 24h throttle for the first run). Add a temporary authenticated debug branch or run in a one-off script against prod env:
   ```ts
   import { probeItemHighlightsWritable } from '@/lib/fba/pushExecutor'
   import { getItemHighlightsApiState, setItemHighlightsApiState } from '@/lib/fba/productDetailAttrs'
   import { createAdminClient } from '@/lib/supabase/admin'
   const verdict = await probeItemHighlightsWritable()   // expect 'blocked' today (0/10 on B0F86LPSHZ 2026-06-11)
   const db = createAdminClient()
   if (verdict === 'supported') await setItemHighlightsApiState(db, true)
   else if (verdict === 'blocked') await setItemHighlightsApiState(db, false)
   console.log('[IH probe]', verdict)
   ```
   The probe self-selects a live SHIRT SKU via `discoverSkusForAsin` — no ASIN needed. To pin it to their known SHIRT test ASIN (e.g. `B0F86LPSHZ`), temporarily hardcode the candidate ASIN in the loop for this run.

2. **Read `app_settings` to confirm persistence:**
   ```sql
   select key, value, updated_at from app_settings where key = 'item_highlights_api_state';
   -- expect: {"supported":false,"probed_at":"2026-07-15T..."}  (blocked today)
   ```

3. **Confirm the gate honors it:** load a SHIRT listing page → the ai-recs GET returns `item_highlights_writable: false` → Item Highlights stays excluded from Auto Push (`bulkEligibleDetails`), and an empty Item Highlight does **not** dock Features. Confirm the single-field card still shows the generated value for copy/planning.

4. **Acceptance for the flip (future, once Amazon opens writes):** re-run step 1; when the probe returns `supported`, `value` becomes `{"supported":true,...}`; the field then docks + Auto-Pushes with **no code change and no date dependency**. Verify one real detail push of `title_differentiation` returns `accepted` (belt-and-suspenders §6d will also stamp `true`).

**Rollback:** delete the `app_settings` row (`delete from app_settings where key='item_highlights_api_state';`) → `getItemHighlightsApiState` returns `null` → gate falls back to the July-27 date. Zero-risk revert.

---

## Risks & Guards

- **Never flip to `supported` on a transient error.** Probe is tri-state; only `preview.ok` → `supported`, only `/currently unsupported/i` (non-HTTP) → `blocked`. HTTP wrappers (`/^HTTP \d+:/`), `null` productType, no live SKU, and any other validation error → `unknown`, which **leaves the last-known flag untouched**. `setItemHighlightsApiState` is called only on definitive verdicts.
- **`null` (never probed) must fall back to the date, not to `supported`.** `isWriteBlockedPreLaunch` returns the July-27 gate when `apiSupported` is `null`/`undefined` — never defaults absent-flag to writable (that would re-introduce the unfillable-gap trust trap). Client `undefined` → `ihWritable !== true` keeps IH blocked.
- **Marketplace-wide, not per-ASIN.** One `app_settings` row; the flag lives on the per-parent ai-recs GET (what Auto-Push reads), **not** stamped on each `ScoreRow` in the `/listing-optimizer` list GET.
- **Keep the July-27 fallback.** The date constant stays in `isWriteBlockedPreLaunch` as the `apiSupported == null` branch — a safety net if `app_settings` is wiped or the probe never runs.
- **`isWriteBlockedPreLaunch` stays pure/sync.** No `await`/DB inside it — the scoring hot loop (`syncListingContent.ts:580-583`) can't afford an async gate. The DB read is hoisted once per request into each async caller.
- **Consumer 1 and Consumer 2 read the same flag** (both `getItemHighlightsApiState`) → regen score == next sync score (no #85 flip-flop).
- **Guard the push-hook writes with `isItemHighlightsField`** so a "currently unsupported" on any other attribute never flips the IH flag, and only a genuine `title_differentiation` accept sets `supported=true`.
- **Probe uses a confirmed-LIVE child SKU** via `discoverSkusForAsin` (`[]`=offerless→skip), never a raw `listing_content` row (phantom/backfilled) and never the non-buyable variation parent hub.
- **Fire-and-forget, throttled >24h.** The probe never blocks a page render/sync/score; `maybeRefreshItemHighlightsProbe` is `void`-wrapped and swallows all errors.

---

## Net change map

| File | Edit |
|---|---|
| `productDetailAttrs.ts` | +`isItemHighlightsField`; +`ItemHighlightsApiState`/`get`/`setItemHighlightsApiState`; rewrite `isWriteBlockedPreLaunch` (field-match first + `opts.apiSupported`) |
| `syncListingContent.ts` | read state in `fetchScoringContext`, pass `{apiSupported}` to filter (580-583), fire probe |
| `ai-recommendations/route.ts` | regen re-score (950-959) pass flag; GET (1489-1512) add `item_highlights_writable` + fire probe |
| `page.tsx` | +`item_highlights_writable?` on interface (~105); rewire `bulkEligibleDetails` (1576) to the flag |
| `pushExecutor.ts` | export `discoverSkusForAsin`; +`probeItemHighlightsWritable`; +`maybeRefreshItemHighlightsProbe`; belt-and-suspenders at 2766/2776 & 3469/3475 |

**Verify before "done":** `tsc --noEmit` + watch the PR's CI `next build` (untracked-import + module-resolution catches `tsc` misses), then the File 7 live probe on their SHIRT category and the `app_settings` read.