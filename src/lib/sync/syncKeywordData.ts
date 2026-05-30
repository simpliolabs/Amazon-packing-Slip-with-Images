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
  const createResp = await fetch(
    'https://sellingpartnerapi-na.amazon.com/analytics/v1/reports',
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
        marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID ?? 'ATVPDKIKX0DER'],
        reportOptions: {
          reportPeriod: 'MONTH',
          asinList: [asin],
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
      `https://sellingpartnerapi-na.amazon.com/analytics/v1/reports/${reportId}`,
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

  // Step 3: Get document URL
  const docResp = await fetch(
    `https://sellingpartnerapi-na.amazon.com/analytics/v1/reports/documents/${reportDocumentId}`,
    { headers: { 'x-amz-access-token': access_token } }
  );

  if (!docResp.ok) {
    throw new Error(`Failed to get report document: ${docResp.status}`);
  }

  const { url } = await docResp.json();

  // Step 4: Download and parse the report
  const dataResp = await fetch(url);
  if (!dataResp.ok) {
    throw new Error(`Failed to download report: ${dataResp.status}`);
  }

  const rawData = await dataResp.json();

  // Step 5: Extract keyword rows from the nested SQP structure
  const rows: SQPKeywordRow[] = [];

  if (rawData?.dataByAsin) {
    for (const asinData of rawData.dataByAsin) {
      if (asinData.asin !== asin) continue;
      for (const entry of asinData.searchTerms ?? []) {
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
          totalMedianClickPrice: entry.clickData?.totalMedianClickPrice ?? 0,
          totalCartAddCount: entry.cartAddData?.totalCartAddCount ?? 0,
          asinCartAddCount: entry.cartAddData?.asinCartAddCount ?? 0,
          asinCartAddShare: entry.cartAddData?.asinCartAddShare ?? 0,
          totalPurchaseCount: entry.purchaseData?.totalPurchaseCount ?? 0,
          asinPurchaseCount: entry.purchaseData?.asinPurchaseCount ?? 0,
          asinPurchaseShare: entry.purchaseData?.asinPurchaseShare ?? 0,
        });
      }
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
  const listing = await fetchListingContent(asin);

  // Step 4: Run keyword engine
  const result = runKeywordEngine(asin, rawKeywords, listing ?? {}, dataSource);

  // Step 5: Store analysis results
  if (result.allKeywords.length > 0) {
    await storeAnalysis(asin, result.allKeywords);
  }

  return result;
}
