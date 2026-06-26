/**
 * scoreHistory.ts — PHASE C, the EXPLICIT append helper for listing_score_history (spec §4-D / Risk
 * R-MIG1, the D-1 alternative chosen over a DB trigger).
 *
 * WHY A HELPER, NOT A TRIGGER: both supabase clients go through supabase-js/ssr → PostgREST
 * (src/lib/supabase/server.ts, client.ts); there is NO raw pg/DATABASE_URL connection, so a custom
 * transaction-local set_config('app.score_user', …) GUC carrier could never reach a pooled trigger.
 * The JWT-claims carrier (request.jwt.claims->>'sub') only works under an end-user JWT, but the
 * score write sites run as the SERVICE ROLE (sync/cron/push) where there is no 'sub'. An explicit,
 * greppable helper called at each write site demonstrably carries the acting user id (or null +
 * the right trigger label for service-role appends). The trade is the "forgotten 6th site" risk —
 * mitigated by this being a single grep target (`appendScoreHistory(`) and by all 5 known sites
 * calling it.
 *
 * CONDITIONAL APPEND: writes a row ONLY when overall_score OR content_fingerprint changed vs the
 * latest history row for this listing_key — so the top-50-per-sync re-scores at
 * syncListingContent.ts:1445 do NOT bloat the table with identical rows.
 *
 * content_fingerprint REUSES fingerprintOf() VERBATIM (shareSnapshots.ts) so a history row JOINs
 * keyword_share_snapshots.content_fingerprint by value (the shared epoch).
 *
 * Best-effort: a missing table / insert error NEVER throws out of the score write path (mirrors
 * captureShareSnapshots / logPushChange). It is observability, not a transaction the push depends on.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fingerprintOf } from '@/lib/keyword-engine/shareSnapshots'

export type ScoreHistoryTrigger =
  | 'scheduled_sync'      // syncListingContent full top-50 re-sync (:1445)
  | 'on_demand'           // ensureListingScored (:1310) — user opened/searched a listing
  | 'push'                // pushExecutor re-score after a successful push
  | 'outcome_resurface'   // the Phase C cron wrote a verdict that moved lifecycle_state
  | 'manual'              // an explicit operator-triggered re-score

/** The score row shape this helper reads. Compatible with the listing_seo_scores upsert payloads
 *  at syncListingContent.ts:1296 / :1455 and the pushExecutor re-score .update() payloads. Bullet/
 *  content fields are OPTIONAL because the push-path re-score reads them separately (see `content`). */
export interface ScoreRowForHistory {
  parent_asin?: string | null
  asin?: string | null
  overall_score?: number | null
  title_score?: number | null
  bullet_score?: number | null
  keyword_score?: number | null
  aplus_score?: number | null
  description_score?: number | null
  features_score?: number | null
  issues?: unknown[] | null
  lifecycle_state?: string | null
}

/** The live content used to fingerprint the scored copy (fingerprintOf VERBATIM). Pass the top
 *  child's row (or parent-own row) — the SAME content that was scored. */
export interface ScoredContent {
  title?: string | null
  bullet_1?: string | null; bullet_2?: string | null; bullet_3?: string | null
  bullet_4?: string | null; bullet_5?: string | null
  description?: string | null; backend_keywords?: string | null
}

export interface AppendScoreHistoryOpts {
  trigger: ScoreHistoryTrigger
  /** Acting user id (auth.users.id) or null for service-role/cron/sync appends. */
  scoredBy?: string | null
  /** Denormalized display name for the timeline (e.g. 'System (scheduled sync)'). */
  scoredByName?: string | null
  /** The live content that was scored — used to compute content_fingerprint via fingerprintOf().
   *  When omitted, content_fingerprint is left null (the row still records the score change-point). */
  content?: ScoredContent | null
  /** Pre-computed fingerprint when the caller already has it (e.g. the push hinge). Overrides `content`. */
  fingerprint?: string | null
}

/** listing_key = COALESCE(parent_asin, asin) — standalones self-parent (spec §4 grain rule). */
function listingKeyOf(row: ScoreRowForHistory): string | null {
  return row.parent_asin || row.asin || null
}

/**
 * Conditionally append one listing_score_history row. CHANGE-POINT ONLY: appends iff overall_score
 * OR content_fingerprint differs from the latest history row for this listing_key. Returns whether a
 * row was appended (mostly for tests/logging). Never throws.
 */
export async function appendScoreHistory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient | any,
  scoreRow: ScoreRowForHistory,
  opts: AppendScoreHistoryOpts,
): Promise<boolean> {
  try {
    const listingKey = listingKeyOf(scoreRow)
    if (!listingKey) return false

    const fingerprint =
      opts.fingerprint != null ? opts.fingerprint
      : opts.content ? fingerprintOf(opts.content as never)
      : null
    const overall = scoreRow.overall_score ?? null

    // CONDITIONAL: compare against the latest history row — append only on a change-point.
    const { data: latest } = await supabase
      .from('listing_score_history')
      .select('overall_score, content_fingerprint')
      .eq('listing_key', listingKey)
      .order('scored_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latest) {
      const prevOverall = (latest as { overall_score: number | null }).overall_score ?? null
      const prevFp = (latest as { content_fingerprint: string | null }).content_fingerprint ?? null
      const unchanged = prevOverall === overall && prevFp === fingerprint
      if (unchanged) return false
    }

    const issuesCount = Array.isArray(scoreRow.issues) ? scoreRow.issues.length : null
    const { error } = await supabase.from('listing_score_history').insert({
      listing_key:         listingKey,
      parent_asin:         scoreRow.parent_asin ?? null,
      overall_score:       overall,
      title_score:         scoreRow.title_score ?? null,
      bullet_score:        scoreRow.bullet_score ?? null,
      keyword_score:       scoreRow.keyword_score ?? null,
      aplus_score:         scoreRow.aplus_score ?? null,
      description_score:   scoreRow.description_score ?? null,
      features_score:      scoreRow.features_score ?? null,
      issues_count:        issuesCount,
      content_fingerprint: fingerprint,
      lifecycle_state:     scoreRow.lifecycle_state ?? null,
      trigger:             opts.trigger,
      scored_by:           opts.scoredBy ?? null,
      scored_by_name:      opts.scoredByName ?? null,
    })
    if (error) {
      // Most likely the 038 migration isn't applied yet — log once, never throw out of the score path.
      console.warn(`[scoreHistory] append skipped for ${listingKey} (non-fatal):`, error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[scoreHistory] append threw (non-fatal):', err instanceof Error ? err.message : String(err))
    return false
  }
}
