/**
 * POST /api/fba/keywords/import
 * ─────────────────────────────────────────────────────────────────────────────
 * Import COMPETITOR-PROVEN keywords from a Helium 10 Cerebro/Xray CSV export.
 *
 * WHY (the self-referential keyword trap, PO 2026-06-11): both native sources query OUR
 * ASIN — SQP returns queries we already get impressions for; Jungle Scout keywords-by-asin
 * returns terms we already rank for. The pool can never DISCOVER keywords competitors win
 * on ("college essentials" 33k/mo, "transparent sticky notes" 26k/mo were absent from a
 * sticky-notes family whose 25 keywords were all "post it / sticky note" permutations).
 * This endpoint lets the seller feed the H10 research they already pay for.
 *
 * Body: { parent_asin: string, csv: string }   // raw Cerebro/Xray export text
 *
 * Pipeline: parse CSV (header-mapped, quoted thousands-separated numbers) → map to the
 * engine's JungleScoutKeywordRow shape (real H10 Keyword Sales rides the relevancyScore
 * channel so the engine's sales proxy equals the REAL sales) → runKeywordEngine against
 * OUR live listing content (honest presence flags + the same 0-100 opportunity scoring
 * every native keyword gets) → ADDITIVE upsert into keyword_analysis (data_source='import';
 * existing keywords are never overwritten — native SQP/JS rows win).
 *
 * Downstream needs ZERO changes: regen reads getStoredAnalysis (these rows are in it),
 * the relevance gate + brand-safety judge filter off-product/branded terms from copy,
 * and the scorer counts the new CRITICALs — which is the point: real gaps now dock.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { runKeywordEngine, type JungleScoutKeywordRow } from '@/lib/keyword-engine/engine'

export const maxDuration = 60

/** Minimal CSV parser that survives quoted fields with embedded commas ("2,534"). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

const num = (s: string | undefined): number => {
  const n = parseInt(String(s ?? '').replace(/[",\s%$]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

export async function POST(req: NextRequest) {
  try {
    const { parent_asin, csv } = (await req.json()) as { parent_asin?: string; csv?: string }
    if (!parent_asin || !csv || typeof csv !== 'string') {
      return NextResponse.json({ error: 'parent_asin and csv are required' }, { status: 400 })
    }
    if (csv.length > 2_000_000) {
      return NextResponse.json({ error: 'CSV too large (2MB max)' }, { status: 400 })
    }

    const table = parseCsv(csv)
    if (table.length < 2) return NextResponse.json({ error: 'CSV has no data rows' }, { status: 400 })

    // Header-mapped columns — tolerant of H10's wording drift between Cerebro/Xray exports.
    const header = table[0].map((h) => h.toLowerCase().trim())
    const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)))
    const cKw = col('keyword phrase', 'keyword')
    const cVol = col('search volume')
    const cSales = col('keyword sales')
    const cComp = col('competing products')
    const cRank = col('organic rank')
    const cTd = col('title density')
    if (cKw === -1 || cVol === -1) {
      return NextResponse.json({ error: `Couldn't find "Keyword Phrase" / "Search Volume" columns. Headers seen: ${table[0].join(', ')}` }, { status: 400 })
    }

    const supabase = await createAdminClient()
    // keyword_analysis isn't in the generated Supabase types (same as listing_rank_analysis) — cast once.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any

    // Resolve the analysis ASIN exactly like the regen does (one keyword home per family).
    const { data: scoreRow } = await supabase
      .from('listing_seo_scores')
      .select('top_child_asin')
      .eq('parent_asin', parent_asin)
      .maybeSingle()
    let analysisAsin = (scoreRow as { top_child_asin?: string } | null)?.top_child_asin ?? null
    if (!analysisAsin) {
      const { data: anyChild } = await supabase
        .from('listing_content')
        .select('asin')
        .eq('parent_asin', parent_asin)
        .order('sku', { ascending: true })
        .limit(1)
      analysisAsin = (anyChild as { asin: string }[] | null)?.[0]?.asin ?? null
    }
    if (!analysisAsin) {
      return NextResponse.json({ error: 'No children found for this parent — run a Sync first.' }, { status: 404 })
    }

    // OUR live content for honest presence flags (same select every engine caller uses).
    const { data: listing } = await supabase
      .from('listing_content')
      .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
      .eq('asin', analysisAsin)
      .maybeSingle()

    // Existing keywords are never overwritten — native SQP/JS rows (and prior imports) win.
    const { data: existingRows } = await db
      .from('keyword_analysis')
      .select('keyword')
      .eq('asin', analysisAsin)
    const existing = new Set(((existingRows ?? []) as { keyword: string }[]).map((r) => r.keyword.toLowerCase().trim()))

    const seen = new Set<string>()
    const jsRows: JungleScoutKeywordRow[] = []
    // Title Density per keyword (H10-only metric, carried OUTSIDE the engine row shape and
    // re-attached after the engine run — TD 0-2 + volume = an easy title/highlights win).
    const tdByKeyword = new Map<string, number>()
    let skippedExisting = 0
    for (const r of table.slice(1)) {
      const keyword = (r[cKw] ?? '').trim().toLowerCase()
      if (!keyword || keyword.length > 120) continue
      if (seen.has(keyword)) continue
      seen.add(keyword)
      if (existing.has(keyword)) { skippedExisting++; continue }
      if (cTd >= 0 && String(r[cTd] ?? '').trim() !== '' && String(r[cTd]).trim() !== '-') tdByKeyword.set(keyword, num(r[cTd]))
      const sales = cSales >= 0 ? num(r[cSales]) : 0
      jsRows.push({
        keyword,
        searchVolume: num(r[cVol]),
        organicProductCount: cComp >= 0 ? num(r[cComp]) : 0,
        sponsoredProductCount: 0,
        // The engine's sales proxy is relevancyScore/5 — feed REAL H10 Keyword Sales through
        // that channel so keywordSales lands exactly (and sales-weighted scoring is honest).
        relevancyScore: sales > 0 ? sales * 5 : undefined,
        organicRank: cRank >= 0 ? num(r[cRank]) : undefined,
      })
    }

    // The engine drops volume<50 noise itself; presence runs against OUR live content.
    const result = runKeywordEngine(analysisAsin, jsRows, (listing ?? {}) as Parameters<typeof runKeywordEngine>[2], 'jungle_scout')
    const skippedLowVolume = jsRows.length - result.allKeywords.length

    // ADDITIVE insert (NOT cacheService.storeAnalysis — that deletes the whole ASIN's analysis).
    // data_source 'import' = honest provenance (migration 024 extends the CHECK).
    const rows = result.allKeywords.map((kw) => ({
      asin: analysisAsin,
      keyword: kw.keyword,
      opportunity_score: kw.opportunityScore,
      action_type: kw.actionType,
      action_text: kw.actionText,
      in_title: kw.inTitle,
      in_bullets: kw.inBullets,
      in_description: kw.inDescription,
      in_backend: kw.inBackend,
      search_volume: kw.searchVolume,
      competing_products: kw.competingProducts,
      keyword_sales: kw.keywordSales,
      title_density: tdByKeyword.get(kw.keyword.toLowerCase()) ?? null,
      data_source: 'import',
      analyzed_at: new Date().toISOString(),
    }))
    let inserted = 0
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100)
      const { error } = await db.from('keyword_analysis').upsert(chunk, { onConflict: 'asin,keyword', ignoreDuplicates: true })
      if (error) {
        // 23514 = CHECK violation → migration 024 missing; PGRST204/42703 = unknown column →
        // migration 025 (title_density) missing. Honest, actionable errors either way.
        const e = error as { code?: string; message?: string }
        const msg = e.code === '23514' || /check constraint/i.test(e.message ?? '')
          ? 'Migration 024 not applied — run 024_keyword_import_source.sql in Supabase, then retry.'
          : e.code === 'PGRST204' || e.code === '42703' || /title_density/i.test(e.message ?? '')
            ? 'Migration 025 not applied — run 025_keyword_title_density.sql in Supabase, then retry.'
            : e.message ?? 'insert failed'
        return NextResponse.json({ error: msg, imported: inserted }, { status: 500 })
      }
      inserted += chunk.length
    }

    const topNew = result.allKeywords
      .slice()
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, 12)
      .map((k) => ({ keyword: k.keyword, opportunity: Math.round(k.opportunityScore), volume: k.searchVolume, action: k.actionType }))

    return NextResponse.json({
      asin: analysisAsin,
      imported: inserted,
      skippedExisting,
      skippedLowVolume,
      totalCsvRows: table.length - 1,
      topNew,
      next: 'Run Regenerate on the listing — the audit, bullets, backend and Item Highlights now draw from these keywords; the relevance gate + brand-safety judge keep off-product/branded terms out of the copy automatically.',
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'import failed' }, { status: 500 })
  }
}
