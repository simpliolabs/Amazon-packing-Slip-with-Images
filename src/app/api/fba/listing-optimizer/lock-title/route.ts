/**
 * POST /api/fba/listing-optimizer/lock-title — the seller's GOLD-TITLE authority.
 *
 * Body: { parent_asin: string, action: 'lock' | 'unlock', title?: string }
 *   action=lock   — set recommended_title = the seller's title (when provided, non-empty) AND
 *                   title_source='manual'. A whole-listing AI Audit / Regenerate then PRESERVES this
 *                   title (see the lock guard in ai-recommendations POST) instead of overwriting it.
 *                   This is the DISCOVERABLE lock the seller asked for — it stores their exact title
 *                   WITHOUT any Amazon push (a push corrupts the lock if the Ship modal seeded the AI
 *                   title, as happened on B0FRYMM56C: the modal seeded the AI rewrite, the seller
 *                   pushed it, and pushExecutor locked the AI title as 'manual').
 *   action=unlock — set title_source='ai' so the next Regenerate is free to rewrite the title.
 *
 * The acting user is resolved server-side from the Authorization: Bearer JWT (same as claim/route.ts).
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getBearerUser, resolveUserName } from '@/lib/fba/claims'
import { computeTitleTruthVerdict } from '@/lib/fba/titleLearningMiner'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

/**
 * TITLE-LEARNING-LOOP INGESTION STAMP (feat/title-learning-loop, migration 065). Computed HERE, at
 * lock time, so the mined gold corpus (titleLearningMiner.ts) never has to re-resolve a family's
 * blank at read time — see that module's header. Best-effort: any failure (missing audience_lean row,
 * unresolved blank, a network hiccup) yields `{ok:null,reason:null}`, which the insert below turns
 * into an untouched NULL column — "not yet vetted", never a false positive or a blocked lock.
 */
async function lockTitleTruthStamp(
  db: SupabaseClient, parentAsin: string, title: string,
): Promise<{ title_truth_ok: boolean | null; title_truth_reason: string | null }> {
  try {
    const { data: scoreRow } = await db
      .from('listing_seo_scores')
      .select('audience_lean')
      .eq('parent_asin', parentAsin)
      .maybeSingle()
    const verdict = await computeTitleTruthVerdict(
      db, parentAsin, title, (scoreRow as { audience_lean?: string | null } | null)?.audience_lean ?? null,
    )
    return { title_truth_ok: verdict.ok, title_truth_reason: verdict.reason }
  } catch (e) {
    console.warn('[lock-title] truth-stamp computation failed (non-fatal):', e instanceof Error ? e.message : e)
    return { title_truth_ok: null, title_truth_reason: null }
  }
}

export async function POST(req: NextRequest) {
  const user = await getBearerUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { parent_asin?: string; action?: string; title?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parentAsin = (body.parent_asin || '').trim()
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  const action = body.action === 'unlock' ? 'unlock' : 'lock'
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''

  const db = admin()

  // Read the current recommended_title so we can log the before/after and only overwrite on an actual change.
  const { data: cur, error: readErr } = await db
    .from('listing_seo_recommendations')
    .select('recommended_title, title_source')
    .eq('parent_asin', parentAsin)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })

  // LOCK-BEFORE-GENERATION (PO 2026-07-21, B0H9VDCBZJ): a listing that has never been generated has no
  // recommendation row, so the seller could not lock their title FIRST and then generate around it. When
  // the seller locks a NON-EMPTY typed title and no row exists yet, SEED a minimal row (title + empties)
  // stamped 'manual' — the next Regenerate then PRESERVES this title (the lock guard in the regen POST).
  // Unlock-with-no-row, or lock-with-no-title-and-no-row, still 404 (nothing to seed/release).
  if (!cur) {
    if (action === 'lock' && title) {
      const { error: insErr } = await db
        .from('listing_seo_recommendations')
        .upsert({
          parent_asin: parentAsin,
          recommended_title: title,
          title_source: 'manual',
          // Empty placeholders for the NOT-NULL core columns (mirrors the generation route's minimal
          // upsert shape) — the seller's Regenerate fills bullets/description/keywords, preserving the title.
          recommended_bullets: [],
          recommended_keywords: '[]',
          recommended_description: '',
          generated_at: new Date().toISOString(),
        }, { onConflict: 'parent_asin' })
      if (insErr) {
        console.error('[lock-title] seed-row insert failed:', insErr.message)
        return NextResponse.json({ error: `Could not seed a recommendation row to hold the locked title: ${insErr.message}` }, { status: 500 })
      }
      // Best-effort audit log for the seed, then return.
      try {
        const myName = await resolveUserName(user.id, user.email)
        const stamp = await lockTitleTruthStamp(db, parentAsin, title)
        await db.from('listing_change_log').insert({
          parent_asin: parentAsin, sku: null, field: 'title (locked)', action: 'edit',
          before_value: '', after_value: title, changed_by: user.id, changed_by_name: myName, source: 'manual_edit',
          ...stamp,
        })
      } catch (e) { console.warn('[lock-title] seed change-log insert failed:', e instanceof Error ? e.message : e) }
      return NextResponse.json({ ok: true, title_source: 'manual', recommended_title: title, seeded: true })
    }
    return NextResponse.json({ error: 'No recommendation row yet — type a title in the Lock field and lock it, or Regenerate first.' }, { status: 404 })
  }

  const before = (cur as { recommended_title?: string }).recommended_title ?? ''

  // Build the update. LOCK: stamp 'manual' + (if the seller typed a title) make it the recommendation so
  // the modal, cohesion, and every future regen use HIS title. UNLOCK: release to 'ai'.
  const update: { title_source: string; recommended_title?: string } =
    action === 'unlock' ? { title_source: 'ai' } : { title_source: 'manual', ...(title ? { recommended_title: title } : {}) }

  const { error: upErr } = await db
    .from('listing_seo_recommendations')
    .update(update)
    .eq('parent_asin', parentAsin)
  if (upErr) {
    // The lock column is migration 044. If it is not applied, FAIL LOUDLY (do not silently pretend the
    // lock saved — that is exactly the silent-fallback bug that dropped the lock on B0FRYMM56C).
    console.error('[lock-title] update failed (migration 044 applied?):', upErr.message)
    return NextResponse.json({ error: `Lock write failed: ${upErr.message}. Confirm migration 044 (title_source) is applied.` }, { status: 500 })
  }

  // Best-effort audit-log row (never blocks the response).
  try {
    const myName = await resolveUserName(user.id, user.email)
    const afterValue = action === 'lock' && title ? title : before
    // TRUTH STAMP only on an actual LOCK of a non-empty title — an unlock's after_value is just the
    // prior value re-stated (no new title chosen), so there is nothing new to vet.
    const stamp = action === 'lock' && title
      ? await lockTitleTruthStamp(db, parentAsin, title)
      : { title_truth_ok: null, title_truth_reason: null }
    // action MUST be one of the listing_change_log CHECK set (037: edit/ai_generate/ai_regenerate/push/
    // claim/release/takeover) — 'lock'/'unlock' would violate the constraint and be silently swallowed, so
    // we log it as 'edit' and encode lock vs unlock in the field label so the timeline still reads clearly.
    await db.from('listing_change_log').insert({
      parent_asin: parentAsin, sku: null, field: action === 'lock' ? 'title (locked)' : 'title (unlocked)', action: 'edit',
      before_value: before, after_value: afterValue,
      changed_by: user.id, changed_by_name: myName, source: 'manual_edit',
      ...stamp,
    })
  } catch (e) { console.warn('[lock-title] change-log insert failed:', e instanceof Error ? e.message : e) }

  return NextResponse.json({
    ok: true,
    title_source: update.title_source,
    recommended_title: action === 'lock' && title ? title : before,
  })
}
