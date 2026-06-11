/**
 * shareSnapshots.ts — PHASE 1 of the outcome loop (task #89): capture the per-keyword SQP share
 * time-series. SQP impression/click/purchase share is ONLY in scope at sync time — the engine drops it
 * before storage (getStoredAnalysis returns share=0) — so this is the ONLY persistent record of share
 * over time. One row per (asin, keyword, SQP data-month); the content_fingerprint marks the content epoch
 * so the signal can later detect "share moved AFTER a content change". Best-effort: a snapshot failure
 * (incl. a not-yet-migrated table) NEVER breaks the keyword sync.
 */
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AnalyzedKeyword } from './engine'
import type { ListingContent } from './checkPresence'

/** sha1 of the live copy — same format as rankAnalysis.contentFingerprint (lowercased, space-collapsed). */
function fingerprintOf(listing: ListingContent): string {
  const hay = [
    listing.title, listing.bullet_1, listing.bullet_2, listing.bullet_3,
    listing.bullet_4, listing.bullet_5, listing.description, listing.backend_keywords,
  ].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha1').update(hay).digest('hex')
}

/** Last full calendar month's end date (YYYY-MM-DD) — the period the SQP report covers. Mirrors the date
 *  logic in syncKeywordData.fetchSQPFromAPI so two syncs in the same data-month dedup to one row. */
function lastFullMonthEndDate(): string {
  const now = new Date()
  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastDay = new Date(lm.getFullYear(), lm.getMonth() + 1, 0).getDate()
  return `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
}

/**
 * Upsert one share snapshot per keyword for `asin`. Only TRUE SQP keywords are snapshotted — inherited /
 * Jungle-Scout rows carry asinImpressionShare=0 and would poison the series with false zeros.
 */
export async function captureShareSnapshots(
  asin: string,
  sqpKeywords: AnalyzedKeyword[],
  listing: ListingContent,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    const snapshotDate = lastFullMonthEndDate()
    const fingerprint = fingerprintOf(listing)
    const rows = sqpKeywords
      .filter((k) => k.dataSource === 'sqp' && k.keyword)
      .map((k) => ({
        asin,
        keyword: k.keyword,
        snapshot_date: snapshotDate,
        impression_share: Number.isFinite(k.asinImpressionShare) ? k.asinImpressionShare : null,
        click_share: Number.isFinite(k.asinClickShare) ? k.asinClickShare : null,
        purchase_share: Number.isFinite(k.asinPurchaseShare) ? k.asinPurchaseShare : null,
        search_volume: Number.isFinite(k.searchVolume) ? k.searchVolume : null,
        content_fingerprint: fingerprint,
      }))
    if (rows.length === 0) return
    // Batch upsert (chunks of 100, same as storeAnalysis). onConflict dedups same-month re-syncs.
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase
        .from('keyword_share_snapshots')
        .upsert(rows.slice(i, i + 100), { onConflict: 'asin,keyword,snapshot_date' })
      if (error) {
        // Most likely the table isn't migrated yet — log once and stop, never throw out of the sync.
        console.warn(`[shareSnapshots] snapshot upsert skipped for ${asin} (non-fatal):`, error.message)
        return
      }
    }
  } catch (err) {
    console.warn(`[shareSnapshots] capture skipped for ${asin} (non-fatal):`, err instanceof Error ? err.message : String(err))
  }
}
