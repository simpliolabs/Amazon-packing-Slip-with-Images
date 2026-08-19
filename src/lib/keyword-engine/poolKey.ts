/**
 * ONE POOL KEY PER FAMILY — the canonical key for keyword_analysis / keyword_cache.
 *
 * WHY (2026-08-19, task #174, workflow wf_6d88ff51-d8b). The family keyword pool had NO canonical
 * key: four call-site-local resolvers each derived their own —
 *   1. the Intelligence route used resolveToChildAsin, whose direct-match step returns the PARENT
 *      for a self-parented family;
 *   2. the regen keyed on listing_seo_scores.top_child_asin — a MUTABLE SALES RANKING
 *      (max units_sold_30d) that silently orphans the whole pool whenever the best-seller changes;
 *   3. clear-cache read parent_asin_rollup.top_child_asin (the upstream of #2);
 *   4. buildKeywordContext ran a lookupAsin → parentAsin → children[0] fallback ladder.
 * Proven live on B0DSQPZY9S: pool copies under two child keys (both 2026-07-24 fossils, the family
 * was HARVESTED TWICE six minutes apart — double-billed), all judgment columns NULL, generators
 * INERT, and the sync banner reporting success over zero persisted rows.
 *
 * THE RULE: the pool key is the PARENT ASIN — the only structurally stable identifier for a family
 * (the theme card, relevance gate, vision signal and competitor meta are already parent-keyed).
 * It is produced by exactly ONE function, and the branded type below makes a raw
 * `top_child_asin` / `children[0].asin` FAIL TYPECHECK at every pool read/write signature.
 * This is the scorer-not-net move: it changes what can be PRODUCED, not what gets caught.
 */
import { resolveToParentAsin } from '@/lib/fba/resolveAsin'

/** Only resolveKeywordPoolKey (and the two documented escape hatches) may mint this type. */
export type PoolKey = string & { readonly __poolKey: unique symbol }

/**
 * The ONE RULE, as a pure function: parent if the family has one, else the resolved child, else the
 * input unchanged (fail-open — an orphan/unsynced ASIN degrades to pre-#174 behaviour, never a
 * thrown-away request). Call sites that already hold a resolveToChildAsin result use this directly
 * (zero extra queries); resolveKeywordPoolKey below is the same rule for sites that start from a
 * raw string. Two entry points, ONE rule — never re-derive it inline.
 */
export const poolKeyFromResolved = (
  resolved: { childAsin: string; parentAsin: string | null } | null,
  inputAsin: string,
): PoolKey => (resolved?.parentAsin || resolved?.childAsin || inputAsin).toUpperCase() as PoolKey

/** The ONE resolver for call sites that start from a raw ASIN string. */
export async function resolveKeywordPoolKey(
  inputAsin: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<PoolKey> {
  const { parentAsin } = await resolveToParentAsin(inputAsin, supabase)
  return (parentAsin || inputAsin).toUpperCase() as PoolKey
}

/** Test-only mint. Production code must use resolveKeywordPoolKey. */
export const unsafePoolKeyForTests = (s: string): PoolKey => s as PoolKey
