/**
 * relevanceClassifier.ts — LLM SEMANTIC relevance gate for the keyword pool.
 * ─────────────────────────────────────────────────────────────────────────────
 * The deterministic net (`isOffNicheKeyword`, nicheGuards.ts) catches the ENUMERABLE off-niche
 * classes — golf pegs, competitor blank brands, wholesale, activewear, foreign tokens, gear. What it
 * cannot enumerate is the SEMANTIC tail: celebrity / band / athlete merch ("usher and chris brown
 * shirt"), arbitrary foreign-language duplicates ("grafica tees women"), and adjacent-but-different
 * niches. Those need a judgment call, so — per [[self-healing-system-directive]] "RAG/AI only where
 * rules can't decide" — they get an LLM classifier, run at INGESTION so `keyword_analysis` is clean
 * at the SOURCE (every downstream card, rank panel, and generator inherits it) rather than filtered
 * per-seam forever.
 *
 * FAIL-OPEN by construction: any error, timeout, or an implausible "drop almost everything" verdict
 * returns an empty drop-set, so a classifier hiccup can never collapse the keyword pool.
 */

import OpenAI from 'openai'
import { resolveOpenAIKey } from '../openai/credentials'
import { instrumentAiHealth } from '../openai/errorClass'

export interface RelevanceContext {
  title?: string | null
  brand?: string | null
  category?: string | null
}

/**
 * Given a list of candidate keywords for a specific product, return the SUBSET (by exact string) that
 * is OFF-PRODUCT — traffic that would never convert on this listing and so must not be a ranking
 * target. Conservative: when unsure, KEEP. Returns a Set of the keywords to DROP (empty on any error).
 *
 * @param openai optional pre-built (ideally instrumented) client; one is created + instrumented if omitted.
 */
export async function classifyOffNicheKeywords(
  keywords: string[],
  ctx: RelevanceContext,
  openai?: OpenAI,
): Promise<Set<string>> {
  const empty = new Set<string>()
  const uniq = [...new Set(keywords.map((k) => (k || '').trim()).filter(Boolean))]
  if (uniq.length === 0) return empty

  try {
    const client = openai ?? instrumentAiHealth(new OpenAI({ apiKey: await resolveOpenAIKey() }))
    const list = uniq.map((k, i) => `${i}: ${k}`).join('\n')
    const system =
      'You are an Amazon SEO relevance filter for ONE specific product. Return ONLY valid JSON of the form {"drop":[<indices>]}.'
    const user = `PRODUCT
Title: ${ctx.title ?? '(unknown)'}
Brand: ${ctx.brand ?? '(unknown)'}
Category: ${ctx.category ?? 'apparel / graphic t-shirt'}

KEYWORDS (index: phrase)
${list}

Return the indices of keywords that are OFF-PRODUCT for THIS listing — search terms whose shoppers want something else, so ranking there only brings junk traffic that never converts:
1. CELEBRITY / BAND / MUSICIAN / ATHLETE / character / public-figure names — concert or fan merch (e.g. "usher and chris brown shirt"). This listing is not their merchandise.
2. FOREIGN-LANGUAGE duplicates of apparel terms when the listing copy is English (e.g. Spanish/Portuguese "grafica tees women", "playeras mujer", "camiseta hombre").
3. A DIFFERENT physical product than what this listing sells (e.g. mug, phone case, sticker, poster, hat) or a non-apparel accessory/equipment category (e.g. "golf accessories", "golf balls", "golf gloves").
4. OTHER companies' brands / trademarks — a competitor blank brand, a sports team, a media franchise.
5. An ADJACENT-but-different apparel niche this garment is NOT (e.g. "workout / gym / athletic / performance" terms for a casual garment-dyed cotton graphic tee).

KEEP everything plausibly on-product: the design theme, the audience, occasions, gift terms, garment + brand descriptors, size/fit terms, and broad category angles ("graphic tees for women", "funny shirts for women"). Be CONSERVATIVE — when unsure, KEEP. Return ONLY {"drop":[...]}.`

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    })

    let parsed: { drop?: unknown }
    try {
      parsed = JSON.parse(completion.choices[0]?.message?.content || '{}')
    } catch {
      return empty
    }
    const idx = Array.isArray(parsed.drop) ? parsed.drop : []
    const drop = new Set<string>()
    for (const n of idx) {
      if (Number.isInteger(n) && (n as number) >= 0 && (n as number) < uniq.length) drop.add(uniq[n as number])
    }
    // Never-collapse floor: a verdict that drops more than half the pool almost certainly misfired.
    if (drop.size > uniq.length * 0.5) return empty
    return drop
  } catch (err) {
    console.warn(
      '[relevanceClassifier] classifyOffNicheKeywords failed (non-fatal; keeping pool):',
      err instanceof Error ? err.message : err,
    )
    return empty
  }
}
