/**
 * GET /api/fba/title-golds
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PO'S OWN TITLES, MINED — the corpus the title council should have been learning from.
 *
 * PO 2026-08-10: "I gave you about 70 title recommendations in the last 2 months (all fixes were
 * pushed to repos) that should be a strong signal for the council/judge how to put these together."
 *
 * They are right, and the gap is embarrassing: `PO_GOLD_TITLES` (listingPipeline.ts:1207) is EIGHT
 * hand-copied strings, and its own comment has said since July that a "future auto-miner over
 * listing_change_log title edits" was the intended design. It was never built — so every title
 * quality problem has been chased with another deterministic net while ~70 worked examples of the
 * answer sat unused in the database.
 *
 * WHERE A PO TITLE LIVES. When the seller writes a title by hand the pipeline stamps
 * `listing_seo_recommendations.title_source = 'manual'` and stores their text in
 * `recommended_title` (migration 044; the lock guard at ai-recommendations/route.ts:1598 reads the
 * same flag). So a manual row IS a gold by definition — it is the seller's own words, on their own
 * product, that they chose to lock against the AI.
 *
 * READ-ONLY. No writes, no model calls, no Jungle Scout credits.
 *
 * The SHAPE analysis exists because a corpus of raw strings teaches less than a corpus of strings
 * plus the structure the seller keeps choosing. Every number here is measured off their titles, not
 * asserted by me — so when the council brief says "left segment 6-7 words", that figure is THEIRS.
 */
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface Gold {
  parentAsin: string | null
  title: string
  len: number
  /** Left of the ` | ` pipe (or whole title when unpiped) — brand + design + garment noun. */
  left: string
  leftWords: number
  /** Right of the pipe — the MONEY position per SELLER_PROFILE §3. */
  right: string | null
  rightWords: number
  hasPipe: boolean
  updatedAt: string | null
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

export async function GET() {
  try {
    const supabase = await createAdminClient()

    // Paginated: a single .select() caps at 1000 and would silently mine a fraction of the corpus.
    const PAGE = 1000
    const rows: { parent_asin: string | null; recommended_title: string | null; title_source: string | null; generated_at: string | null }[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('listing_seo_recommendations')
        .select('parent_asin, recommended_title, title_source, generated_at')
        .eq('title_source', 'manual')
        .range(from, from + PAGE - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      const batch = data ?? []
      rows.push(...batch)
      if (batch.length < PAGE) break
    }

    const seen = new Set<string>()
    const golds: Gold[] = []
    for (const r of rows) {
      const title = (r.recommended_title ?? '').trim()
      if (!title) continue
      const key = title.toLowerCase()
      if (seen.has(key)) continue           // the same gold locked on several children is ONE example
      seen.add(key)
      const pipe = title.indexOf(' | ')
      const left = pipe >= 0 ? title.slice(0, pipe).trim() : title
      const right = pipe >= 0 ? title.slice(pipe + 3).trim() : null
      golds.push({
        parentAsin: r.parent_asin, title, len: title.length,
        left, leftWords: words(left),
        right, rightWords: right ? words(right) : 0,
        hasPipe: pipe >= 0,
        updatedAt: r.generated_at,
      })
    }

    golds.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

    const piped = golds.filter((g) => g.hasPipe)
    const med = (ns: number[]) => {
      if (ns.length === 0) return null
      const s = [...ns].sort((x, y) => x - y)
      return s[Math.floor(s.length / 2)]
    }
    // THE SHAPE THE SELLER ACTUALLY CHOOSES — measured, not asserted. This is what the council brief
    // should be taught, and what a judge should score against.
    const shape = {
      golds: golds.length,
      pipedShare: golds.length ? +(piped.length / golds.length).toFixed(2) : 0,
      medianTitleLen: med(golds.map((g) => g.len)),
      medianLeftWords: med(piped.map((g) => g.leftWords)),
      medianRightWords: med(piped.map((g) => g.rightWords)),
      leftWordRange: piped.length ? [Math.min(...piped.map((g) => g.leftWords)), Math.max(...piped.map((g) => g.leftWords))] : null,
      note: 'left = brand + design + garment noun; right = the MONEY position (SELLER_PROFILE §3). '
          + 'Measured off the seller\'s OWN locked titles — the council brief should cite these numbers, not invented ones.',
    }

    return NextResponse.json({ shape, golds })
  } catch (e) {
    return NextResponse.json({ error: 'gold mining failed', details: String(e) }, { status: 500 })
  }
}
