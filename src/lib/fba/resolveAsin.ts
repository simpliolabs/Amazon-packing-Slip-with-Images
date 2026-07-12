/**
 * Resolve an ASIN (parent OR child) to a child ASIN that has listing content. Extracted verbatim
 * from the intelligence route so the rank-analysis route resolves identically (no fork).
 *
 * Priority:
 *   1. Direct match in listing_content (already a child ASIN)
 *   2. parent_asin_rollup → top_child_asin
 *   3. Fallback: first child in listing_content where parent_asin = input
 * Returns { childAsin, parentAsin } or null if unresolvable.
 */
export async function resolveToChildAsin(
  inputAsin: string,
  // Accepts any supabase client (admin server client or the scorer's SupabaseClient) — the generated
  // types don't constrain these reads, and it's read-only. Same pattern as loadListingRowsForPresence.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<{ childAsin: string; parentAsin: string | null } | null> {
  // 1. Direct match — input is already a child ASIN in listing_content.
  // limit(1).maybeSingle() (NOT .single()): an ASIN with FBA+FBM twin rows returns 2 rows here,
  // and .single() would THROW on >1 → data null → silent null-resolve to parent. Both twins share
  // the same parent_asin, so taking either row is correct. maybeSingle() also handles 0 rows cleanly.
  const { data: directMatch } = await supabase
    .from('listing_content')
    .select('asin, parent_asin')
    .eq('asin', inputAsin)
    .limit(1)
    .maybeSingle()
  const dm = directMatch as { asin: string; parent_asin: string | null } | null
  if (dm) return { childAsin: dm.asin, parentAsin: dm.parent_asin }

  // 2. Input is a parent ASIN — check parent_asin_rollup for top_child_asin
  const { data: rollup } = await supabase
    .from('parent_asin_rollup')
    .select('top_child_asin')
    .eq('parent_asin', inputAsin)
    .single()
  const ru = rollup as { top_child_asin: string | null } | null
  if (ru?.top_child_asin) {
    console.log(`[resolveAsin] Resolved parent ${inputAsin} -> child ${ru.top_child_asin} (via rollup)`)
    return { childAsin: ru.top_child_asin, parentAsin: inputAsin }
  }

  // 3. Fallback: find any child in listing_content with this parent_asin
  const { data: child } = await supabase
    .from('listing_content')
    .select('asin')
    .eq('parent_asin', inputAsin)
    .not('title', 'is', null)
    .limit(1)
    .single()
  const ch = child as { asin: string } | null
  if (ch) {
    console.log(`[resolveAsin] Resolved parent ${inputAsin} -> child ${ch.asin} (via listing_content fallback)`)
    return { childAsin: ch.asin, parentAsin: inputAsin }
  }

  return null
}
