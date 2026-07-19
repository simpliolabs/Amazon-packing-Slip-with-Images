/**
 * /api/fba/listing-optimizer/verify-push
 * ─────────────────────────────────────────────────────────────────────────────
 * "Did Amazon actually apply the push?" diagnostic.
 *
 * SP-API submissions return ACCEPTED, not "applied". Amazon's variation-family
 * processing takes anywhere from 15 minutes to several hours. After a push the
 * seller's natural question is "I pushed an hour ago and the PDP still shows
 * the old bullets — did it land or did it fail?". This endpoint answers that
 * by reading the LIVE attribute on every (FBA + FBM + parent) SKU directly from
 * Amazon via getListingsItem and comparing to the recommendation we tried to push.
 *
 * GET ?parent_asin=...&field=title|bullets|description|keywords|details
 *     [&detail_field=Material]
 *
 * For each SKU returns:
 *   - sku, asin, isParent
 *   - currentLive : what Amazon's catalog actually shows right now
 *   - expected    : the value we tried to push (from the recommendation)
 *   - matches     : currentLive trim-equal expected
 *   - lastUpdatedDate : the listing's updated timestamp (clue for whether
 *                       Amazon processed the patch recently)
 *
 * HEAL-ON-VERIFY: after the live read, matched SKUs have their cached listing_content grounded to the
 * verified value and the parent is re-scored — so cohesion counts + the score can't keep showing phantom
 * "needs update" / a frozen score after a push that Amazon has actually applied. Best-effort, non-fatal.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { isPushField, resolveProposed, asCompare, cacheUpdateFor, squashEquals, type PushField } from '@/lib/fba/pushFields'
import { rescoreParentFromCache } from '@/lib/fba/pushExecutor'
import { spApiReadBucket } from '@/lib/fba/spApiRateLimiter'

// VerifyField broadens PushField to include 'details', which the verify route
// supports too. pushFields.ts deliberately keeps PushField narrow (the four built-in
// attributes) — details is a separate code path in push-content and here.
type VerifyField = PushField | 'details'
import {
  resolveDetailAttribute, isPushableDetail, currentDetailValue, normalizeFieldName, detailValueToString,
} from '@/lib/fba/productDetailAttrs'

const ENDPOINT       = process.env.AMAZON_ENDPOINT       || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

async function getSellerId(): Promise<string> {
  const supabase = await createAdminClient()
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured.')
}

interface LiveListing {
  attributes?: Record<string, unknown>
  summaries?: { lastUpdatedDate?: string; productType?: string }[]
}

async function getListing(sellerId: string, token: string, sku: string): Promise<LiveListing | null> {
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}` +
    `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes,summaries`
  // RETRY on throttle (429) / transient 5xx / network error with backoff. getListingsItem is 5 rps;
  // a 97-SKU verify used to blow past that and get THROTTLED reads back empty → the optimizer then
  // showed those SKUs as FALSE "stale" even though the title was live (2026-06-17, B0G884ZJ27). Up
  // to 3 attempts; null only after all fail — the caller buckets that as "couldn't read", NOT stale.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await spApiReadBucket.acquire()   // global 5-rps read ceiling so concurrent verifies (4 employees) can't get throttled (task #23)
      const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
      if (resp.ok) return (await resp.json()) as LiveListing
      // 4xx other than 429 (e.g. a genuine 404) won't fix on retry — give up now.
      if (resp.status !== 429 && resp.status < 500) return null
    } catch { /* network blip — fall through to backoff + retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  return null
}

/** Extract the live value for a field (post-push expected representation). */
function extractLive(field: VerifyField, detailKey: string | null, listing: LiveListing | null): string {
  if (!listing) return ''
  const attrs = listing.attributes ?? {}
  // Pick the right attribute key per field.
  let key: string | null = null
  if (field === 'title') key = 'item_name'
  else if (field === 'bullets') key = 'bullet_point'
  else if (field === 'description') key = 'product_description'
  else if (field === 'keywords') key = 'generic_keyword'
  else if (field === 'details') key = detailKey
  if (!key) return ''

  const arr = attrs[key]
  if (!Array.isArray(arr) || arr.length === 0) return ''
  // bullet_point is multi-entry (one per bullet, ordered). Other fields take the first.
  if (field === 'bullets') {
    return (arr as { value?: unknown }[])
      .map((e) => (e?.value == null ? '' : String(e.value).trim()))
      .filter(Boolean)
      .join('\n')
  }
  const first = arr[0] as { value?: unknown }
  return currentDetailValue(attrs, key) || (first?.value == null ? '' : String(first.value).trim())
}

interface RecRow {
  recommended_title?: string | null
  recommended_bullets?: string[] | null
  recommended_description?: string | null
  recommended_keywords?: string | null
  per_child_titles?: { sku: string; asin: string; title: string }[] | null
  /** Per-design bullets/description for multi-design POD families (migration 033). resolveProposed
   *  resolves the SKU-specific value (else broadcast), so the expected value matches what the push sends. */
  per_child_bullets?: { sku: string; asin: string; bullets: string[] }[] | null
  per_child_descriptions?: { sku: string; asin: string; description: string }[] | null
  product_details_improvements?: { field_name?: string; recommended_value?: string; sp_api_key?: string; pushable?: boolean }[] | null
}

/** Compute the value WE tried to push for this SKU (mirrors push-content's resolution). */
function expectedFor(
  field: VerifyField, rec: RecRow, sku: string, isParent: boolean,
  detailFriendlyName: string | null,
): string {
  if (field === 'details') {
    const entry = (rec.product_details_improvements ?? []).find(
      (d) => normalizeFieldName(d.field_name || '') === normalizeFieldName(detailFriendlyName || ''),
    )
    // Historical rows can carry non-string values (LLM array/number) — normalize, never throw.
    return detailValueToString(entry?.recommended_value).trim()
  }
  if (field === 'keywords') {
    try {
      const arr = JSON.parse(rec.recommended_keywords ?? '[]') as { sku?: string; keywords?: string }[]
      const match = Array.isArray(arr) ? arr.find((r) => r.sku === sku) : null
      return (match?.keywords ?? '').trim()
    } catch { return '' }
  }
  if (field === 'title') {
    // Parent gets the capacity-agnostic version when a per-child-titles family is in scope;
    // otherwise the same broadcast title every child gets.
    if (isParent && Array.isArray(rec.per_child_titles) && rec.per_child_titles.length > 1) {
      return (rec.recommended_title ?? '').replace(/\b\d{1,4}\s?(?:GB|TB|MB)\b/gi, '').replace(/\s{2,}/g, ' ').trim()
    }
    const pct = Array.isArray(rec.per_child_titles) ? rec.per_child_titles.find((p) => p.sku === sku) : null
    return (pct?.title ?? rec.recommended_title ?? '').trim()
  }
  // bullets / description are broadcast — every SKU gets the same value.
  // (field is narrowed to PushField here; details was handled above.)
  const val = resolveProposed(field as PushField, rec, new Map(), sku)
  return asCompare(val)
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const parentAsin = url.searchParams.get('parent_asin')
    const rawField = url.searchParams.get('field') ?? ''
    const detailFriendly = url.searchParams.get('detail_field') ?? ''
    // Optional per-design scope: verify only this SKU subset (per-design cards PR-C). Null ⇒ verify all.
    const skusParam = url.searchParams.get('skus')
    const skuFilter = skusParam ? new Set(skusParam.split(',').map((s) => s.trim()).filter(Boolean)) : null
    if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    if (rawField !== 'details' && !isPushField(rawField)) {
      return NextResponse.json({ error: `unknown field "${rawField}"` }, { status: 400 })
    }
    const field = rawField as VerifyField

    // Load the recommendation row (so we know what we EXPECTED to push).
    const supabase = await createAdminClient()
    const { data: recRow } = await supabase
      .from('listing_seo_recommendations')
      .select('recommended_title, recommended_bullets, recommended_description, recommended_keywords, per_child_titles, per_child_bullets, per_child_descriptions, product_details_improvements')
      .eq('parent_asin', parentAsin)
      .single()
    const rec = (recRow ?? {}) as RecRow

    // Resolve the SP-API attribute key for details (so extractLive knows where to look).
    // Prefer the key the regen stored on the recommendation (schema-resolved, works for ANY
    // category); the static map only covers rows from before the schema-mapping change.
    let detailKey: string | null = null
    if (field === 'details') {
      const stored = (rec.product_details_improvements ?? []).find(
        (d) => normalizeFieldName(d.field_name || '') === normalizeFieldName(detailFriendly || ''),
      )
      if (stored?.pushable && stored.sp_api_key) {
        detailKey = stored.sp_api_key
      } else {
        if (!isPushableDetail(detailFriendly)) {
          return NextResponse.json({ error: `"${detailFriendly}" can't be verified as a pushable detail.` }, { status: 400 })
        }
        detailKey = resolveDetailAttribute(detailFriendly)?.spApiKey ?? null
        if (!detailKey) return NextResponse.json({ error: `Unknown detail attribute "${detailFriendly}"` }, { status: 400 })
      }
    }

    // TARGET SET = what was ACTUALLY pushed, read from keyword_push_log (ground truth). The push logs
    // one row per attempted SKU per field — INCLUDING the live-discovered FBM twins that are never
    // persisted to listing_content, and the parent. So reading the log gives EXACT coverage parity with
    // the push for EVERY field, with zero re-derivation of loadDiff's gates (raw!=null / changed /
    // per-ASIN notLive / twin-name-match) that a family reconstruction would have to keep perpetually in
    // sync (B0FRYMM56C: the push logged 176 title rows → verify targets 176; reading listing_content only
    // gave 107). new_value is also the BETTER expected value — the exact string written, and unlike the
    // recommendation row it doesn't vanish on the next regen (this subsumes the old details-only
    // fallback). Scoped to the LATEST push SESSION (10 min from the newest row) so a SKU that left the
    // family in an OLD push — or a later cron re-push of just the stale subset — can't skew the count.
    const logField: string = field === 'details' ? `details:${detailKey}` : field
    const pushedBySku = new Map<string, { new_value: string; status: string }>()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pl } = await (supabase as any)
        .from('keyword_push_log')
        .select('sku, new_value, status, pushed_at, rolled_back_at')
        .eq('parent_asin', parentAsin)
        .eq('field', logField)
        .order('pushed_at', { ascending: false })
      const logRows = (pl ?? []) as { sku: string | null; new_value: string | null; status: string | null; pushed_at: string | null; rolled_back_at: string | null }[]
      // Anchor the window on the LATEST push and look back 30 DAYS (not a tight wall-clock gap). A cron
      // re-push of just the stale subset, an interrupted+resumed push, and a multi-design family's
      // per-design pushes all land within days of each other — a short gap would SPLIT them and collapse
      // the count to the last cluster (verify's job is "did the push of N apply?", so N must not silently
      // shrink to the last-retried subset). 30 days back keeps every related push while still dropping
      // truly-ancient rows for SKUs that have since left the family.
      const latestAt = logRows.find((r) => r.pushed_at)?.pushed_at
      const windowStart = latestAt ? Date.parse(latestAt) - 30 * 24 * 60 * 60 * 1000 : null
      const seen = new Set<string>()
      for (const r of logRows) {
        if (!r.sku || !r.pushed_at) continue
        if (windowStart != null && Date.parse(r.pushed_at) < windowStart) break // ordered DESC → the rest are older
        if (seen.has(r.sku)) continue                 // only the NEWEST (in-window) row per SKU counts
        seen.add(r.sku)
        // A SKU whose most-recent action was a ROLLBACK had its live value intentionally reverted — nothing
        // to verify (comparing to new_value would falsely read "stale"). Rollback is modelled as an UPDATE
        // that stamps rolled_back_at (leaving status='accepted'), so gate on rolled_back_at, not status.
        if (r.rolled_back_at || r.status === 'rolled_back') continue
        pushedBySku.set(r.sku, { new_value: r.new_value ?? '', status: r.status ?? '' })
      }
    } catch { /* log unreadable — fall back to the listing_content family below (legacy behaviour) */ }

    // listing_content gives each SKU's ASIN (for display, isParent, and the title-inherited bucket) and
    // is the FALLBACK target set when there's no push log yet (legacy pushes predating the log). A pushed
    // twin/parent may be absent from it → asin '' (verify reads by SKU, not ASIN, so that's harmless).
    const { data: rowsRaw } = await supabase
      .from('listing_content')
      .select('sku, asin')
      .eq('parent_asin', parentAsin)
      .order('sku', { ascending: true })
    const rows = (rowsRaw ?? []) as { sku: string; asin: string }[]
    const skuToAsin = new Map(rows.map((r) => [r.sku, r.asin]))
    if (pushedBySku.size === 0 && rows.length === 0) {
      return NextResponse.json({ error: 'Nothing to verify — no push history and no synced children for this parent. Push or Sync first.' }, { status: 404 })
    }

    const token = await getAccessToken()
    const sellerId = await getSellerId()

    // Discover the variation parent SKU. CRITICAL now that targets come from the push LOG: the parent SKU
    // is ALWAYS logged for broadcast fields, so if this lookup returns null the parent's log row would be
    // scored as a buyable child that can NEVER match (the hub rejects content PATCHes) → "1 stale" forever
    // → the cron re-push loop the #244/#245 comment below forbids. So RETRY (3×, on throttle/5xx/network)
    // — whenever the push itself found the parent, verify will too.
    const isBroadcastField = field === 'title' || field === 'bullets' || field === 'description' || field === 'details'
    let parentSku: string | null = null
    if (isBroadcastField) {
      const urlP =
        `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
        `?identifiers=${encodeURIComponent(parentAsin)}&identifiersType=ASIN` +
        `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(urlP, { headers: { 'x-amz-access-token': token } })
          if (resp.ok) {
            const j = (await resp.json()) as { items?: { sku?: string }[] }
            parentSku = j.items?.[0]?.sku ?? null
            break // a successful read is authoritative (found the parent SKU or confirmed none)
          }
          if (resp.status !== 429 && resp.status < 500) break // genuine 4xx — won't fix on retry
        } catch { /* network blip — fall through to backoff + retry */ }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }

    // Walk every (sku, isParent) and fetch its live listing in parallel batches of 5 (5 rps cap).
    // Targets = the pushed SKUs (ground truth) when the log has any; else the listing_content family
    // (legacy pushes predating the log). We NEVER twin-discover here — the log already holds the twins.
    let targets: { sku: string; asin: string; isParent: boolean }[]
    if (pushedBySku.size > 0) {
      targets = [...pushedBySku.keys()].map((sku) => {
        const isParent = parentSku != null && sku === parentSku
        return { sku, asin: isParent ? parentAsin : (skuToAsin.get(sku) ?? ''), isParent }
      })
    } else {
      targets = rows.map((r) => ({ sku: r.sku, asin: r.asin, isParent: false }))
    }
    // Include the variation parent SKU for broadcast/details even if it wasn't in the log/rows.
    if (parentSku && !targets.some((t) => t.sku === parentSku)) {
      targets.push({ sku: parentSku, asin: parentAsin, isParent: true })
    }
    // Per-design scope (PR-C): keep only the requested subset (plus the parent hub). An empty CHILD
    // intersection → explicit "unverifiable" empty result, never widen back to the whole listing.
    if (skuFilter) {
      targets = targets.filter((t) => t.isParent || skuFilter.has(t.sku))
      if (targets.every((t) => t.isParent)) {
        return NextResponse.json({
          parent_asin: parentAsin, field,
          detail_field: field === 'details' ? detailFriendly : undefined,
          total: 0, matched: 0, inherited: 0, unverifiable: 0, stale: 0, unknown: 0, parentSkipped: targets.length,
          results: [],
        })
      }
    }

    const results: { sku: string; asin: string; isParent: boolean; currentLive: string; expected: string; expectedSource: 'recommendation' | 'push_log' | 'none'; matches: boolean; inherited: boolean; readFailed: boolean; lastUpdatedDate: string | null }[] = []
    // Pace the reads under getListingsItem's 5 rps cap. The old loop fired 5 simultaneous reads with
    // only a 250ms gap (a burst well over the limit) → Amazon throttled many reads, getListing
    // returned empty, and the optimizer showed them as FALSE "stale". Now: 4 concurrent + ~900ms per
    // batch cycle (≈4-5 reads/s) + per-read retry (above) → reads succeed, so verify stops lying.
    const BATCH = 4
    for (let i = 0; i < targets.length; i += BATCH) {
      const batchStart = Date.now()
      const batch = targets.slice(i, i + BATCH)
      const settled = await Promise.all(batch.map(async (t) => {
        const listing = await getListing(sellerId, token, t.sku)
        const readFailed = listing === null // null only AFTER retries exhausted = couldn't read
        const currentLive = extractLive(field, detailKey, listing)
        // EXPECTED = the exact string we PUSHED (keyword_push_log.new_value) — ground truth for what
        // Amazon should now show, for EVERY field. It doesn't vanish on the next regen (unlike the rec).
        // Fall back to the live recommendation only when a target isn't in the log (the parent-add, or
        // the legacy no-log path). new_value is already asCompare()-normalized (same shape extractLive
        // and expectedFor produce), so the match test below is unchanged.
        const logged = pushedBySku.get(t.sku)
        let expected: string
        let expectedSource: 'recommendation' | 'push_log' | 'none'
        if (logged && logged.new_value) {
          expected = logged.new_value
          expectedSource = 'push_log'
        } else {
          expected = expectedFor(field, rec, t.sku, t.isParent, detailFriendly || null)
          expectedSource = expected ? 'recommendation' : 'none'
        }
        const lastUpdatedDate = listing?.summaries?.[0]?.lastUpdatedDate ?? null
        // INHERITED (2026-06-17): a variation CHILD whose read SUCCEEDED but whose own item_name is
        // empty inherits the parent's title — applied, not stale. Scoped to title only (details/
        // keywords are genuinely per-child). Gated on a SUCCESSFUL read (!readFailed) so a throttled
        // empty read is never mislabeled "inherited" — those go to the readFailed/"couldn't read" bucket.
        const inherited = field === 'title' && !t.isParent && !readFailed && currentLive.length === 0 && expected.length > 0
        return {
          sku: t.sku, asin: t.asin, isParent: t.isParent,
          currentLive, expected, expectedSource,
          // Squash-compare so a CORRECTLY-applied enum isn't falsely "stale": we push the API token
          // ("short_sleeve") but Amazon returns the display label ("Short Sleeve"). Now THE shared
          // comparator (pushFields.squashEquals, 2026-07-09) — cards, cohesion, and verify judge
          // "matches" with one implementation. (Live: B0FRYMM56C Sleeve applied as "Short Sleeve"
          // yet showed 0/65 matched.)
          matches: currentLive.length > 0 && squashEquals(currentLive, expected),
          inherited,
          readFailed,
          lastUpdatedDate,
        }
      }))
      results.push(...settled)
      // Pace to ~900ms per batch cycle so the sustained rate stays under 5 rps (retries add a few
      // backed-off requests on top — well within the cap).
      if (i + BATCH < targets.length) {
        const elapsed = Date.now() - batchStart
        if (elapsed < 900) await new Promise((r) => setTimeout(r, 900 - elapsed))
      }
    }

    // The variation PARENT is a non-buyable hub: #244/#245 skip it on PUSH (a content PATCH to the
    // parent is always rejected for incomplete Shirt Size attrs), so it can NEVER match here.
    // Counting it left verify permanently at "N applied, 1 stale" and the auto-verify cron
    // (cron-verify-pushes) never saw matched===total → it re-pushed the parent forever / flagged
    // needs_attention. Score the buyable CHILDREN only; keep the parent in `results` (visible) but
    // out of the pass/fail counts so verify can actually reach 100%.
    const scored = results.filter((r) => !r.isParent)
    const matched = scored.filter((r) => r.matches).length
    // Child titles inherited from the parent (empty child item_name on a SUCCESSFUL read) — applied,
    // not stale. Counted separately so the seller sees "✓ inherited" rather than a false failure.
    const inherited = scored.filter((r) => r.inherited).length
    // COULDN'T READ: the live read failed after retries (throttle/network). We genuinely don't know
    // the live state, so this is its OWN bucket — NEVER "stale" (stale falsely implies the push was
    // rejected). This is the core false-"stale" fix: a read we couldn't complete is not a failure to apply.
    const unverifiable = scored.filter((r) => r.readFailed).length
    const stale   = scored.filter((r) => !r.readFailed && !r.matches && !r.inherited && r.expected.length > 0).length
    // No expectation anywhere (not in the rec, never logged as pushed) — its own bucket so the UI
    // never paints these as "stale" (which implied a failed push when there was nothing to compare).
    const unknown = scored.filter((r) => !r.readFailed && r.expected.length === 0).length
    const parentSkipped = results.length - scored.length

    // ── HEAL-ON-VERIFY (foundational coherence fix) ──────────────────────────────────────────────
    // The live read above is ground truth. Ground the CACHED listing_content (which cohesion "N need
    // update" + the listing score both read) to that truth for every MATCHED SKU, so a stale cache can't
    // keep showing phantom "needs update" / a frozen score after a push Amazon has actually applied.
    // Write the REC's RAW value (title string / 5-bullet array / etc.) — NOT the asCompare-normalized
    // `expected` — and only when the rec still equals what was pushed (asCompare(raw)===expected); a rec
    // that legitimately DRIFTED after the push then correctly STAYS red (we never hide real work). The
    // auto-verify CRON hits this same endpoint, so the button AND the cron both self-heal. Best-effort.
    if (field !== 'details') {
      try {
        let healed = 0
        for (const r of scored) {
          if (!r.matches || r.readFailed || r.inherited) continue
          // Resolve the rec's RAW value for this SKU. keywords are per-child and live in recommended_keywords
          // JSON (resolveProposed can't reach them without the push's map), so parse them directly.
          let raw: string | string[] | null
          if (field === 'keywords') {
            try {
              const arr = JSON.parse(rec.recommended_keywords ?? '[]') as { sku?: string; keywords?: string }[]
              raw = ((Array.isArray(arr) ? arr.find((x) => x.sku === r.sku) : null)?.keywords ?? '').trim() || null
            } catch { raw = null }
          } else {
            try { raw = resolveProposed(field as PushField, rec, new Map(), r.sku) } catch { continue }
          }
          if (raw == null) continue
          // Drift guard: only heal when the rec still equals what was PUSHED. When `expected` came from the
          // push LOG (asCompare-normalized), compare against it; when it came from the rec itself (no log
          // row), `matches` already proves live==rec, so heal. A rec that drifted after the push stays red.
          if (r.expectedSource === 'push_log' && asCompare(raw) !== r.expected) continue
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any).from('listing_content')
              .update({ ...cacheUpdateFor(field as PushField, raw), content_synced_at: new Date().toISOString() })
              .eq('sku', r.sku)
            healed++
          } catch (e) { console.warn('[verify-heal] cache write failed', r.sku, e instanceof Error ? e.message : e) }
        }
        if (healed > 0) await rescoreParentFromCache(supabase, parentAsin)
      } catch (e) { console.warn('[verify-heal] failed (non-fatal):', e instanceof Error ? e.message : e) }
    }

    return NextResponse.json({
      parent_asin: parentAsin,
      field,
      detail_field: field === 'details' ? detailFriendly : undefined,
      attribute_key: field === 'details' ? detailKey : (
        field === 'title' ? 'item_name'
        : field === 'bullets' ? 'bullet_point'
        : field === 'description' ? 'product_description'
        : field === 'keywords' ? 'generic_keyword'
        : undefined
      ),
      total: scored.length,
      matched,
      inherited,
      unverifiable,
      stale,
      unknown,
      parentSkipped,
      results,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'verify-push failed' }, { status: 500 })
  }
}
