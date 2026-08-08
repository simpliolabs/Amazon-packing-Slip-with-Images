/**
 * priorityDisplay.ts — the ONE market-first Priority cell rule (PO 2026-08-08 override of the #520
 * display decision: "the Opp score should be a JUNGLE SCOUT opp score, NOT our fabricated one").
 *
 * PRIMARY  = native `market_opportunity` N/10 (migration 055; demand × winnability, stable across
 *            pulls unless the MARKET moves). Bands recalibrated to the 0-10 scale.
 * FALLBACK = the internal gap composite, honestly marked `~` (the RankAnalysisPanel precedent —
 *            RankAnalysisPanel.tsx:197-200): SQP-only / import / pre-055 rows have no native metric,
 *            and a fabricated number must never be mistaken for market data. Keeps the historical
 *            70/40 bands.
 *
 * Pure + shared so the listing page and the KeywordIntelligencePanel mirror render identically and
 * the band choice is table-testable without mounting a 5k-line client component.
 */
export function priorityDisplay(
  marketOpportunity: number | null | undefined,
  coverageGapScore: number,
): { text: string; cls: string; native: boolean } {
  if (typeof marketOpportunity === 'number' && Number.isFinite(marketOpportunity)) {
    return {
      text: `${marketOpportunity}/10`,
      cls: marketOpportunity >= 7 ? 'text-violet-700' : marketOpportunity >= 4 ? 'text-slate-700' : 'text-slate-400',
      native: true,
    }
  }
  const gap = Number.isFinite(coverageGapScore) ? Math.round(coverageGapScore) : 0
  return {
    text: `~${gap}`,
    cls: gap >= 70 ? 'text-violet-700' : gap >= 40 ? 'text-slate-700' : 'text-slate-400',
    native: false,
  }
}

/** Tooltip for the Priority cell — states the formula actually shown, never a simplification. */
export function priorityTooltip(native: boolean, coverageGapScore: number): string {
  return native
    ? `Jungle Scout market opportunity (0-10): demand × winnability — market truth, independent of your own listing content and stable across pulls. Internal gap-priority: ${Math.round(coverageGapScore)} (0-100, drops when you cover the keyword).`
    : 'No native market metric for this keyword (SQP/import row or researched pre-migration) — showing the internal gap composite (~, 0-100), which changes when your own coverage changes. Re-research stamps the native metric.'
}
