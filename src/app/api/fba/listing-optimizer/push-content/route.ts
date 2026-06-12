/**
 * /api/fba/listing-optimizer/push-content
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin HTTP shell around the shared push engine (src/lib/fba/pushExecutor.ts).
 * PR #184 moved the entire field/detail push loop there so the SAME code powers:
 *   - this route's streaming POST (NDJSON to the browser, used by the Ship modal)
 *   - background push jobs (src/lib/fba/pushJobs.ts → push_jobs table), which
 *     survive tab close and feed the global status bar.
 *
 * GET  ?parent_asin=&field=  → PREVIEW: per-SKU diff (current vs proposed), no writes.
 * POST { parent_asin, field, confirm:true } → PUSH: VALIDATION_PREVIEW then live PATCH
 *      per SKU, throttled, streamed as NDJSON (started/progress/rescore/result/error).
 *
 * App Router constraint: route files may only export HTTP verbs, so the engine and
 * its helpers live in the lib module and are imported here for the GET preview.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { FIELD_CONFIG, isPushField } from '@/lib/fba/pushFields'
import { resolveDetailAttribute } from '@/lib/fba/productDetailAttrs'
import { inspectProductTypeAttribute, resolveSpApiKeyFromTitle, getDetailValueShape, buildShapedDetailValue, buildShapedDetailValueVariants, getAttributeSubschema } from '@/lib/fba/productTypeDefinitions'
import { getProductType } from '@/lib/amazon/productType'
import {
  executePush, getSellerId, loadDiff, loadDetailContext, loadDetailDiff, requestPushCancel,
  ENDPOINT, MARKETPLACE_ID, type PushEmit,
} from '@/lib/fba/pushExecutor'

// ─── GET — preview (no writes) ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const parentAsin = url.searchParams.get('parent_asin')
    const rawField = url.searchParams.get('field') ?? 'keywords'
    if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

    // ── DEBUG branch (?debug=1&field=details&detail_field=…) — diagnose enum resolution.
    //    Read-only: resolves the productType and introspects the LIVE product-type schema so we
    //    can see WHERE enum lookup fails (definitions HTTP status, presigned-schema status,
    //    attribute presence, extraction). ?product_type= overrides the resolved type.
    if (url.searchParams.get('debug') === '1' && rawField === 'details') {
      const detailField = url.searchParams.get('detail_field') || 'Department'
      const supabase = await createAdminClient()
      const { data: skuRows } = await supabase.from('listing_content').select('sku').eq('parent_asin', parentAsin).limit(1)
      const sku = (skuRows as { sku?: string }[] | null)?.[0]?.sku ?? null
      const ptOverride = url.searchParams.get('product_type')
      let productType = ptOverride || 'PRODUCT'
      let token = '', sellerId = ''
      try {
        token = await getAccessToken()
        sellerId = await getSellerId()
        if (!ptOverride && sku) productType = await getProductType(sellerId, token, sku)
      } catch (e) {
        return NextResponse.json({ stage: 'auth', sku, error: e instanceof Error ? e.message : String(e) })
      }
      const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }
      // Resolve like the regen does: static map first, else the dynamic schema-title match —
      // so the debug view can introspect composite keys ("Neck" → `neck`), not just static names.
      let spApiKey = resolveDetailAttribute(detailField)?.spApiKey ?? null
      let resolvedVia: 'static' | 'schema-title' | null = spApiKey ? 'static' : null
      if (!spApiKey) {
        const dyn = await resolveSpApiKeyFromTitle(productType, detailField, ptOpts)
        if (dyn) { spApiKey = dyn.spApiKey; resolvedVia = 'schema-title' }
      }
      if (!spApiKey) return NextResponse.json({ error: `unknown detail "${detailField}" (no static or schema-title match)` }, { status: 400 })
      const inspect = await inspectProductTypeAttribute(productType, spApiKey, ptOpts)
      // The composite value path the push will use (null = flat legacy shape) + a sample
      // of the exact patch entry — read-only proof of the write shape before any push.
      const valueShape = await getDetailValueShape(productType, spApiKey, ptOpts)
      const samplePatchValue = valueShape ? buildShapedDetailValue(valueShape, '<VALUE>', MARKETPLACE_ID) : null
      // Ground truth for shape debugging: the RAW subschema node + every calibration variant
      // the push would probe (the static read guessed wrong on SHIRT neck — see the raw JSON).
      const rawSubschema = await getAttributeSubschema(productType, spApiKey, ptOpts)
      const calibrationVariants = valueShape ? buildShapedDetailValueVariants(valueShape, '<VALUE>', MARKETPLACE_ID) : null
      return NextResponse.json({ sku, detailField, spApiKey, resolvedVia, productType, valueShape, samplePatchValue, calibrationVariants, rawSubschema, ...inspect })
    }

    // ── DETAILS branch ─────────────────────────────────────────────────────────
    if (rawField === 'details') {
      const detailField = url.searchParams.get('detail_field') ?? ''
      const { ctx, error } = await loadDetailContext(parentAsin, detailField)
      if (!ctx) return NextResponse.json({ error }, { status: 400 })
      const diff = await loadDetailDiff(parentAsin, ctx)
      if (diff.length === 0) {
        return NextResponse.json({ error: 'No SKUs found for this parent. Run a Sync first.' }, { status: 404 })
      }
      return NextResponse.json({
        parent_asin: parentAsin,
        field: 'details' as const,
        // Surface the SP-API key so the seller knows which attribute is being patched.
        detail_field: ctx.detailField,
        attribute_key: ctx.attribute.spApiKey,
        label: `Detail · ${ctx.detailField}`,
        // Details are always broadcast in v1 (per-variant attrs are blocked upstream).
        broadcast: true,
        configBroadcast: true,
        count: diff.length,
        changed: diff.filter((d) => d.changed).length,
        proposedValue: ctx.recommendedValue,
        // Enum (Feature B): the accepted vocabulary for this attribute + what we
        // normalized the audit's value FROM, so the modal can show "Unisex Adult → Unisex".
        acceptedValues: ctx.acceptedValues ?? null,
        normalizedFrom: ctx.normalizedFrom ?? null,
        // Part 2b: uncoercible dropdown — the modal shows a seller-picker over acceptedValues.
        enum_invalid: ctx.enumInvalid ?? false,
        diff,
      })
    }

    if (!isPushField(rawField)) return NextResponse.json({ error: `unknown field "${rawField}"` }, { status: 400 })
    const field = rawField

    const diff = await loadDiff(parentAsin, field)
    if (diff.length === 0) {
      return NextResponse.json({ error: 'No recommendations found for this field. Run an AI audit first.' }, { status: 404 })
    }
    const cfg = FIELD_CONFIG[field]
    // EFFECTIVE broadcast: the FIELD_CONFIG says title/bullets/description are broadcast, but
    // capacity variation families inject per_child_titles → the proposed values are SKU-specific.
    // Detecting that purely from the field name is wrong (silently shows ONE title to the user
    // while writing different ones per SKU). Compare the actual proposed strings: only call it
    // broadcast when every SKU genuinely agrees on the same value.
    const proposedStrings = diff.map((d) => d.proposed)
    const allIdentical = proposedStrings.length === 0 || proposedStrings.every((s) => s === proposedStrings[0])
    const effectiveBroadcast = cfg.broadcast && allIdentical
    return NextResponse.json({
      parent_asin: parentAsin,
      field,
      label: cfg.label,
      broadcast: effectiveBroadcast,
      // Useful for the UI to know whether this field is broadcast IN PRINCIPLE (so it can
      // explain why values differ) vs per-child by definition (like backend keywords).
      configBroadcast: cfg.broadcast,
      count: diff.length,
      changed: diff.filter((d) => d.changed).length,
      // For broadcast fields every child gets the same value — surface it once for the UI.
      // For effective-per-child cases, set to null so the modal must use diff[] per-SKU.
      proposedValue: effectiveBroadcast ? (diff[0]?.raw ?? null) : null,
      diff,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 500 })
  }
}

// ─── POST — push (writes to Amazon, with confirm) ──────────────────────────────
// Streams NDJSON so the upload survives proxy idle-timeouts (Coolify nginx ~60s,
// Cloudflare ~100s) and container restarts mid-deploy. The event vocabulary is
// documented on executePush in pushExecutor.ts; the client reads line-by-line and
// only the 'result' event advances the post-push UI.
export async function POST(req: NextRequest) {
  // Validate the body BEFORE opening the stream — a 400 here is a real client error,
  // not a mid-push failure. Keeps the streaming envelope reserved for things that
  // can actually fail asynchronously.
  let body: { parent_asin?: string; confirm?: boolean; field?: string; detail_field?: string; skus?: string[]; title_override?: string; detail_value_override?: string; action?: string; cancel_token?: string }
  try { body = (await req.json().catch(() => ({}))) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  // Cancel a running streaming push (PO: "NO way to cancel when it starts") — flips the
  // in-memory flag; the SKU loop stops between SKUs and emits a cancelled result.
  if (body.action === 'cancel' && typeof body.cancel_token === 'string' && body.cancel_token) {
    requestPushCancel(body.cancel_token)
    return NextResponse.json({ ok: true })
  }
  const { parent_asin, confirm, field: rawField, detail_field: detailField, skus, title_override, detail_value_override } = body
  if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  if (confirm !== true) {
    return NextResponse.json({ error: 'Refusing to write without explicit confirm:true. Use GET to preview first.' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // Safe enqueue: if the browser disconnects mid-push (tab closed, network drop),
      // enqueue throws — swallow it so the SERVER-side loop finishes every SKU and the
      // write-throughs/logs still land. Verify on Amazon then shows the true state.
      const emit: PushEmit = (obj) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) }
        catch { /* client gone — keep pushing */ }
      }
      await executePush({ parent_asin, field: rawField, detail_field: detailField, skus, title_override, detail_value_override, cancel_token: body.cancel_token }, emit)
      try { controller.close() } catch { /* already closed by disconnect */ }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Disable nginx buffering on the proxy side so each emit() actually reaches the client
      // immediately. Coolify's default config buffers up to 8KB before flushing.
      'X-Accel-Buffering': 'no',
    },
  })
}
