/**
 * syncKeywordData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches Brand Analytics Search Query Performance (SQP) data for a given
 * child ASIN from the Amazon SP-API, then runs the keyword engine and stores
 * results in the DB.
 *
 * Flow:
 *   1. Check keyword_cache for fresh data (< 30 days old)
 *   2. If cache miss → fetch SQP from SP-API
 *   3. Store raw response in keyword_cache
 *   4. Run keyword engine (presence + score + actions)
 *   5. Store analyzed results in keyword_analysis
 *   6. Return EngineResult
 *
 * Karpathy principle: Think before coding.
 * SQP only returns data for ASINs with sales history.
 * If no data returned → flag as 'no_sqp_data' and fall back to sibling inheritance.
 */

import { createClient } from '@supabase/supabase-js';
import { getAccessToken } from '@/lib/amazon/auth';
import { gunzipSync } from 'zlib';
import {
  getCachedKeywords,
  setCachedKeywords,
  storeAnalysis,
  logApiCall,
  runKeywordEngine,
  SQPKeywordRow,
  EngineResult,
  ListingContent,
} from '../keyword-engine';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── SP-API SQP Fetcher ───────────────────────────────────────────────────────

/**
 * Fetch SQP data from SP-API for a given ASIN.
 * Uses the existing sp-api-client pattern from the codebase.
 */
async function fetchSQPFromAPI(asin: string): Promise<SQPKeywordRow[]> {
  // Use the shared getAccessToken() which reads credentials from Supabase app_settings
  // (same pattern as syncListings.ts, syncSalesReport.ts, etc.)
  const access_token = await getAccessToken();

  // Calculate date range: last full month
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startDate = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`;
  const endDate = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-${new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0).getDate()}`;

  // Step 1: Create SQP report
  // Uses GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT (not SEARCH_TERMS which is a
  // different report showing top ASINs by keyword for the whole marketplace).
  // SQP accepts: asin (Required, space-separated) + reportPeriod (Required)
  const createResp = await fetch(
    'https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports',
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID ?? 'ATVPDKIKX0DER'],
        reportOptions: {
          asin: asin,
          reportPeriod: 'MONTH',
        },
        dataStartTime: startDate,
        dataEndTime: endDate,
      }),
    }
  );

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`SQP report creation failed: ${createResp.status} ${err}`);
  }

  const { reportId } = await createResp.json();

  // Step 2: Poll for report completion (max 5 minutes)
  let reportDocumentId: string | null = null;
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, 10000)); // 10s between polls

    const statusResp = await fetch(
      `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${reportId}`,
      { headers: { 'x-amz-access-token': access_token } }
    );

    if (!statusResp.ok) continue;

    const statusData = await statusResp.json();

    if (statusData.processingStatus === 'DONE') {
      reportDocumentId = statusData.reportDocumentId;
      break;
    } else if (statusData.processingStatus === 'FATAL' || statusData.processingStatus === 'CANCELLED') {
      throw new Error(`SQP report failed with status: ${statusData.processingStatus}`);
    }
    // PROCESSING or IN_QUEUE — keep polling
  }

  if (!reportDocumentId) {
    throw new Error('SQP report timed out after 5 minutes');
  }

  // Step 3: Get document URL and compression info
  const docResp = await fetch(
    `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${reportDocumentId}`,
    { headers: { 'x-amz-access-token': access_token } }
  );

  if (!docResp.ok) {
    throw new Error(`Failed to get report document: ${docResp.status}`);
  }

  const { url, compressionAlgorithm } = await docResp.json();

  // Step 4: Download and decompress the report (SP-API reports are often GZIP compressed)
  const dataResp = await fetch(url);
  if (!dataResp.ok) {
    throw new Error(`Failed to download report: ${dataResp.status}`);
  }

  let rawText: string;
  if (compressionAlgorithm === 'GZIP') {
    const buffer = Buffer.from(await dataResp.arrayBuffer());
    rawText = gunzipSync(buffer).toString('utf-8');
  } else {
    rawText = await dataResp.text();
  }

  const rawData = JSON.parse(rawText);

  // Step 5: Extract keyword rows from the SQP response.
  // Schema: dataByAsin is a flat array — one entry per (ASIN, searchQuery) combination.
  // totalMedianClickPrice is an object {amount, currencyCode}, not a plain number.
  const rows: SQPKeywordRow[] = [];

  if (rawData?.dataByAsin) {
    for (const entry of rawData.dataByAsin) {
      if (entry.asin !== asin) continue;
      rows.push({
        searchQuery: entry.searchQueryData?.searchQuery ?? '',
        searchQueryScore: entry.searchQueryData?.searchQueryScore ?? 50,
        searchQueryVolume: entry.searchQueryData?.searchQueryVolume ?? 0,
        totalQueryImpressionCount: entry.impressionData?.totalQueryImpressionCount ?? 0,
        asinImpressionCount: entry.impressionData?.asinImpressionCount ?? 0,
        asinImpressionShare: entry.impressionData?.asinImpressionShare ?? 0,
        totalClickCount: entry.clickData?.totalClickCount ?? 0,
        asinClickCount: entry.clickData?.asinClickCount ?? 0,
        asinClickShare: entry.clickData?.asinClickShare ?? 0,
        // totalMedianClickPrice is {amount, currencyCode} in the API response
        totalMedianClickPrice: entry.clickData?.totalMedianClickPrice?.amount ?? 0,
        totalCartAddCount: entry.cartAddData?.totalCartAddCount ?? 0,
        asinCartAddCount: entry.cartAddData?.asinCartAddCount ?? 0,
        asinCartAddShare: entry.cartAddData?.asinCartAddShare ?? 0,
        totalPurchaseCount: entry.purchaseData?.totalPurchaseCount ?? 0,
        asinPurchaseCount: entry.purchaseData?.asinPurchaseCount ?? 0,
        asinPurchaseShare: entry.purchaseData?.asinPurchaseShare ?? 0,
      });
    }
  }

  return rows;
}

// ─── Listing Content Fetcher ──────────────────────────────────────────────────

async function fetchListingContent(asin: string): Promise<ListingContent | null> {
  const { data } = await supabase
    .from('listing_content')
    .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
    .eq('asin', asin)
    .single();

  return data ?? null;
}

// ─── Sibling Inheritance ──────────────────────────────────────────────────────

/**
 * For zero-sales ASINs: find sibling ASINs in the same category that DO have
 * keyword data, and inherit their top keywords as 'inherited' source.
 */
async function findSiblingKeywords(asin: string): Promise<SQPKeywordRow[]> {
  // Get the ASIN's parent to find siblings in the same product family
  const { data: listing } = await supabase
    .from('listing_content')
    .select('parent_asin')
    .eq('asin', asin)
    .single();

  if (!listing?.parent_asin) return [];

  // Find sibling ASINs in the same parent family that have keyword data
  const { data: siblings } = await supabase
    .from('listing_content')
    .select('asin')
    .eq('parent_asin', listing.parent_asin)
    .neq('asin', asin)
    .limit(5);

  if (!siblings || siblings.length === 0) return [];

  // Get keyword cache for siblings
  const siblingAsins = siblings.map(s => s.asin);
  const { data: cacheRows } = await supabase
    .from('keyword_cache')
    .select('keyword_data')
    .in('asin', siblingAsins)
    .eq('source', 'sqp')
    .gt('expires_at', new Date().toISOString())
    .limit(3);

  if (!cacheRows || cacheRows.length === 0) return [];

  // Merge and deduplicate keywords from siblings
  const keywordMap = new Map<string, SQPKeywordRow>();
  for (const row of cacheRows) {
    for (const kw of (row.keyword_data as SQPKeywordRow[]) ?? []) {
      if (!keywordMap.has(kw.searchQuery)) {
        keywordMap.set(kw.searchQuery, kw);
      }
    }
  }

  return Array.from(keywordMap.values());
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

export async function syncKeywordData(asin: string): Promise<EngineResult> {
  // Step 1: Check cache
  const cached = await getCachedKeywords(asin, 'sqp');
  let rawKeywords: SQPKeywordRow[];
  let dataSource: 'sqp' | 'inherited' = 'sqp';

  if (cached && cached.length > 0) {
    rawKeywords = cached as SQPKeywordRow[];
  } else {
    // Step 2: Fetch from SP-API
    try {
      rawKeywords = await fetchSQPFromAPI(asin);
      await logApiCall('sqp', 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [asin], 200);

      if (rawKeywords.length > 0) {
        // Cache the raw response
        await setCachedKeywords(asin, 'sqp', rawKeywords);
      } else {
        // No SQP data — fall back to sibling inheritance
        rawKeywords = await findSiblingKeywords(asin);
        dataSource = 'inherited';
      }
    } catch (err) {
      console.error(`[syncKeywordData] SQP fetch failed for ${asin}:`, err);
      await logApiCall('sqp', 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [asin], 500);
      // Fall back to sibling inheritance on error
      rawKeywords = await findSiblingKeywords(asin);
      dataSource = 'inherited';
    }
  }

  // Step 3: Fetch listing content for presence checking
  let listing = await fetchListingContent(asin);

  // Fallback: if child ASIN has no content yet (race condition with listing sync),
  // try to find a sibling in the same parent family that DOES have content.
  // This prevents storing all-false presence flags that make everything CRITICAL.
  if (!listing || !listing.title) {
    const { data: parentRow } = await supabase
      .from('listing_content')
      .select('parent_asin')
      .eq('asin', asin)
      .single();

    if (parentRow?.parent_asin) {
      const { data: sibling } = await supabase
        .from('listing_content')
        .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
        .eq('parent_asin', parentRow.parent_asin)
        .not('title', 'is', null)
        .limit(1)
        .single();

      if (sibling?.title) {
        listing = sibling;
        console.log(`[syncKeywordData] Using sibling content for presence check (child ${asin} has no content yet)`);
      }
    }
  }

  // Guard: if we STILL have no listing content, do NOT store results with all-false presence.
  // Return empty result so the UI shows "Run listing sync first" instead of stale data.
  if (!listing || !listing.title) {
    console.warn(`[syncKeywordData] No listing content found for ${asin} or siblings. Skipping engine run.`);
    return {
      asin,
      allKeywords: [],
      topOpportunities: [],
      totalKeywordsAnalyzed: 0,
      summary: { critical: 0, upgrade: 0, reinforce: 0, defended: 0, optimized: 0 },
      dataSource,
      analyzedAt: new Date().toISOString(),
    };
  }

  // Step 4: Run keyword engine
  const result = runKeywordEngine(asin, rawKeywords, listing, dataSource);

  // Step 5: Store analysis results
  if (result.allKeywords.length > 0) {
    await storeAnalysis(asin, result.allKeywords);
  }

  return result;
}
