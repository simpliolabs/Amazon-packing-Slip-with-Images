/**
 * POST /api/fba/listing-optimizer/scoped-delete-attribute
 *
 * Whole-attribute DELETE via SP-API patchListingsItem — the untried cure path per research
 * consensus (Rose_Amazon moderator-acknowledged Seller Central thread: "I always leave those
 * fields blank on my parent listings") when a parent hub carries orphan composite data (e.g.
 * shirt_size with body_type/height_type/size_class/size_system but NO size, triggering Amazon
 * rule 99022 on every write). Every strategy in the existing heal chain WRITES the composite;
 * this endpoint DELETES the whole top-level attribute so the conditional rule has nothing left
 * to fire against.
 *
 * Hardening (workflow wct4z0hh1 review — 5 blockers fixed inline before ship):
 *   1. ALLOWLIST — only pre-approved composite containers accepted (never variation_theme,
 *      parentage_level, child_parent_sku_relationship, item_name, brand, etc.). A typo here
 *      would de-link every child in the family.
 *   2. NegotiationProtectedAttr second gate — belt-and-suspenders (also blocks child_/parent
 *      prefixes and the codebase-wide protected set).
 *   3. Parent-identity gate — GETs the SKU FIRST, refuses if parentage_level !== 'parent'.
 *      A child-hit would strip the variation axis on ONE child (suppression risk) instead of
 *      curing the parent.
 *   4. INTENT audit row — inserts a `keyword_push_log` row with status='attempted' and the
 *      SERIALIZED old value BEFORE the LIVE PATCH. A crash between PATCH and read-back still
 *      leaves durable evidence of the destructive write. Row flips to 'accepted' on confirmed
 *      read-back.
 *   5. Proper response parsing — HTTP 2xx is insufficient: Amazon returns 200 with
 *      status='INVALID' or ERROR-severity issues[] on rejection. Inline reader checks both.
 *
 * Response includes the full trace (pre-state, preview result, live result, read-back) so the
 * operator can diagnose without opening SP-API logs.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { getSellerId, MARKETPLACE_ID, SYSTEM_ACTOR } from '@/lib/fba/pushExecutor'
import { isNegotiationProtectedAttr } from '@/lib/fba/healEvidence'

const SP_API_ENDPOINT = process.env.AMAZON_SPAPI_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'

/** Purposeful narrow allowlist of top-level attributes this endpoint may DELETE. Extend
 *  DELIBERATELY. Every additional entry must be a container/composite whose absence is
 *  RECOVERABLE (i.e., a subsequent PATCH can put it back if needed) AND whose presence on a
 *  variation parent is not required by Amazon's family plumbing. */
const DELETABLE_ATTRIBUTES = new Set<string>([
  'shirt_size', 'apparel_size', 'shirt_body_type', 'shirt_height_type', 'apparel_body_type',
  'item_package_dimensions', 'item_package_weight',
])

/** Inline mirror of pushExecutor's parsePatchIssues — kept private to this endpoint per
 *  Karpathy surgical-changes (avoids exporting a new symbol from pushExecutor just for this). */
function parsePatch(json: { status?: string; submissionId?: string | null; issues?: Array<{ code?: string; message?: string; severity?: string }> | null | undefined }): {
  ok: boolean; submissionId: string | null; error: string | null; issues: Array<{ code?: string; message?: string; severity?: string }>
} {
  const issues = json.issues ?? []
  const errorIssues = issues.filter((i) => i.severity === 'ERROR')
  const ok = json.status !== 'INVALID' && errorIssues.length === 0
  return {
    ok,
    submissionId: json.submissionId ?? null,
    error: ok ? null : (errorIssues.map((i) => i.message).join('; ') || `status=${json.status ?? 'unknown'}`),
    issues: errorIssues,
  }
}

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

export async function POST(req: NextRequest) {
  let body: { sku?: string; attribute?: string; productType?: string; confirm?: boolean }
  try { body = (await req.json().catch(() => ({}))) as typeof body }
  catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) }

  const sku = String(body.sku ?? '').trim()
  const attribute = String(body.attribute ?? '').trim()
  const productType = String(body.productType ?? '').trim()

  if (body.confirm !== true) return NextResponse.json({ error: 'confirm:true required — this endpoint performs a destructive DELETE via SP-API against a live production listing' }, { status: 400 })
  if (!sku) return NextResponse.json({ error: 'sku required' }, { status: 400 })
  if (!attribute) return NextResponse.json({ error: 'attribute required' }, { status: 400 })
  if (!productType) return NextResponse.json({ error: 'productType required (e.g. "SHIRT")' }, { status: 400 })
  if (!DELETABLE_ATTRIBUTES.has(attribute)) {
    return NextResponse.json({ error: `attribute "${attribute}" is not in the DELETABLE_ATTRIBUTES allowlist (allowed: ${[...DELETABLE_ATTRIBUTES].join(', ')})` }, { status: 400 })
  }
  if (isNegotiationProtectedAttr(attribute)) {
    return NextResponse.json({ error: `attribute "${attribute}" is family-plumbing / protected — never deletable (would de-link children or destroy the record)` }, { status: 400 })
  }

  try {
    const [sellerId, token] = await Promise.all([getSellerId(), getAccessToken()])
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any

    // STEP 1 — PARENT-IDENTITY + PRE-STATE READ. Refuse if this is not a variation parent (a
    // scoped-delete on a CHILD would strip its variation axis: suppression risk). Serialize the
    // current attribute value so the audit trail preserves what we destroyed.
    const preUrl = `${SP_API_ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes,issues,summaries`
    const preResp = await fetch(preUrl, { headers: { 'x-amz-access-token': token } })
    if (!preResp.ok) {
      const t = await preResp.text()
      return NextResponse.json({ error: `pre-state GET failed HTTP ${preResp.status}: ${t.slice(0, 300)}` }, { status: 502 })
    }
    const preJson = (await preResp.json()) as { attributes?: Record<string, unknown>; issues?: unknown; summaries?: unknown }
    const preAttrs = preJson.attributes ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentageArr = preAttrs.parentage_level as Array<{ value?: string }> | undefined
    const parentageValue = parentageArr?.[0]?.value ?? null
    if (parentageValue !== 'parent') {
      return NextResponse.json({
        error: `sku "${sku}" is not a variation-parent hub (parentage_level=${parentageValue ?? 'absent'}). This endpoint refuses to DELETE on child/standalone SKUs — the attribute lives on children by design there.`,
        pre_state: { parentageValue, hasAttribute: attribute in preAttrs },
      }, { status: 400 })
    }
    const preAttributeValue = preAttrs[attribute] ?? null

    // STEP 2 — INTENT AUDIT ROW. Best-effort insert BEFORE the LIVE call so a crash between
    // PATCH and read-back still leaves durable evidence. Never blocks (log failure ⇒ proceed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent_asin = (preJson as any)?.summaries?.[0]?.asin ?? null
    let intentRowId: string | null = null
    try {
      const { data: intentData, error: intentErr } = await db.from('keyword_push_log').insert({
        parent_asin, sku, field: `scoped-delete:${attribute}`,
        previous_value: preAttributeValue == null ? null : JSON.stringify(preAttributeValue).slice(0, 8000),
        new_value: 'DELETE-INTENT',
        submission_id: null, status: 'attempted', error_message: null,
        pushed_by: SYSTEM_ACTOR.id,
      }).select('id')
      if (intentErr) console.warn('[scoped-delete] INTENT log insert failed (best-effort, proceeding):', intentErr?.message ?? intentErr)
      else intentRowId = (intentData as { id?: string }[] | null)?.[0]?.id ?? null
    } catch (e) { console.warn('[scoped-delete] INTENT log insert threw (best-effort, proceeding):', e instanceof Error ? e.message : e) }

    // STEP 3 — VALIDATION_PREVIEW. If Amazon rejects the delete in preview, we bail without
    // any LIVE side-effects. Common cause: dead-token stored state that even DELETE can't cure.
    const patchBody = { productType, patches: [{ op: 'delete', path: `/attributes/${attribute}` }] }
    const patchUrl = `${SP_API_ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=issues`
    const previewResp = await fetch(`${patchUrl}&mode=VALIDATION_PREVIEW`, {
      method: 'PATCH',
      headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    })
    const previewText = await previewResp.text()
    let previewJson: Parameters<typeof parsePatch>[0]
    try { previewJson = JSON.parse(previewText) as typeof previewJson } catch {
      previewJson = { status: 'INVALID', issues: [{ severity: 'ERROR', message: `preview non-JSON body HTTP ${previewResp.status}: ${previewText.slice(0, 200)}` }] }
    }
    const preview = parsePatch(previewJson)
    if (!preview.ok) {
      try { if (intentRowId) await db.from('keyword_push_log').update({ status: 'rejected', error_message: `preview: ${preview.error?.slice(0, 500) ?? 'rejected'}` }).eq('id', intentRowId) } catch { /* best-effort */ }
      return NextResponse.json({ ok: false, stage: 'preview', pre_state: { parentageValue, preAttributeValue }, preview, live: null, readback: null }, { status: 200 })
    }

    // STEP 4 — LIVE PATCH.
    const liveResp = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    })
    const liveText = await liveResp.text()
    let liveJson: Parameters<typeof parsePatch>[0]
    try { liveJson = JSON.parse(liveText) as typeof liveJson } catch {
      liveJson = { status: 'INVALID', issues: [{ severity: 'ERROR', message: `live non-JSON body HTTP ${liveResp.status}: ${liveText.slice(0, 200)}` }] }
    }
    const live = parsePatch(liveJson)
    if (!live.ok) {
      try { if (intentRowId) await db.from('keyword_push_log').update({ status: 'rejected', error_message: `live: ${live.error?.slice(0, 500) ?? 'rejected'}`, submission_id: live.submissionId }).eq('id', intentRowId) } catch { /* best-effort */ }
      return NextResponse.json({ ok: false, stage: 'live', pre_state: { parentageValue, preAttributeValue }, preview, live, readback: null }, { status: 200 })
    }

    // STEP 5 — READ-BACK. Amazon PATCHes are async under the hood; the attribute may still be
    // present for 1-5s (community-reported median). 1s is a floor, not a ceiling — if we still
    // see the attribute, we honestly report "not yet propagated" rather than lying.
    await sleep(1500)
    const postResp = await fetch(preUrl, { headers: { 'x-amz-access-token': token } })
    let readback: { ok: boolean; attributeStillPresent: boolean | null; issues: unknown } = { ok: postResp.ok, attributeStillPresent: null, issues: null }
    if (postResp.ok) {
      const postJson = (await postResp.json()) as { attributes?: Record<string, unknown>; issues?: unknown }
      const postAttrs = postJson.attributes ?? {}
      readback = { ok: true, attributeStillPresent: attribute in postAttrs, issues: postJson.issues ?? [] }
    }

    // STEP 6 — audit-row terminal update. 'accepted' means BOTH the LIVE PATCH validated clean
    // AND the read-back agrees the attribute is gone. If Amazon accepted but read-back still
    // shows the attribute, mark 'pending-propagation' so we don't false-green.
    const cured = live.ok && readback.attributeStillPresent === false
    try {
      if (intentRowId) {
        await db.from('keyword_push_log').update({
          status: cured ? 'accepted' : 'pending-propagation',
          submission_id: live.submissionId,
          error_message: cured ? null : `LIVE ok but read-back shows attribute still present at t+1.5s — may propagate later, may be silent-drop`,
        }).eq('id', intentRowId)
      }
    } catch { /* best-effort */ }

    return NextResponse.json({
      ok: cured, stage: cured ? 'healed' : 'accepted-not-yet-propagated',
      pre_state: { parentageValue, preAttributeValue }, preview, live, readback,
      audit: { intentRowId, submissionId: live.submissionId },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
