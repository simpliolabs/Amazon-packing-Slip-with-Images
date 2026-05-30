# Keyword Intelligence Engine V2: Fix Plan

**Principles applied:** Think Before Coding · Simplicity First · Surgical Changes · Goal-Driven Execution

---

## 0. Root Cause Analysis (Think Before Coding)

I traced every bug to its exact origin. No assumptions — only verified facts from the live API and source code.

### Bug A: All presence flags are `false` → everything is CRITICAL

**Root cause:** When `syncKeywordData.ts` ran the engine, it called `fetchListingContent(asin)` which queries `listing_content` WHERE `asin = 'B0FH39GY4R'`. The table HAS this data (confirmed via listing-optimizer endpoint which returns title/bullets for B0FH39GY4R). However, the keyword sync ran BEFORE the listing content sync completed for this child ASIN. The engine ran with `listing ?? {}` (empty object), so `checkPresence` returned `false` for every field. These stale results were stored in `keyword_analysis` and are now served from cache.

**Proof:** `curl .../intelligence/B0FH39GY4R?stored=true` returns 25 keywords, ALL with `inTitle=false, inBullets=false, inDescription=false, inBackend=false`. But the listing-optimizer endpoint confirms the title IS "THE CEO Memory Card Ultra SDHC UHS-I 90MB/s..." with bullets populated.

**Fix:** When the engine detects `listing` is null/empty, it must NOT store results. Additionally, the "Analyze Keywords" button must force a fresh re-run (not serve stale cache) so presence is recalculated against current listing content.

### Bug B: UPGRADE/REINFORCE/DEFENDED tabs are empty

**Root cause:** `engine.ts` line 238 calls `prioritizeActions(analyzed, 25)` which sorts CRITICAL first, then slices to 25. Since ALL 51 keywords are CRITICAL (due to Bug A), the top 25 are all CRITICAL. The UI filters `topOpportunities` by `actionType`, so non-CRITICAL tabs are empty.

**Fix:** Return ALL keywords grouped by category, not a flat top-25 list. The UI already has the filter logic — it just needs data.

### Bug C: Generic action text ("Add X to your title and first bullet point")

**Root cause:** `generateActions.ts` CRITICAL case always returns `Add "${keyword}" to your title and first bullet point`. This is correct behavior WHEN the keyword is truly missing from all fields. But because Bug A made everything appear missing, every keyword gets the same text. Once Bug A is fixed, the varied action text for UPGRADE/REINFORCE/DEFENDED will naturally appear.

**Verification:** The `generateActions.ts` switch statement already has distinct text for each action type. No code change needed here — fixing Bug A fixes Bug C.

### Bug D: Variant-specific 128GB info bleeding into parent recommendations

**Root cause:** `ai-recommendations/route.ts` line 176 uses `const rep = children[0] as ChildRow` (which is B0FH39GY4R, the 128GB variant) as the "representative" for building the AI prompt. The system prompt already says "do NOT mention variant-specific attributes" but the AI sees only one variant's data prominently.

**Fix:** The system prompt already handles this correctly (rule #1: "This is a MULTI-VARIANT listing family"). The issue is that `buildKeywordContext` passes keyword data from `children[0]?.asin` only. Since the SQP report is ASIN-specific, it returns keywords like "128 gb sd card" which are variant-specific. The AI then incorporates them. Fix: filter out variant-specific keywords from the CRITICAL list before passing to the AI, OR instruct the AI more explicitly to skip variant-specific capacity keywords.

### Bug E: Missing features (Description, Cannibalization, Product Details)

**Root cause:** The AI route already returns `recommended_description` in its JSON schema and the `AiRecommendations` interface includes it. But `OptimizerView.tsx` does NOT render it — it only renders title, bullets, and backend keywords. The description section was never wired to the UI.

For Cannibalization and Product Details: these were never implemented in any file. They require new logic.

---

## 1. Surgical Change Plan (6 files, 5 steps)

### Step 1: Fix stale presence data (the root cause of everything)

**File:** `src/lib/sync/syncKeywordData.ts`
**Change:** After `fetchListingContent(asin)`, if listing is null or has no title, fall back to fetching by `parent_asin` (get any sibling's content as a proxy), OR skip storing results and return an empty result with a message.

```typescript
// CURRENT (line 275-276):
const listing = await fetchListingContent(asin);
const result = runKeywordEngine(asin, rawKeywords, listing ?? {}, dataSource);

// NEW:
let listing = await fetchListingContent(asin);
// Fallback: if child has no content yet, try parent's first child that does
if (!listing || !listing.title) {
  const { data: parent } = await supabase
    .from('listing_content')
    .select('parent_asin')
    .eq('asin', asin)
    .single();
  if (parent?.parent_asin) {
    const { data: sibling } = await supabase
      .from('listing_content')
      .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
      .eq('parent_asin', parent.parent_asin)
      .not('title', 'is', null)
      .limit(1)
      .single();
    if (sibling) listing = sibling;
  }
}
const result = runKeywordEngine(asin, rawKeywords, listing ?? {}, dataSource);
```

**Verify:** `curl -X POST .../intelligence/B0FH39GY4R` → wait → `curl .../intelligence/B0FH39GY4R?stored=true` → presence flags should now be mixed (some true, some false).

---

### Step 2: Return ALL keywords grouped by category (fix empty tabs)

**File:** `src/app/api/fba/intelligence/[asin]/route.ts`
**Change:** Replace the flat `topOpportunities` (capped at 25) with a categorized response that includes top 10 per category.

```typescript
// CURRENT (line 91):
topOpportunities: stored.slice(0, 25),

// NEW:
topOpportunities: [
  ...stored.filter(k => k.actionType === 'CRITICAL').slice(0, 10),
  ...stored.filter(k => k.actionType === 'UPGRADE').slice(0, 10),
  ...stored.filter(k => k.actionType === 'REINFORCE').slice(0, 10),
  ...stored.filter(k => k.actionType === 'DEFENDED').slice(0, 10),
],
```

Same change for the non-stored path (line ~result from engine):

```typescript
// In engine.ts, replace prioritizeActions(analyzed, 25) with:
const topOpportunities = [
  ...analyzed.filter(a => a.actionType === 'CRITICAL')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10),
  ...analyzed.filter(a => a.actionType === 'UPGRADE')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10),
  ...analyzed.filter(a => a.actionType === 'REINFORCE')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10),
  ...analyzed.filter(a => a.actionType === 'DEFENDED')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10),
];
```

**Verify:** API response has keywords in all 4 categories. UI tabs show data.

---

### Step 3: Wire Description section to the UI

**File:** `src/components/fba/OptimizerView.tsx`
**Change:** Add a "Description" section below "Backend Keywords" in the AI-Generated Fix panel. The data (`aiRecs.recommended_description`) already exists in the response — it's just not rendered.

```tsx
{/* Description — currently missing from UI */}
{aiRecs.recommended_description && (
  <div>
    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
      Description
    </p>
    <div
      className="text-sm text-gray-900 bg-gray-50 rounded-lg p-3 border border-gray-200 prose prose-sm max-w-none"
      dangerouslySetInnerHTML={{ __html: aiRecs.recommended_description }}
    />
  </div>
)}
```

**Verify:** After regenerating AI audit, the right panel shows a "DESCRIPTION" section with HTML-formatted content.

---

### Step 4: Add Cannibalization detection

**File:** `src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`
**Change:** Add a cannibalization analysis section to the system prompt and expand the JSON schema.

The AI already receives per-variant content. We add this to the system prompt:

```
CANNIBALIZATION ANALYSIS:
Compare the per-variant titles and bullets. Identify keywords that appear in MULTIPLE variants
where they shouldn't (e.g., "128GB" appearing in the 32GB variant title). Also identify if
variants are competing against each other for the same search terms unnecessarily.

Add to your JSON output:
"cannibalization_warnings": [
  {
    "keyword": "string",
    "affected_skus": ["string"],
    "issue": "string (e.g., 'Both 32GB and 64GB variants target this 128GB keyword')",
    "recommendation": "string"
  }
]
```

**File:** `src/components/fba/OptimizerView.tsx`
**Change:** Add a "Cannibalization" section that renders `aiRecs.cannibalization_warnings` if present.

**Verify:** Regenerate AI audit → response includes `cannibalization_warnings` array → UI renders it.

---

### Step 5: Add Product Details improvements

**File:** `src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`
**Change:** The Seller Central "Product Details" page has many attribute fields (Material, Special Features, etc.). We already have the listing content. Add to the system prompt:

```
PRODUCT DETAILS PAGE IMPROVEMENTS:
Based on the listing content, suggest improvements for Amazon's structured product attributes
(the fields shown on the Product Details tab in Seller Central). Focus on fields that are
commonly searched or filtered by customers.

Add to your JSON output:
"product_details_improvements": [
  {
    "field_name": "string (e.g., 'Special Features', 'Material', 'Compatible Devices')",
    "current_value": "string or null",
    "recommended_value": "string",
    "reason": "string"
  }
]
```

**File:** `src/components/fba/OptimizerView.tsx`
**Change:** Add a "Product Details" section that renders `aiRecs.product_details_improvements` as a table.

**Verify:** Regenerate AI audit → response includes `product_details_improvements` → UI renders it.

---

## 2. What I Will NOT Touch (Surgical Changes principle)

- `checkPresence.ts` — logic is correct, just received empty input
- `calculateScore.ts` — scoring model is sound
- `generateActions.ts` — action text is already varied per type; Bug A masked this
- `KeywordIntelligencePanel.tsx` — filter logic works; it just needs data in all categories
- Database schema — no migrations needed
- Any formatting, comments, or style in untouched code

---

## 3. Execution Order & Dependencies

```
Step 1 → verify presence flags
Step 2 → verify tab data (depends on Step 1 for correct categorization)
Step 3 → verify description renders (independent)
Step 4 → verify cannibalization renders (independent)
Step 5 → verify product details renders (independent)
```

Steps 3, 4, 5 can be done in a single commit since they're all additions to the same two files (route.ts + OptimizerView.tsx).

---

## 4. Success Criteria (Goal-Driven Execution)

| # | Criterion | How to verify |
|---|---|---|
| 1 | Presence flags are accurate | `curl .../intelligence/B0FH39GY4R?stored=true` → at least some keywords show `inTitle=true` or `inBullets=true` |
| 2 | All 4 tabs have data | API response contains keywords with actionType CRITICAL, UPGRADE, REINFORCE, and DEFENDED |
| 3 | Action text is varied | Different keywords show different `actionText` values |
| 4 | Description renders in UI | Right panel shows "DESCRIPTION" section with HTML content |
| 5 | Cannibalization renders in UI | Right panel shows warnings about cross-variant keyword conflicts |
| 6 | Product Details renders in UI | Right panel shows a table of attribute improvements |
| 7 | No variant bleed in title | AI-recommended title does NOT hardcode "128GB" — uses range or is generic |

---

## 5. Assumptions (stated explicitly per Karpathy principle #1)

1. The `listing_content` table has data for B0FH39GY4R (confirmed via listing-optimizer endpoint).
2. The keyword engine's scoring logic is correct — only the input data (empty listing) was wrong.
3. The AI prompt's existing multi-variant rules are sufficient to prevent variant bleed once we stop feeding variant-specific keywords as CRITICAL.
4. No DB migrations are needed — all new fields are added to the existing JSON response.
5. The `recommended_description` field already exists in the `listing_seo_recommendations` table schema (confirmed in the AiRecommendations interface and upsert).
6. New fields (`cannibalization_warnings`, `product_details_improvements`) will be stored as part of the JSON blob in `listing_seo_recommendations` — Supabase JSONB columns accept arbitrary fields.

---

## 6. Questions / Tradeoffs for your decision

1. **Critical keyword cap:** I'm capping CRITICAL at 10 (top 10 by opportunity score). Should it be 5 instead?
2. **Variant-specific keyword filtering:** Should the engine exclude keywords containing variant-specific terms (e.g., "128gb", "32gb") from the CRITICAL list entirely, or just instruct the AI to handle them?
3. **Product Details fields:** The Seller Central page has 50+ attribute fields. Should the AI suggest improvements for ALL of them, or only the top 5-10 most impactful?
