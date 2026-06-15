/**
 * keywordResearcher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vision-first keyword research orchestrator.
 *
 * Pipeline (3 JS credits total, cached 7 days):
 *   1. Vision Scan (free) → 1 seed term
 *   2. keywords_by_keyword (1 credit) → up to 100 niche keywords
 *   3. share_of_voice (1 credit) → auto-detect #1 competitor
 *   4. keywords_by_asin on #1 competitor (1 credit) → up to 100 competitor keywords
 *   5. Merge + categorize into 3 buckets: PRIMARY, COMPETITOR_MATCH, COMPETITOR_GAPS
 *
 * Karpathy principle: Goal-driven. One module, one purpose.
 */

import { JungleScoutKeywordRow } from './index';
import {
  fetchKeywordsByKeyword,
  fetchShareOfVoice,
  fetchKeywordsByASIN,
} from '../sync/jungleScoutClient';
import { ProductIdentity, scanProductImage, getProductImageUrl } from './visionScanner';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { resolveOpenAIKey } from '../openai/credentials';
import { scrubTrademarks } from '../fba/trademarkGuard';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KeywordBuckets {
  /** Top 10 keywords by search volume (biggest prizes) */
  primary: JungleScoutKeywordRow[];
  /** Keywords the #1 competitor ranks well for (proven converters) */
  competitorMatch: JungleScoutKeywordRow[];
  /** High-volume keywords the competitor is NOT ranking for (easy opportunity) */
  competitorGaps: JungleScoutKeywordRow[];
}

export interface CompetitorMeta {
  asin: string;
  brand: string;
  link: string;
  clicksShare: number;
  conversionsShare: number;
}

export interface KeywordResearchResult {
  buckets: KeywordBuckets;
  /** All keywords flattened (for engine compatibility) */
  allKeywords: JungleScoutKeywordRow[];
  /** The seed term used */
  seedUsed: string;
  /** Auto-detected competitor metadata (null if SOV failed) */
  competitor: CompetitorMeta | null;
  /** How many JS API credits were consumed */
  creditsUsed: number;
  /** Source of the seed term */
  source: 'vision' | 'title' | 'manual' | 'category' | 'agent' | 'rules';
  /** ISO timestamp */
  researchedAt: string;
  /** The 1-3 seeds the Seed Agent considered (primary first) — for surfacing + PR2 multi-universe. */
  seedsConsidered?: string[];
  /** Self-eval: agent underperformed → suggest escalating to a full Seed Council (C). */
  escalate?: { suggested: boolean; reason: string };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const RESEARCH_CACHE_KEY = 'keyword_research';
const RESEARCH_TTL_DAYS = 7;

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Research keywords for a product using the automated 3-credit pipeline.
 *
 * @param asin - The child ASIN to research
 * @param parentAsin - The parent ASIN (for DB updates)
 * @param options - Configuration
 */
export async function researchKeywords(
  asin: string,
  parentAsin: string,
  options: {
    forceRefresh?: boolean;
    listingTitle?: string;
    manualSeed?: string;
    /** CATEGORY-level seed derived from the live SP-API productType ("self stick notes") — the
     *  fix for the seed-quality trap: a vision/title seed is PRODUCT-LITERAL ("post it notes
     *  variety pack"), so Phase 2 returns our own phrasing back and Phase 3 crowns whoever wins
     *  that narrow query — never the category winner whose keywords we need. Supplied by the
     *  caller for NON-apparel only (apparel niches are design-led; vision seeds them better). */
    categorySeed?: string;
  } = {}
): Promise<KeywordResearchResult> {
  const { forceRefresh = false, listingTitle, manualSeed, categorySeed } = options;

  // Check cache first
  if (!forceRefresh) {
    const cached = await getCachedResearch(asin);
    if (cached) {
      console.log(`[keywordResearcher] Cache HIT for ${asin}. Returning cached 3-bucket result.`);
      return cached;
    }
  }

  // ── Phase 1: Seed selection — Seed Agent (identity-validated) → rules failover ────────────
  // (was: rules-only "first 3 words" → the soccer-pollution bug. The agent reads the design's
  // real niche; manual/category seeds still bypass it; vision feeds the agent as context.)
  const seedSel = await selectSeeds({ asin, parentAsin, listingTitle, manualSeed, categorySeed });
  if (seedSel.seeds.length === 0) {
    console.warn(`[keywordResearcher] No seed available for ${asin}. Cannot research.`);
    return emptyResult();
  }
  const seed = seedSel.seeds[0];
  const source = seedSel.source;
  console.log(`[keywordResearcher] Phase 1: Seed = "${seed}" (source: ${source}; ${seedSel.seeds.length} considered: [${seedSel.seeds.join(' | ')}])`);
  let creditsUsed = 0;

  // ── Phase 2: keywords_by_keyword (1 credit) ───────────────────────────────
  const nicheKeywords = await fetchKeywordsByKeyword(seed, { pageSize: 100 });
  creditsUsed++;
  console.log(`[keywordResearcher] Phase 2: ${nicheKeywords.length} niche keywords from "${seed}"`);

  // ── Phase 2b: MULTI-UNIVERSE secondary seeds (PR2) ─────────────────────────
  // PO 2026-06-14: "query MORE keyword universes from JS — up to 3 — searching storage first."
  // The Seed Agent already returns up to 3 seeds (MOST important first); we were researching only
  // seeds[0] and discarding the rest into seedsConsidered. A multi-theme design (e.g. a Haitian
  // World-Soccer-Cup tee = world-soccer-cup ∪ haiti-pride ∪ soccer-supporter) only ranked on its
  // primary universe. Research the secondary seeds too so the pool covers ALL its niches.
  // Storage-first per seed (skip when its distinctive token already saturates the pool) and capped
  // at +2 credits (3 universes total, exactly the PO's "up to 3"). Agent seeds are already
  // trademark-scrubbed + identity-validated upstream, so no extra guard is needed here. Only the
  // 'agent' source ever yields >1 seed (manual/category/rules return a single seed), so this is
  // naturally a no-op for those paths.
  for (const xs of seedSel.seeds.slice(1, 3)) {
    const poolBlob = nicheKeywords.map((k) => k.keyword.toLowerCase()).join(' ');
    const distinct = nicheTokens(xs).find((t) => !NICHE_GENERIC.has(t) && !poolBlob.includes(t));
    if (!distinct) { console.log(`[keywordResearcher] Phase 2b: "${xs}" already covered by the pool — skipping (0 credits)`); continue; }
    const more = await fetchKeywordsByKeyword(xs, { pageSize: 100 });
    creditsUsed++;
    const seen = new Set(nicheKeywords.map((k) => k.keyword.toLowerCase()));
    let added = 0;
    for (const r of more) { const k = r.keyword.toLowerCase(); if (!seen.has(k)) { nicheKeywords.push(r); seen.add(k); added++; } }
    console.log(`[keywordResearcher] Phase 2b: +${added} keywords from secondary seed "${xs}" (1 credit)`);
  }

  // ── Phase 3: share_of_voice (1 credit) ────────────────────────────────────
  const sovCompetitors = await fetchShareOfVoice(seed);
  creditsUsed++;

  // Pick the TOP-3 competitors (excluding our own ASINs). One keywords_by_asin request covers
  // up to 10 ASINs = ONE credit, so tripling the harvest costs the same as harvesting one
  // (G2': the Cerebro-replacement competitor mining, post-H10). #1 stays the stored/displayed
  // competitor; the page[size]=100 row cap now spans all three (volume-sorted, top terms win).
  const ownAsins = new Set([asin, parentAsin]);
  const topCompetitors = sovCompetitors.filter(c => !ownAsins.has(c.asin)).slice(0, 3);
  const topCompetitor = topCompetitors[0];

  let competitor: CompetitorMeta | null = null;
  let competitorKeywords: JungleScoutKeywordRow[] = [];

  if (topCompetitor) {
    competitor = {
      asin: topCompetitor.asin,
      brand: topCompetitor.brand,
      link: `https://amazon.com/dp/${topCompetitor.asin}`,
      clicksShare: topCompetitor.clicksShare,
      conversionsShare: topCompetitor.conversionsShare,
    };
    console.log(`[keywordResearcher] Phase 3: top competitors = ${topCompetitors.map(c => `${c.asin} (${c.brand}, ${Math.round(c.clicksShare * 100)}%)`).join(', ')}`);

    // Store #1 competitor metadata in DB (display + rank panel unchanged)
    await storeCompetitorMeta(parentAsin, competitor);

    // ── Phase 4: keywords_by_asin on the top-3 competitors (ONE call = 1 credit) ─────────
    const compMap = await fetchKeywordsByASIN(topCompetitors.map(c => c.asin));
    competitorKeywords = topCompetitors.flatMap(c => compMap.get(c.asin) ?? []);
    creditsUsed++;
    console.log(`[keywordResearcher] Phase 4: ${competitorKeywords.length} competitor keywords from ${topCompetitors.length} competitor(s), 1 credit`);
  } else {
    console.log(`[keywordResearcher] Phase 3: No competitor found in SOV. Skipping Phase 4.`);
  }

  // ── Phase 4b: keywords_by_asin on OUR ASIN (1 credit) — "import OUR ranking keywords".
  // This is the ONLY honest source of OUR organic rank per keyword (the competitor fetch in
  // Phase 4 carries the COMPETITOR's ranks; niche rows carry none). The rank overlays onto
  // niche/competitor rows by keyword, and our-only ranked keywords join the pool. Because
  // keywords_by_asin returns every keyword the ASIN ranks for, ABSENCE of a rank after this
  // overlay genuinely means "not ranking" — which the rank tracker records as null.
  let ourRankedCount = 0;
  try {
    const ourMap = await fetchKeywordsByASIN([asin]);
    const ourKeywords = ourMap.get(asin) ?? [];
    creditsUsed++;
    const ourByKw = new Map(ourKeywords.map((k) => [k.keyword.toLowerCase(), k]));
    const overlay = (rows: JungleScoutKeywordRow[]) => {
      for (const r of rows) {
        const ours = ourByKw.get(r.keyword.toLowerCase());
        if (ours && (ours.organicRank ?? 0) > 0) { r.organicRank = ours.organicRank; ourRankedCount++; }
        else r.organicRank = undefined;   // competitor's rank must NEVER masquerade as ours
        ourByKw.delete(r.keyword.toLowerCase());
      }
    };
    overlay(nicheKeywords);
    overlay(competitorKeywords);
    // Keywords we rank for that neither the niche query nor the competitor surfaced — they ARE
    // our ranking keywords (the PO's ask); add them so the pool + tracker know about them.
    for (const leftover of ourByKw.values()) {
      if ((leftover.organicRank ?? 0) > 0) { nicheKeywords.push(leftover); ourRankedCount++; }
    }
    console.log(`[keywordResearcher] Phase 4b: OUR ranks overlaid — ranking on ${ourRankedCount} keywords.`);
  } catch (e) {
    console.warn('[keywordResearcher] Phase 4b (our ranks) failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  // ── Phase 5: Merge + 3-Bucket Categorization ──────────────────────────────
  const buckets = categorizeBuckets(nicheKeywords, competitorKeywords);
  const allKeywords = [...buckets.primary, ...buckets.competitorMatch, ...buckets.competitorGaps];

  const result: KeywordResearchResult = {
    buckets,
    allKeywords,
    seedUsed: seed,
    competitor,
    creditsUsed,
    source,
    researchedAt: new Date().toISOString(),
    seedsConsidered: seedSel.seeds,
    escalate: seedSel.escalate,
  };

  // Cache the result
  await cacheResearch(asin, result);
  console.log(`[keywordResearcher] Done. ${allKeywords.length} total keywords in 3 buckets (${creditsUsed} credits used).`);

  return result;
}

// ─── Bucket Categorization ──────────────────────────────────────────────────

function categorizeBuckets(
  nicheKeywords: JungleScoutKeywordRow[],
  competitorKeywords: JungleScoutKeywordRow[]
): KeywordBuckets {
  // Build a merged, deduplicated map (niche takes precedence for volume data)
  const merged = new Map<string, JungleScoutKeywordRow>();
  for (const kw of nicheKeywords) {
    merged.set(kw.keyword.toLowerCase(), kw);
  }
  for (const kw of competitorKeywords) {
    const key = kw.keyword.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, kw);
    }
  }

  // Sort all by search volume descending, cap at 100
  const allSorted = Array.from(merged.values())
    .sort((a, b) => b.searchVolume - a.searchVolume)
    .slice(0, 100);

  // Build competitor keyword set for categorization
  const compKwSet = new Set(competitorKeywords.map(k => k.keyword.toLowerCase()));

  // PRIMARY: Top 10 by volume
  const primary = allSorted.slice(0, 10);

  // Remaining keywords split into COMPETITOR_MATCH vs COMPETITOR_GAPS
  const remaining = allSorted.slice(10);
  const competitorMatch: JungleScoutKeywordRow[] = [];
  const competitorGaps: JungleScoutKeywordRow[] = [];

  for (const kw of remaining) {
    if (compKwSet.has(kw.keyword.toLowerCase())) {
      competitorMatch.push(kw);
    } else {
      competitorGaps.push(kw);
    }
  }

  return { primary, competitorMatch, competitorGaps };
}

// ─── Vision Seed Extraction ─────────────────────────────────────────────────

/**
 * Get the single best seed term from vision scanner.
 * Returns the first suggestedSearchTerm (most relevant full search query).
 */
async function getTopVisionSeed(asin: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('product_identity')
      .select('identity_data')
      .eq('asin', asin)
      .single();

    if (data) {
      const identity = (data as { identity_data: ProductIdentity }).identity_data;
      if (identity.suggestedSearchTerms?.length > 0) {
        return identity.suggestedSearchTerms[0];
      }
      // Fallback: combine top seed keyword + product type
      if (identity.seedKeywords?.length > 0) {
        return `${identity.seedKeywords[0]} ${identity.productType}`.trim();
      }
    }
  } catch {
    // Table might not exist yet
  }

  // No cached identity — try to scan now
  const imageUrl = await getProductImageUrl(asin);
  if (imageUrl) {
    console.log(`[keywordResearcher] No cached vision identity for ${asin}. Scanning...`);
    const identity = await scanProductImage(asin, imageUrl);
    if (identity && identity.suggestedSearchTerms && identity.suggestedSearchTerms.length > 0) {
      return identity.suggestedSearchTerms[0];
    }
  }

  return null;
}

// ─── Title-Based Seed (Fallback) ────────────────────────────────────────────

// Generic tokens that NEVER carry product identity — dropping them from the seed lets the
// distinctive word (Soccer, Christian, Retired, Fishing, …) lead. The OLD seed builder took
// "first 3 words" of the title, so a title starting with "Personalized 2026 World Soccer Cup
// T-Shirt" produced seed "personalized 2026 tshirt" — JS returned every 2026 family/graduation/
// disney shirt and the actual SOCCER context never reached the pool (B0GVW83L1P, 2026-06-15).
const SEED_GENERIC = new Set([
  // years
  '2020','2021','2022','2023','2024','2025','2026','2027','2028','2029','2030',
  // qualifier-only words
  'personalized','custom','customized','graphic','graphics','vintage','retro','classic',
  'premium','quality','soft','blank','original','novelty','unisex','plain',
  // sizes / colors (mirrors the old strip but expanded)
  'small','medium','large','xl','2xl','3xl','4xl','5xl','xxl','xxxl',
  'black','white','red','blue','green','navy','gray','grey','yellow','pink','purple','brown','orange','beige',
  // common audience words (audience belongs in title tail, not seed)
  'men','mens','women','womens','ladies','kid','kids','toddler','baby','adult','youth',
  // brand-of-blank (these are the GARMENT brand, not the design)
  'comfort','colors','gildan','jerzees','dickies','carhartt','bella','canvas',
  // minor / structural
  'for','and','with','the','a','an','of','to','in','on','at','by','or',
])
const APPAREL_WORDS = new Set(['shirt','shirts','tshirt','tshirts','t-shirt','tee','tees','top','tops','hoodie','sweatshirt','tank'])

/**
 * Build a concise, design-led seed from the title. Drop generic words (year, "personalized",
 * size, color, audience, blank-brand) BEFORE picking the seed — so the design's distinctive
 * tokens lead, not the qualifiers. Falls back gracefully when nothing distinctive remains.
 */
export function buildSeedFromTitle(title: string): string {
  // Strip brand prefix (everything before first dash or colon) — keep only the lead segment.
  const firstSegment = title.split(/\s*[-–—:]\s*/)[0].trim()
  // Tokenize: lowercase, strip punctuation, split on whitespace.
  const all = firstSegment.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)
  // Distinctive = NOT generic AND length > 1 — these tokens NAME the design/niche.
  const distinctive = all.filter((w) => !SEED_GENERIC.has(w) && !APPAREL_WORDS.has(w) && w.length > 1 && !/^\d+$/.test(w))
  // Take the FIRST 2 distinctive tokens — JS works best with 2-3 word seeds, and the first
  // distinctive words in the seller's own title are almost always the design tokens.
  const lead = distinctive.slice(0, 2)
  // Add an apparel word so JS returns product keywords, not general subject queries.
  const apparelInTitle = all.find((w) => APPAREL_WORDS.has(w)) || 'tshirt'
  const seed = lead.length > 0 ? `${lead.join(' ')} ${apparelInTitle}` : `${all.slice(0, 2).join(' ')} ${apparelInTitle}`.trim()
  return seed.replace(/\s{2,}/g, ' ').trim()
}

// ─── Pool-entry relevance gate (anti-pollution) ─────────────────────────────────────
// PO 2026-06-15: "B0GVW83L1P (soccer) has 61 family/graduation/disney keywords polluting the
// pool — diagnose in FULL and find a final solution." Root: the seed leaked thematic 2026
// queries into JS. This gate filters the JS-returned keywords against the LISTING'S identity
// tokens BEFORE they enter the merged pool — so even a leaky seed can't smuggle off-product
// keywords into Intelligence/audit/title-agent candidates.

/** Tokenize a string into a set of stemmed identity tokens (drops generics + tiny words). */
export function identityTokensOf(...sources: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const s of sources) {
    if (!s) continue
    for (const raw of s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)) {
      const w = raw.replace(/s$/, '')
      if (w.length <= 2) continue
      if (SEED_GENERIC.has(w) || APPAREL_WORDS.has(w)) continue
      if (/^\d+$/.test(w)) continue
      out.add(w)
    }
  }
  return out
}

/** Pure relevance check: does this keyword share ≥1 non-generic identity token with the
 *  listing's identity? E.g. for a SOCCER listing with identity {soccer, world, cup, fan, usa,
 *  mexico, canada, supporters, match}, "soccer jersey" passes (soccer ∈ identity); "family
 *  vacation shirts 2026" fails (no overlap). The token "2026" is excluded from BOTH sides as
 *  generic so a shared year alone can't smuggle pollution through. */
export function keywordIsRelevant(keyword: string, identity: Set<string>): boolean {
  if (identity.size === 0) return true   // no identity tokens → can't gate, accept everything
  for (const raw of keyword.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)) {
    const w = raw.replace(/s$/, '')
    if (w.length <= 2) continue
    if (SEED_GENERIC.has(w) || APPAREL_WORDS.has(w)) continue
    if (identity.has(w)) return true
  }
  return false
}

// ─── Seed Agent (PR: seed-council B) ────────────────────────────────────────
// PO 2026-06-15: the pipeline used AI councils for OUTPUTS (title/bullets/desc) but pure RULES
// for the research seed INPUT — that asymmetry let "Personalized 2026 World Soccer Cup" become
// the seed "personalized 2026 tshirt" and poured 61 family/graduation keywords into a soccer
// listing. Fix (approved design): a small AI agent picks niche-aware seeds, VALIDATED against the
// listing's own identity tokens (drops hallucinations), with the rules builder as failover. A
// self-eval flags weak runs so we can suggest escalating to a full multi-proposer council (C).

export interface SeedSelection {
  seeds: string[]                                  // 1-3 validated seeds, primary (best) first
  source: 'agent' | 'rules' | 'manual' | 'category'
  /** Self-eval: when true, the agent underperformed (no on-identity seeds / call failed) and a
   *  full Seed Council (C) is worth trying. Surfaced so the operator can opt in. */
  escalate: { suggested: boolean; reason: string }
}

/** PURE: keep only seeds that share an identity token (drops a hallucinated/off-product seed),
 *  ensure each carries a product word, dedup by theme, cap at 3. Unit-tested. */
export function validateSeeds(rawSeeds: string[], identity: Set<string>, productWord = 'tshirt'): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of rawSeeds) {
    let s = (raw || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!s) continue
    // Hallucination guard: a seed the listing's own identity can't corroborate is dropped.
    if (identity.size > 0 && !keywordIsRelevant(s, identity)) continue
    // Ensure a product word so JS returns product keywords, not abstract subject queries.
    if (!s.split(/\s+/).some((w) => APPAREL_WORDS.has(w))) s = `${s} ${productWord}`
    s = s.split(/\s+/).slice(0, 4).join(' ')
    const key = s.replace(/[^a-z0-9]/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= 3) break
  }
  return out
}

/** Select up to 3 niche-aware research seeds. AGENT-first (context judgment), validated against
 *  the listing identity, with the rules builder (buildSeedFromTitle) as failover. manual/category
 *  seeds bypass the agent (already authoritative). */
export async function selectSeeds(opts: {
  asin: string
  parentAsin?: string
  listingTitle?: string | null
  manualSeed?: string
  categorySeed?: string
}): Promise<SeedSelection> {
  const { asin, parentAsin, listingTitle, manualSeed, categorySeed } = opts
  // Scrub seeds too — never spend a JS credit RESEARCHING a trademark ("world cup" → "world soccer cup").
  if (manualSeed) return { seeds: [scrubTrademarks(manualSeed)], source: 'manual', escalate: { suggested: false, reason: '' } }
  if (categorySeed) return { seeds: [scrubTrademarks(categorySeed)], source: 'category', escalate: { suggested: false, reason: '' } }

  // Gather identity context: the seller's own canonical title + design override + vision + rep title.
  let canonicalTitle: string | null = null
  let designOverride: string | null = null
  try {
    const { data } = await supabase.from('listing_seo_scores')
      .select('product_title, design_name_override').eq('parent_asin', parentAsin || asin).single() as
      { data: { product_title?: string | null; design_name_override?: string | null } | null }
    canonicalTitle = data?.product_title ?? null
    designOverride = data?.design_name_override ?? null
  } catch { /* pre-migration / no row — fall back to listingTitle */ }
  const identitySrc = canonicalTitle || listingTitle || ''
  const identity = identityTokensOf(canonicalTitle, designOverride, listingTitle)
  const productWord = (identitySrc.toLowerCase().match(/\b(t-?shirt|tshirt|tee|hoodie|sweatshirt|tank|top)\b/) || [])[0]?.replace(/[^a-z]/g, '') || 'tshirt'

  // Rules failover (always computable) — used if the agent is unavailable or returns nothing valid.
  const rulesSeed = scrubTrademarks(buildSeedFromTitle(canonicalTitle || listingTitle || ''))

  // ── The Seed AGENT ──
  try {
    const key = await resolveOpenAIKey()
    if (key && identitySrc) {
      const identity2 = await getVisionIdentityRaw(asin) || (parentAsin ? await getVisionIdentityRaw(parentAsin) : null)
      const visionLine = identity2?.designTheme ? `Image/design theme: ${identity2.designTheme}\n` : ''
      const overrideLine = designOverride ? `Seller-confirmed design name: ${designOverride}\n` : ''
      const openai = new OpenAI({ apiKey: key })
      const system = `You pick Amazon SEARCH SEEDS for a print-on-demand product. A seed is a SHORT 2-4 word phrase a shopper types to find THIS product's DESIGN/NICHE, ending in a product-type word (shirt/tee/etc). Return the design's REAL theme — NEVER generic qualifiers (a year like 2026, "personalized", "custom", a size, a color, or the blank/garment brand). NEVER use a protected TRADEMARK — say "World Soccer Cup" not "World Cup" (FIFA mark), "Big Game" not "Super Bowl"; avoid FIFA/NFL/NBA/Olympics/Disney/Marvel etc. Return 1-3 seeds, MOST important first, as JSON {"seeds":[...]}.
Examples:
Title: Personalized 2026 World Soccer Cup T-Shirt – Fan Tee, USA Mexico Canada Host Countries => {"seeds":["world soccer cup shirt","usa soccer fan tee","soccer supporter tee"]}
Title: I Am Retired I Don't Have to T-Shirt – Funny Retirement Graphic Tee => {"seeds":["funny retirement shirt","retired tshirt"]}
Title: Comfort Colors I Will Praise Him Every Season T-Shirt – Christian Tee => {"seeds":["christian faith shirt","bible verse tee"]}
Title: Gildan Unisex Soft Cotton Blank T-Shirt Premium => {"seeds":["blank cotton tshirt"]}`
      const user = `${overrideLine}${visionLine}Title: ${identitySrc}\n\nReturn ONLY {"seeds":[...]}.`
      const r = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
      })
      let parsed: { seeds?: string[] } = {}
      try { parsed = JSON.parse(r.choices[0]?.message?.content || '{}') } catch { /* malformed → empty → failover */ }
      const valid = validateSeeds(Array.isArray(parsed.seeds) ? parsed.seeds : [], identity, productWord).map(scrubTrademarks)
      if (valid.length > 0) {
        console.log(`[keywordResearcher] Seed Agent → [${valid.join(' | ')}] (identity-validated)`)
        return { seeds: valid, source: 'agent', escalate: { suggested: false, reason: '' } }
      }
      // Agent produced nothing on-identity → failover + flag for escalation to the full council.
      console.warn(`[keywordResearcher] Seed Agent returned no on-identity seeds for ${asin} — failing over to rules.`)
      return { seeds: rulesSeed ? [rulesSeed] : [], source: 'rules',
        escalate: { suggested: true, reason: 'Seed Agent produced no seeds that match this listing — a full Seed Council (multiple proposers + judge) may extract a better niche.' } }
    }
  } catch (e) {
    console.warn('[keywordResearcher] Seed Agent failed (non-fatal, using rules):', e instanceof Error ? e.message : e)
  }
  // No OpenAI key, no title, or the call threw → rules.
  return { seeds: rulesSeed ? [rulesSeed] : [], source: 'rules',
    escalate: { suggested: false, reason: '' } }
}

// ─── Competitor Storage ─────────────────────────────────────────────────────

async function storeCompetitorMeta(parentAsin: string, meta: CompetitorMeta): Promise<void> {
  const { error } = await supabase
    .from('listing_seo_scores')
    .update({
      competitor_asin: meta.asin,
      competitor_brand: meta.brand,
      competitor_link: meta.link,
      competitor_sov_clicks: meta.clicksShare,
      competitor_sov_conversions: meta.conversionsShare,
    } as never)
    .eq('parent_asin', parentAsin);

  if (error) {
    console.error(`[keywordResearcher] Failed to store competitor meta for ${parentAsin}:`, error.message);
  }
}

// ─── Research Cache ─────────────────────────────────────────────────────────

async function cacheResearch(asin: string, result: KeywordResearchResult): Promise<void> {
  try {
    // keyword_cache columns: id, asin, source, keyword_data, fetched_at, expires_at,
    // competitor_asin, competitor_brand, sov_percentage
    // Extra metadata (seed, source, credits) is stored inside keyword_data wrapper.
    const expiresAt = new Date(
      new Date(result.researchedAt).getTime() + RESEARCH_TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const { error } = await supabase
      .from('keyword_cache')
      .upsert({
        asin,
        source: RESEARCH_CACHE_KEY,
        keyword_data: result.allKeywords,
        fetched_at: result.researchedAt,
        expires_at: expiresAt,
        competitor_asin: result.competitor?.asin ?? null,
        competitor_brand: result.competitor?.brand ?? null,
        sov_percentage: result.competitor
          ? parseFloat((result.competitor.clicksShare * 100).toFixed(2))
          : null,
      }, { onConflict: 'asin,source' });

    if (error) {
      console.error(`[keywordResearcher] Cache write error for ${asin}:`, error.message, error.details);
    } else {
      console.log(`[keywordResearcher] Cache written for ${asin} (source: ${RESEARCH_CACHE_KEY}, ${result.allKeywords.length} keywords).`);
    }
  } catch (err) {
    console.error(`[keywordResearcher] Cache write exception for ${asin}:`, err);
  }
}

async function getCachedResearch(asin: string): Promise<KeywordResearchResult | null> {
  try {
    // Only select columns that actually exist in keyword_cache
    const { data } = await supabase
      .from('keyword_cache')
      .select('keyword_data, fetched_at, expires_at')
      .eq('asin', asin)
      .eq('source', RESEARCH_CACHE_KEY)
      .single();

    if (!data) return null;

    const row = data as {
      keyword_data: JungleScoutKeywordRow[];
      fetched_at: string;
      expires_at: string | null;
    };

    // Check TTL via expires_at (preferred) or fetched_at fallback
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      console.log(`[keywordResearcher] Cache EXPIRED for ${asin} (expires_at: ${row.expires_at}).`);
      return null;
    }
    const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > RESEARCH_TTL_DAYS) {
      console.log(`[keywordResearcher] Cache EXPIRED for ${asin} (${Math.round(ageDays)} days > ${RESEARCH_TTL_DAYS} TTL).`);
      return null;
    }

    // Rebuild buckets from flat cached data (primary = top 10 by volume)
    const allSorted = (row.keyword_data ?? []).sort((a, b) => b.searchVolume - a.searchVolume);
    const primary = allSorted.slice(0, 10);
    const remaining = allSorted.slice(10);

    return {
      buckets: { primary, competitorMatch: remaining, competitorGaps: [] },
      allKeywords: allSorted,
      seedUsed: '',
      competitor: null,
      creditsUsed: 0,
      source: 'title',
      researchedAt: row.fetched_at,
    };
  } catch {
    return null;
  }
}

/**
 * Size of the FRESH, retrievable JS research pool for this ASIN (0 if expired/absent/empty).
 *
 * The Intelligence self-heal gates promotion on `poolSize > storedCount`, which gives TWO guarantees
 * in one check:
 *   • CREDIT SAFETY — a non-zero size means getCachedResearch returned (cache not expired), so
 *     researchKeywords(forceRefresh:false) will cache-HIT (0 Jungle Scout credits). A row's
 *     fetched_at (researchedAt) can be set on an EXPIRED cache; THIS reflects retrievability, so a
 *     credit-spending fetch is never triggered.
 *   • NO CHURN/LOOP — if the cached pool is empty or no bigger than what's already stored, promotion
 *     can't help; skipping it avoids re-running the engine every page load (storeAnalysis early-
 *     returns on an empty merge and never advances analyzed_at, which would otherwise re-fire).
 * Pure read; spends nothing.
 */
export async function freshResearchPoolSize(asin: string): Promise<number> {
  return (await getCachedResearch(asin))?.allKeywords.length ?? 0
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyResult(): KeywordResearchResult {
  return {
    buckets: { primary: [], competitorMatch: [], competitorGaps: [] },
    allKeywords: [],
    seedUsed: '',
    competitor: null,
    creditsUsed: 0,
    source: 'title',
    researchedAt: new Date().toISOString(),
  };
}

// ─── Multi-universe niche enrichment ──────────────────────────────────────────
// PO 2026-06-14: "The Council should be smart enough to know if they need to query MORE
// keyword universes from JS — up to 3 — searching storage first, each query 100 keywords."
//
// CHEAP, ADDITIVE path (PO chose this over a full re-research): take a listing that already
// has a researched pool and ADD the missing NICHE universe(s) — the design-theme keywords the
// blank/product seed never surfaced (a Christian faith tee researched on "comfort colors
// tshirt" has ZERO faith keywords). Keyword queries ONLY (no SOV/competitor re-run),
// storage-first per universe, capped at 2 niche credits (3 universes total incl. the primary).
// Does NOT touch researchKeywords — this is purely additive.

const NICHE_APPAREL_RE = /\b(shirt|shirts|tee|tees|tshirt|tshirts|t-shirt|hoodie|sweatshirt|tank|top|tops)\b/i
// Words that never constitute a "niche" on their own (so the blank/product itself is never
// mistaken for a design theme).
const NICHE_GENERIC = new Set([
  'tshirt', 'tshirts', 'shirt', 'shirts', 'tee', 'tees', 'top', 'tops', 'apparel', 'clothing',
  'comfort', 'colors', 'color', 'blank', 'cotton', 'graphic', 'unisex', 'mens', 'womens',
  'women', 'men', 'plain', 'soft', 'vintage', 'oversized', 'premium',
])

function nicheTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
}
function nicheNorm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Derive up to `max` NICHE seed phrases from the vision identity that are DISTINCT from the
 * primary (blank/product) seed. Pure + unit-tested. "Auto when design has a niche": a plain
 * blank tee (designTheme generic, seedKeywords ⊆ primary) yields [] — no extra universe, no
 * spend. A faith/fishing/funny design yields 1-2 niche seeds.
 */
export function deriveNicheSeeds(
  identity: { designTheme?: string; seedKeywords?: string[]; suggestedSearchTerms?: string[]; productType?: string } | null | undefined,
  primarySeed: string,
  max = 2,
): string[] {
  if (!identity) return []
  const primaryToks = new Set(nicheTokens(primarySeed))
  const productWord = NICHE_APPAREL_RE.test(identity.productType || '') ? (identity.productType || '').toLowerCase() : 'tshirt'
  const candidates: string[] = [
    ...((identity.suggestedSearchTerms || []).slice(1)), // [0] is (or seeds) the primary
    ...(identity.seedKeywords || []),
    ...(identity.designTheme ? [identity.designTheme] : []),
  ]
  const out: string[] = []
  // Dedup by THEME (the novel non-generic tokens), NOT the full string — otherwise the same
  // niche emits twice ("christian tshirt" from a suggested term + "christian shirt" from a seed
  // keyword) and crowds out genuinely distinct niches like "bible verse".
  const seenNovel = new Set<string>()
  for (const raw of candidates) {
    if (out.length >= max) break
    let s = (raw || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!s) continue
    // Must contribute a NON-generic token the primary doesn't already cover — else it isn't a
    // real niche (the "auto when design has a niche" gate).
    const novel = nicheTokens(s).filter((t) => !primaryToks.has(t) && !NICHE_GENERIC.has(t))
    if (novel.length === 0) continue
    if (novel.every((t) => seenNovel.has(t))) continue // this theme is already represented
    for (const t of novel) seenNovel.add(t)
    if (!NICHE_APPAREL_RE.test(s)) s = `${s} ${productWord}` // ensure a product word so JS returns product keywords
    s = s.split(/\s+/).slice(0, 4).join(' ') // tight seeds (JS works best ≤4 words)
    out.push(s)
  }
  return out
}

export interface NicheEnrichResult {
  creditsUsed: number
  seedsQueried: string[]
  seedsSkippedCached: string[]
  addedKeywordCount: number
  totalKeywordCount: number
  note: string
}

/**
 * Cheap niche enrichment for an ALREADY-researched listing. Loads the cached pool, derives
 * niche seeds from the vision identity, and for each niche NOT already in storage, fetches one
 * keywords_by_keyword universe (100 kw, 1 credit) and merges it in. Re-caches the enriched pool.
 * The caller then re-runs the engine so the new keywords surface in Intelligence.
 *
 * Credits: 0 if every niche is already cached; max 2 (the niche universes — primary already paid).
 */
export async function enrichResearchWithNiche(asin: string, parentAsin?: string): Promise<NicheEnrichResult> {
  const base: NicheEnrichResult = { creditsUsed: 0, seedsQueried: [], seedsSkippedCached: [], addedKeywordCount: 0, totalKeywordCount: 0, note: '' }
  const cached = await getCachedResearch(asin)
  if (!cached) return { ...base, note: 'No existing research to enrich — run a full research first.' }

  // Vision identity is WRITTEN under the PARENT asin (ai-recommendations scanProductImage(parent_asin,…))
  // but enrichment runs on the CHILD asin — so a child-only read missed it (adversarial-review finding,
  // 2026-06-14: "no niche detected" for B0FKKN8XKV). Try child, then parent.
  const identity = (await getVisionIdentityRaw(asin)) || (parentAsin ? await getVisionIdentityRaw(parentAsin) : null)
  const primarySeed = cached.seedUsed || identity?.suggestedSearchTerms?.[0] || ''
  const nicheSeeds = deriveNicheSeeds(identity, primarySeed, 2)
  if (nicheSeeds.length === 0) {
    return { ...base, totalKeywordCount: cached.allKeywords.length, note: 'No distinct niche detected — blank/product universe only, nothing to enrich.' }
  }

  const pool = new Map<string, JungleScoutKeywordRow>()
  for (const k of cached.allKeywords) pool.set(k.keyword.toLowerCase(), k)
  const poolBlob = Array.from(pool.keys()).join(' ')

  const seedsQueried: string[] = []
  const seedsSkippedCached: string[] = []
  let creditsUsed = 0
  let added = 0
  for (const seed of nicheSeeds) {
    // Storage-first: if the niche's distinctive token already saturates the pool, it's covered.
    const distinct = nicheTokens(seed).find((t) => !NICHE_GENERIC.has(t) && !poolBlob.includes(t))
    if (!distinct) { seedsSkippedCached.push(seed); continue }
    const rows = await fetchKeywordsByKeyword(seed, { pageSize: 100 })
    creditsUsed++
    seedsQueried.push(seed)
    for (const r of rows) {
      const key = r.keyword.toLowerCase()
      if (!pool.has(key)) { pool.set(key, r); added++ }
    }
  }

  if (added > 0) {
    const merged = Array.from(pool.values()).sort((a, b) => b.searchVolume - a.searchVolume)
    await cacheResearch(asin, { ...cached, allKeywords: merged, researchedAt: new Date().toISOString() })
  }
  return {
    creditsUsed,
    seedsQueried,
    seedsSkippedCached,
    addedKeywordCount: added,
    totalKeywordCount: pool.size,
    note: seedsQueried.length ? `Added ${added} niche keywords from: ${seedsQueried.join(' | ')}` : 'All niche universes already in storage (0 credits).',
  }
}

/** Read the full vision identity for niche-seed derivation. */
async function getVisionIdentityRaw(asin: string): Promise<ProductIdentity | null> {
  try {
    const { data } = await supabase.from('product_identity').select('identity_data').eq('asin', asin).single()
    if (data) return (data as { identity_data: ProductIdentity }).identity_data
  } catch { /* product_identity may not exist for this asin */ }
  return null
}
// build: 20260602191152 - HOSTNAME fix
