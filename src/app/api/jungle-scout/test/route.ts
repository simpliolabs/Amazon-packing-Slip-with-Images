/**
 * GET /api/jungle-scout/test
 * Debug endpoint — calls JS API and returns raw response for diagnosis
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const asin = searchParams.get('asin') || 'B0FK9NKZBV';

  try {
    const supabase = await createAdminClient();

    // Get credentials from DB
    const { data: rows } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', ['jungle_scout_api_key', 'jungle_scout_key_name', 'jungle_scout_enabled']);

    const settings: Record<string, string> = {};
    for (const row of rows ?? []) {
      settings[(row as { key: string; value: string }).key] = (row as { key: string; value: string }).value;
    }

    const apiKey = settings['jungle_scout_api_key'] ?? '';
    const keyName = settings['jungle_scout_key_name'] ?? '';

    if (!apiKey || !keyName) {
      return NextResponse.json({ error: 'No credentials found in DB', settings: Object.keys(settings) });
    }

    // Make the actual JS API call
    const authHeader = `${keyName}:${apiKey}`;
    const url = `https://developer.junglescout.com/api/keywords/keywords_by_asin_query?marketplace=us&sort=-monthly_search_volume_exact&page[size]=50`;

    const body = JSON.stringify({
      data: {
        type: 'keywords_by_asin_query',
        attributes: {
          asins: [asin],
          include_variants: false,
        },
      },
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.junglescout.v1+json',
        'X-API-Type': 'junglescout',
      },
      body,
    });

    const responseText = await resp.text();
    let responseJson = null;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      // not JSON
    }

    return NextResponse.json({
      debug: {
        asin,
        keyName,
        keyPrefix: apiKey.slice(0, 4) + '...',
        authHeaderFormat: `${keyName}:${apiKey.slice(0, 4)}...`,
        url,
        requestBody: JSON.parse(body),
        responseStatus: resp.status,
        responseHeaders: Object.fromEntries(resp.headers.entries()),
        responseJson: responseJson,
        responseText: responseJson ? undefined : responseText.slice(0, 500),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
