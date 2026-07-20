/**
 * feedsSubmit.ts — JSON_LISTINGS_FEED submission for the parent-hub Strategy-5 fallback (Path Z,
 * 2026-07-20 deep-dive).
 *
 * WHY THIS EXISTS: `patchListingsItem` returns HTTP 200 ACCEPTED then asynchronously DISCARDS the write
 * on variation-parent hubs missing conditionally-required family attributes. All 4 healParentComposite
 * strategies live on this same PATCH surface and inherit the silent-drop. `JSON_LISTINGS_FEED` with
 * `header.report.includedData = ["issues"]` is the ONLY Amazon surface that returns the *async
 * business-validation* issues in machine-readable snake_case. This module is a THIN wrapper around the
 * 5-step Feeds API flow, used ONLY as Strategy 5 (last-resort) after Strategies 1-4 exit no-progress.
 *
 * SCOPE — deliberately narrow per karpathy simplicity:
 *   - PARTIAL_UPDATE only (never UPDATE — full-replace risks de-linking the family within Amazon's
 *     15min-6h catalog-lag window).
 *   - LISTING_PRODUCT_ONLY requirements (parent hubs have no offer).
 *   - includedData: ["issues"] mandatory (without it, async validation issues are invisible — exactly
 *     the class of failure that made patchListingsItem look ACCEPTED but no-op).
 *   - No new tables, no new schema — result is returned in-memory so the caller (healParentComposite
 *     strategy 5) can map issues to snake_case keys and flag attention with actionable detail.
 *
 * FEATURE-FLAGGED: the caller only invokes this module when `process.env.PUSH_HEAL_FEEDS_FALLBACK === 'on'`.
 * Off = zero behavior change; the file is dormant until an operator flips the flag in Coolify.
 *
 * DOC CITATIONS (all load-bearing):
 *   - https://developer-docs.amazon.com/sp-api/docs/building-listings-management-workflows-guide
 *   - https://developer-docs.amazon.com/sp-api/changelog/update-json_listings_feed-now-includes-includeddata
 *   - https://developer-docs.amazon.com/sp-api/docs/listing-workflow-migration-tutorial
 *   - https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem  (contrast — the surface we're bypassing)
 *   - Community: amzn/selling-partner-api-models #439, #2489, discussions #4700 / #4672
 */
import zlib from 'node:zlib'
import { ENDPOINT, MARKETPLACE_ID, getSellerId } from '@/lib/fba/pushExecutor'
import { getAccessToken } from '@/lib/amazon/auth'
import { spApiWriteBucket, spApiReadBucket } from '@/lib/fba/spApiRateLimiter'

/** Per-issue shape from the JSON_LISTINGS_FEED processing report. */
export interface FeedIssue {
  messageId?: number
  code?: string
  severity?: 'ERROR' | 'WARNING' | 'INFO'
  message?: string
  attributeNames?: string[]
  categories?: string[]
}

/** Terminal result of one Feeds submission, returned to the caller (healParentComposite). */
export interface FeedResult {
  /** DONE | FATAL | CANCELLED | TIMEOUT (our own — poll gave up) */
  processingStatus: 'DONE' | 'FATAL' | 'CANCELLED' | 'TIMEOUT' | 'ERROR'
  /** Amazon feedId — persisted in caller's log rows for cross-reference. */
  feedId: string | null
  /** ERROR-severity issues from the report (Amazon's SNAKE_CASE attribute names — the whole point). */
  errorIssues: FeedIssue[]
  /** WARNING-severity issues (for logs; not a failure signal). */
  warningIssues: FeedIssue[]
  /** summary.messagesAccepted from the report. 0 = every message rejected. */
  messagesAccepted: number
  /** summary.messagesProcessed from the report. */
  messagesProcessed: number
  /** Any short error string for the caller's fail() log. Null on DONE with 0 errors. */
  errorMessage: string | null
}

const FEEDS_ENDPOINT = `${ENDPOINT}/feeds/2021-06-30`

/** Adaptive poll: 10s → 20s → 40s → 60s (cap). Terminal 6 min so a single-message parent-hub feed
 *  fits inside the cron-verify-pushes route's maxDuration=600s (=10 min) with buffer for the caller's
 *  own read-back + logging. Community-reported median for JSON_LISTINGS_FEED w/ includedData=issues
 *  is 30s-5min for a single-message payload (empirical, no Amazon SLA). If a feed takes longer, we
 *  return TIMEOUT with the feedId so the operator can trace it in Seller Central Feed Log; the
 *  Amazon-side processing continues either way (no duplicate submission risk on next cron cycle
 *  because heal tasks are only re-enqueued when they hit terminal states in our own state). */
const POLL_INTERVALS_MS = [10_000, 20_000, 40_000]
const POLL_CAP_MS = 60_000
const POLL_TERMINAL_MS = 6 * 60 * 1000

/** STEP 1 — createFeedDocument: get a presigned S3 URL to upload the feed body to.
 *  The contentType on THIS call MUST byte-match the Content-Type of the subsequent PUT or Amazon
 *  returns 403 SignatureDoesNotMatch on the S3 PUT (spec §submission_flow). */
async function createFeedDocument(token: string): Promise<{ feedDocumentId: string; url: string }> {
  await spApiWriteBucket.acquire()
  const resp = await fetch(`${FEEDS_ENDPOINT}/documents`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ contentType: 'application/json; charset=UTF-8' }),
  })
  if (!resp.ok) throw new Error(`createFeedDocument HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const j = (await resp.json()) as { feedDocumentId?: string; url?: string }
  if (!j.feedDocumentId || !j.url) throw new Error('createFeedDocument: missing feedDocumentId or url in response')
  return { feedDocumentId: j.feedDocumentId, url: j.url }
}

/** STEP 2 — PUT the body to the presigned S3 URL. NO SP-API auth on this call (the presigned URL
 *  carries its own signature). Content-Type MUST byte-match Step 1. */
async function uploadFeedBody(presignedUrl: string, body: string): Promise<void> {
  const resp = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body,
  })
  if (!resp.ok) throw new Error(`S3 uploadFeedBody HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
}

/** STEP 3 — createFeed: queue the feed for processing. Returns Amazon's feedId (numeric string). */
async function createFeed(token: string, feedDocumentId: string): Promise<string> {
  await spApiWriteBucket.acquire()
  const resp = await fetch(`${FEEDS_ENDPOINT}/feeds`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({
      feedType: 'JSON_LISTINGS_FEED',
      marketplaceIds: [MARKETPLACE_ID],
      inputFeedDocumentId: feedDocumentId,
    }),
  })
  if (!resp.ok) throw new Error(`createFeed HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const j = (await resp.json()) as { feedId?: string }
  if (!j.feedId) throw new Error('createFeed: missing feedId in response')
  return j.feedId
}

/** STEP 4 — poll getFeed until terminal. Adaptive backoff + wall-clock timeout. */
async function pollUntilTerminal(token: string, feedId: string): Promise<{ processingStatus: string; resultFeedDocumentId: string | null }> {
  const started = Date.now()
  let intervalIdx = 0
  while (Date.now() - started < POLL_TERMINAL_MS) {
    const nextWait = intervalIdx < POLL_INTERVALS_MS.length ? POLL_INTERVALS_MS[intervalIdx] : POLL_CAP_MS
    await new Promise((r) => setTimeout(r, nextWait))
    intervalIdx++
    await spApiReadBucket.acquire()
    const resp = await fetch(`${FEEDS_ENDPOINT}/feeds/${feedId}`, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) continue   // transient — keep polling (Amazon rate-limits getFeed at 2 req/sec)
    const j = (await resp.json()) as { processingStatus?: string; resultFeedDocumentId?: string }
    const s = j.processingStatus ?? ''
    if (s === 'DONE' || s === 'FATAL' || s === 'CANCELLED') {
      return { processingStatus: s, resultFeedDocumentId: j.resultFeedDocumentId ?? null }
    }
  }
  return { processingStatus: 'TIMEOUT', resultFeedDocumentId: null }
}

/** STEP 5 — getFeedDocument (metadata) + follow the presigned URL for the compressed report,
 *  then gunzip + parse. Returns null on any read/parse failure (caller treats as unknown). */
async function fetchFeedReport(token: string, resultFeedDocumentId: string): Promise<{
  errorIssues: FeedIssue[]; warningIssues: FeedIssue[]; messagesAccepted: number; messagesProcessed: number
} | null> {
  try {
    await spApiReadBucket.acquire()
    const meta = await fetch(`${FEEDS_ENDPOINT}/documents/${resultFeedDocumentId}`, {
      headers: { 'x-amz-access-token': token },
    })
    if (!meta.ok) return null
    const metaJson = (await meta.json()) as { url?: string; compressionAlgorithm?: string }
    if (!metaJson.url) return null
    const reportResp = await fetch(metaJson.url)   // presigned; no SP-API auth
    if (!reportResp.ok) return null
    const bytes = new Uint8Array(await reportResp.arrayBuffer())
    const raw = metaJson.compressionAlgorithm === 'GZIP'
      ? zlib.gunzipSync(bytes).toString('utf-8')
      : new TextDecoder('utf-8').decode(bytes)
    const parsed = JSON.parse(raw) as {
      summary?: { messagesProcessed?: number; messagesAccepted?: number; errors?: number; warnings?: number }
      issues?: FeedIssue[]
    }
    const issues = parsed.issues ?? []
    return {
      errorIssues: issues.filter((i) => i.severity === 'ERROR'),
      warningIssues: issues.filter((i) => i.severity === 'WARNING'),
      messagesAccepted: parsed.summary?.messagesAccepted ?? 0,
      messagesProcessed: parsed.summary?.messagesProcessed ?? 0,
    }
  } catch { return null }
}

/** PUBLIC: submit ONE parent-hub PARTIAL_UPDATE via JSON_LISTINGS_FEED. Returns a terminal FeedResult
 *  the caller (healParentComposite strategy 5) can either short-circuit on (accepted with 0 errors) or
 *  escalate on (errors surface real snake_case attribute names). Never throws — errors become the
 *  errorMessage field so the caller can fail() cleanly. */
export async function submitJsonListingsFeed(args: {
  sku: string
  productType: string
  attributes: Record<string, unknown>
}): Promise<FeedResult> {
  const empty: FeedResult = { processingStatus: 'ERROR', feedId: null, errorIssues: [], warningIssues: [], messagesAccepted: 0, messagesProcessed: 0, errorMessage: null }
  try {
    const token = await getAccessToken()
    const sellerId = await getSellerId()
    const body = JSON.stringify({
      header: {
        sellerId,
        version: '2.0',
        issueLocale: 'en_US',
        // includedData:['issues'] is REQUIRED for async business-validation issues to surface. Without
        // it the entire dead-token class is invisible — exactly the failure mode this module exists to
        // diagnose (spec §submission_flow, developer-docs.amazon.com update-json_listings_feed…).
        report: { includedData: ['issues'], apiVersion: '2021-08-01' },
      },
      messages: [{
        messageId: 1,
        sku: args.sku,
        // 2026-07-20 fix: v2.0 message schema requires operationType='PATCH' with a `patches` array
        // in JSON-Patch shape — our prior PARTIAL_UPDATE + attributes shape was rejected by Amazon
        // pre-processing with '#: required key [patches] not found' + '#/operationType:' (queue log
        // 2026-07-20T21:01Z on B0FKKN8XKV, task ebeb4980-3781-4530-81cf-6d13716d2cdd). PATCH
        // semantics are also STRICTLY additive per attribute (no risk of family de-link — every
        // attribute NOT named in a patches[] entry is left untouched).
        operationType: 'PATCH',
        productType: args.productType,
        requirements: 'LISTING_PRODUCT_ONLY',
        patches: Object.entries(args.attributes).map(([attr, value]) => ({
          op: 'replace' as const,
          path: `/attributes/${attr}`,
          value,
        })),
      }],
    })
    const { feedDocumentId, url } = await createFeedDocument(token)
    await uploadFeedBody(url, body)
    const feedId = await createFeed(token, feedDocumentId)
    const term = await pollUntilTerminal(token, feedId)
    if (term.processingStatus === 'TIMEOUT') {
      return { ...empty, processingStatus: 'TIMEOUT', feedId, errorMessage: `feed ${feedId} did not reach terminal in ${Math.round(POLL_TERMINAL_MS / 60000)}m — Amazon queue backlog. Not retrying automatically; next heal-cron cycle will pick this up if the flag is still on.` }
    }
    if (term.processingStatus === 'FATAL' || term.processingStatus === 'CANCELLED') {
      const rep = term.resultFeedDocumentId ? await fetchFeedReport(token, term.resultFeedDocumentId) : null
      const firstIssue = rep?.errorIssues?.[0]?.message ?? '(no result document)'
      return { ...empty, processingStatus: term.processingStatus, feedId, errorIssues: rep?.errorIssues ?? [], warningIssues: rep?.warningIssues ?? [], messagesAccepted: rep?.messagesAccepted ?? 0, messagesProcessed: rep?.messagesProcessed ?? 0, errorMessage: `feed ${feedId} terminal=${term.processingStatus}: ${String(firstIssue).slice(0, 240)}` }
    }
    // DONE — read the processing report even on 0 errors (want to capture WARNINGS + accepted count).
    const rep = term.resultFeedDocumentId ? await fetchFeedReport(token, term.resultFeedDocumentId) : null
    if (!rep) return { ...empty, processingStatus: 'DONE', feedId, errorMessage: `feed ${feedId} DONE but result document unreadable — cannot classify` }
    return {
      processingStatus: 'DONE',
      feedId,
      errorIssues: rep.errorIssues,
      warningIssues: rep.warningIssues,
      messagesAccepted: rep.messagesAccepted,
      messagesProcessed: rep.messagesProcessed,
      errorMessage: rep.errorIssues.length > 0 ? `${rep.errorIssues.length} error(s): ${String(rep.errorIssues[0].message ?? '').slice(0, 200)}` : null,
    }
  } catch (e) {
    return { ...empty, processingStatus: 'ERROR', errorMessage: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) }
  }
}

/** PUBLIC: extract snake_case attribute keys from feed issues so the caller can intersect with
 *  COMPOSITE_HEAL_SPECS / BROADCAST_HEALABLE and enqueue a targeted heal (mirrors the same map
 *  rejectedAttrKeysFrom does at pushExecutor.ts:2715 for sync PATCH errors). Feeds reliably returns
 *  snake_case in attributeNames (unlike PATCH which sometimes returns display form — the very bug
 *  this module escapes). */
export function mapFeedIssuesToRejectedKeys(issues: FeedIssue[]): string[] {
  const out = new Set<string>()
  for (const i of issues) {
    for (const n of i.attributeNames ?? []) if (typeof n === 'string' && /^[a-z][a-z0-9_]{2,}$/.test(n)) out.add(n)
    // Also parse bracketed data-paths in message text — parity with rejectedAttrKeysFrom's fallback.
    const m = String(i.message ?? '').toLowerCase().match(/\[([a-z0-9_#?.,\s]+)\]/)
    if (m) {
      for (const tok of m[1].split(/[,\s]+/).filter(Boolean)) {
        const base = tok.split(/[#.]/)[0].trim()
        const leaf = tok.includes('.') ? (tok.split('.').pop() ?? '').replace(/[#?]/g, '').trim() : ''
        for (const t of [base, leaf]) if (/^[a-z][a-z0-9_]{2,}$/.test(t)) out.add(t)
      }
    }
  }
  return [...out]
}
