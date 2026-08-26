/**
 * audienceAssignment.ts — PER-DESIGN audience-lean resolution (PO ruling 2026-08-26, applying the
 * garment per-design ruling — migration 062, `blank_assignments` — to audience).
 *
 * THE PROBLEM (measured live, B0DSCDZC6K): `audience_lean` (migration 029) is ONE value for the
 * whole family. The family's own designs disagree — "Mother Hustler" / "Business B*tch" are
 * female-coded, "Don't Quit" / "Hustle Definiton" / "Billionare Coming Soon" / "Entrepreneur
 * Definition" are neutral — so no single family value is correct, and whichever one is stored
 * mis-genders some subset of the family's own designs. "We know what the design is" (PO) — the
 * design knows its audience; the system had nowhere to put it.
 *
 * WHY A SEPARATE LEAF MODULE, NOT INLINE IN listingPipeline.ts. listingPipeline.ts pulls in a
 * broken transitive dep chain in the local/CI test env (see audienceRelationalCompounds.ts's own
 * header), so a vitest file that imports it directly cannot unit-test a pure helper in isolation.
 * This module has ZERO imports and touches no DB — safe to import (and unit-test) from anywhere.
 *
 * WHY A NEW COLUMN, NOT `blank_assignments` (062). That table's shape (scope 'family'|'child',
 * keyed on parent_asin / a single child SKU) exists because a SKU's OWN style code can individually
 * be WRONG — a manufacturing/catalog fact that can genuinely disagree SKU-to-SKU within one design
 * group (B0DSG4T5BR's SKU says 64000, the PO says 6014). Audience is not that kind of fact: every
 * SKU inside one design group shares the same audience by construction — it is a per-DESIGN
 * editorial judgment, the same shape as the design's own NAME. This repo already has a proven idiom
 * for exactly that shape, live twice over: `listing_seo_scores.design_name_overrides` (migration
 * 034, {designKey: name}) and `keyword_analysis.theme_fit_by_design` (migration 061, {designKey:
 * {...}}) — a JSONB map keyed by the SAME `designKey` `detectDesignGroups` derives from the child
 * SKUs. `audience_lean_by_design` (migration 070) reuses that idiom rather than blank_assignments'
 * heavier one (separate table, RLS, PostgREST reload, catalog cross-reference) — "reuse, don't
 * reinvent" pointed at the CLOSER-fitting precedent, not the more recent one.
 *
 * PRECEDENCE (the ONE place it is expressed — every caller asks this, never re-derives it):
 *   1. audience_lean_by_design[designKey]  (migration 070) -> source 'design-assignment'
 *   2. the family's audience_lean          (migration 029) -> source 'family-default'
 * An unassigned design inherits today's family value — nothing changes until the PO assigns one.
 */

import type { AudienceLean } from './audienceRelationalCompounds'

export type { AudienceLean }

export type AudienceLeanSource = 'design-assignment' | 'family-default'

export interface ResolvedDesignAudience {
  lean: AudienceLean
  source: AudienceLeanSource
}

/** The seller-facing enum every write path validates against (audience-lean route, PR #195). Kept
 *  here too so this module's own precedence check never trusts an unvalidated DB value verbatim —
 *  a malformed/legacy map entry falls through to the family default instead of asserting garbage. */
const VALID_LEANS: ReadonlySet<string> = new Set(['male', 'female', 'lean_male', 'lean_female', 'unisex'])

/**
 * The audience lean ONE design group should be judged and written against.
 *
 * Pure, synchronous — the caller already has both values in hand (PipelineInput carries
 * `audienceLeanByDesign` straight off the same '*' select `audienceLean` already rides, same as
 * every other per-design override in this file's PipelineInput).
 *
 * `designKey` is the SAME key `detectDesignGroups` derives from a design group's child SKUs
 * (listingPipeline.ts) — the key `per_child_titles[].designKey` / `design_name_overrides` /
 * `theme_fit_by_design` already use. Absent/empty falls straight through to the family value, the
 * same fail-open direction an unresolved blank already takes to the family's dominant garment class.
 */
export function resolveDesignAudienceLean(
  designKey: string | null | undefined,
  byDesign: Record<string, string> | null | undefined,
  familyLean: AudienceLean,
): ResolvedDesignAudience {
  const key = (designKey ?? '').trim()
  const assigned = key ? byDesign?.[key] : undefined
  if (typeof assigned === 'string' && VALID_LEANS.has(assigned)) {
    return { lean: assigned as AudienceLean, source: 'design-assignment' }
  }
  return { lean: familyLean ?? null, source: 'family-default' }
}
