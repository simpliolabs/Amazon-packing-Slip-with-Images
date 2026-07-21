# FBA Listing Optimizer — A–H Build Plan

> Status: **PLAN ONLY — no code written.** For PO approval before implementation. All anchors verified against the live tree at `C:/Users/Admin/AppData/Local/Temp/fba-portal`. Target listings: B0GQXSNQ6R / B0FRYMM56C (thin, low-traffic apparel; A+ 0/16).
>
> This revision incorporates the adversarial critique in full. The two P1 rewrites are in **E** (the joint byte×clean gate was jointly unsatisfiable on a dry pool → reproduced the #352/#404 degrade-preserve failure; the `fillBackendToBudget:522` edit was counterproductive) and one P1 clarification in **D** (the `scoreBullets` metric deliberately *reverses* task #39 and must say so, plus a hard runtime-ordering constraint). D's diagnosis and C/A/F/G are approved as drafted.

---

## Executive summary

| Item | One-line | Effort |
|---|---|---|
| **A** | Modals close only via a prominent X (kill backdrop-click close on 5 hand-rolled dialogs; add Escape); extract one `ModalShell`. | **S** |
| **B** | Surface many more pushable clothing attributes by *curating the existing schema-menu + map + prompt trio* (not a parallel list); truth-gate to BLANK_SPECS. | **M** |
| **C** | One "Ship all core" bulk PATCH — new `executeBulkCorePush` sibling to `executeBulkDetailsPush`; mixed broadcast+per-child body; **must stamp the outcome epoch**. | **M–L** |
| **D** | Generated **bullets** must score 85–100 like title/description, and pushing them must recalc. Plumbing recalc is already symmetric; the gap is **no score-to-85 self-heal loop** — add `scoreBullets` + **rewrite** the shadow bullets loop into an enforced keep-best-to-85 loop. | **M** |
| **E** | Backend keywords fill **220–250 bytes** with on-niche, non-echo, high-value terms via a **council (propose→deliberate→judge)** + a `scoreBackend` self-heal loop that **prefers short-and-clean over padded-or-stale**, with the deterministic core/`fillBackendToBudget` as fail-open budget guarantees. | **L** |
| **F** | A+ "Scan now" self-heal — one API re-check → UPDATE only A+ columns → re-score → client refetch; distinguish *not created* vs *pending Amazon review*. | **M** |
| **G** | A+ "Create" link is inert (`<span>`, dead `<p>`, Ship returns null) — render a real `<a>` deep-link to `/enhanced-content/content-manager`; branch header on `has_aplus`. | **S** |
| **H** | Multi-design regression: competitor-ASIN + Design-Name reference inputs are dead wires → niche-starved keyword universe → generic parent/per-design titles. Make them first-class `ReferenceGrounding` that seeds the universe (research-then-replace, signal-change re-seed) before every council reads it. | **L** |

**Dependency / sequencing overview.** A builds `ModalShell`, which C's confirm modal reuses → do A first. D and E share one template (metric + enforced self-heal loop mirrored from `runDescriptionAgent`); they land adjacent but as separate PRs (different files/blast radius, and each needs its own live verification). F and G are A+ surface work, independent of everything else. B depends on a live-schema debug pass and collides with in-flight sleeve work (#26) — sequence it last among the push-side items. **H is upstream of E**: it fills the keyword universe E consumes, so H lands before E and hard-blocks E's acceptance gate.

---

## A) Modals should close only via a prominent X

### Problem
Every dialog on the listing page is **hand-rolled** — no shared `<Modal>`. Each is an outer backdrop `<div class="fixed inset-0 … bg-black/40" onClick={close}>` wrapping an inner card with `onClick={(e)=>e.stopPropagation()}`, so any outside/backdrop click closes it, and the X is a tiny `&times;`/`×` in `text-slate-400 … text-lg`. Verified instances in `src/app/fba/listing/[asin]/page.tsx`:

| Modal | Backdrop close | X button |
|---|---|---|
| Takeover | `4078` → `!claimBusy && setTakeoverOpen(false)` | `4083` |
| Fix-capacity | `4118` → `!fixCapLoading && setFixCapTarget(null)` | `4122` |
| Relink | `4206` → `!relinkLoading && setRelinkTarget(null)` | (same pattern) |
| Auto-Push / bulk-details | `4296` → `setBulkOpen(false)` | `4300` |
| Core Ship / push-preview | `4421` → `setShowPushModal(false)` | `4433-4437` |

Preserve-worthy facts: push/bulk modals are **intentionally closeable mid-stream** (fetch lives in page JS; floating pill at `4407` reopens; titles say *"Safe to close — the push keeps running in this tab"*, `4300`/`4435`). Three modals guard close behind a busy flag. `page.tsx:1990` is a **loading/lock overlay** (`blockedByOther`) — not dismissable, **leave it alone**. No Escape handler or focus trap exists anywhere.

### Decision
Make dismissal **explicit-only**: remove backdrop `onClick` close on the five modals (keep inner `stopPropagation`), promote the X to a real ~32px `rounded-full` `bg-slate-100 hover:bg-slate-200` button with `aria-label="Close"`, and add **Escape → close** per modal (gated on the same busy flag). Best structural fix: extract one tiny **`ModalShell`** and migrate all five — this stops the next hand-rolled dialog from re-introducing backdrop-close, and C reuses it.

### Architecture
Pure presentational change; touches no ship-truth/push/scoring code. `ModalShell` owns the `fixed inset-0` backdrop (no close-on-click), a `dismissDisabled?` prop (preserves `claimBusy`/`fixCapLoading`/`relinkLoading`), a `useEffect` Escape listener gated on the same flag, sticky header/footer slots, and the prominent X. Each modal keeps its own body/title/tooltips.

### Code plan
`src/app/fba/listing/[asin]/page.tsx`
- **Preferred:** new `src/components/fba/ModalShell.tsx` (`open`, `onClose`, `dismissDisabled?`, `title`, `headerRight?`, `children`, `footer?`, `maxW?`). Migrate `4078`, `4118`, `4206`, `4296`, `4421`. Preserve each modal's `max-h-[85vh] overflow-y-auto` and the sticky top/bottom bars on bulk (`4298`/`4381`) and ship modals.
- **Fallback (smaller diff):** at each backdrop `<div>`, delete the `onClick`; replace the X with the prominent variant + `aria-label`; add a `useEffect` keydown→close respecting the busy guard.
- Keep the X **always enabled** on push/bulk modals so "safe to close mid-push" + the reopen pill (`4407`) still work.
- **Do not touch** `page.tsx:1990`.

### Open questions
1. Escape-to-close allowed (recommended, a11y) or strictly X-only?
2. Shared `ModalShell` (durable) vs five surgical edits (smaller churn on a high-traffic file)? Recommend shell unless minimizing collision with in-flight #23/#26.

### Effort / risk
**S.** Risks: a shared shell can regress z-index/scroll-lock or drop the sticky header/footer of bulk & ship modals (verify the streaming pill still appears when closed mid-push); the three busy-guards must survive on **both** X and Escape. No data-path risk.

---

## B) Add many more pushable clothing attributes

### Problem
PO's requested set: Model Name, Handmade Classification, Special Features, Style, Fabric Type ("100% Cotton"), Care Instructions, Shirt Form Type, Sleeve Length Description, Sleeve Type, Animal Theme, Fit-to-Size Sentiment. Today only a subset is reliably surfaced/pushable.

### Root cause / decision
This is a **curation problem, not a plumbing problem.** The detail system is already schema-menu-driven and dynamic; the static map is only the no-menu fallback, and the push machinery auto-maps *any* schema attribute. Flow:

1. **Generation** — `runAuditAgent` (`src/lib/fba/listingPipeline.ts:3477`) emits `product_details_improvements[{field_name,current_value,recommended_value,reason}]`, grounded by `specsLine` (BLANK_SPECS) + `menuLine` (live schema menu, `.slice(0,26)`).
2. **Schema menu** — `listPushableSchemaAttributes` (`src/lib/fba/productTypeDefinitions.ts:364`): filters `MENU_EXCLUDE` (`334`), `MENU_PER_VARIANT` (`348` = `color/size/memory_storage_capacity/`**`style`**), and image locators; bands by `MENU_SEO_PRIORITY` (`359`) first / `MENU_NOISE` (`362`) last; returns top `max=26`; then an **ALWAYS-INCLUDE** loop force-adds `item_highlights`/`title_differentiation` (`397-407`). Called from `ai-recommendations/route.ts:600-624`.
3. **UI enrichment** — the recs GET computes `pushable`/`sp_api_key`/`enum_accepted` server-side (`route.ts:882-919`): `resolveDetailAttribute` → `resolveSpApiKeyFromTitle` → `attributeExistsInSchema` → `coerceDetailValue`. Multi-design forces `DESIGN_NAME_SLOT_KEYS` (`style_name`/`color_name`/**`style`**/`color`) per-variant/unpushable (`902`).
4. **Push** — single via `executePush` details branch; bulk via `executeBulkDetailsPush` (`pushExecutor.ts:3295`); composites (neck/sleeve/closure) via calibrate→`buildShapedDetailValueVariants` (`3346-3373`).

**Already ships today** (in `ATTR_MAP`, `src/lib/fba/productDetailAttrs.ts:68-120`): `material`, `fabric_type`, `fit_type`, `style` (mapped broadcast at `:75` but menu-excluded by `MENU_PER_VARIANT`), `style_name`, `pattern`, `sleeve_type`, `neck_style`, `care_instructions`, `department`, `target_gender`, `age_range_description`, `occasion`, `theme`, `special_feature`, `item_shape`. So **Special Features, Fabric Type, Care Instructions already map**; **Sleeve Type** is mapped but blocked by the sleeve write-rejection saga (**#26 in_progress**).

**Per requested item, still to do:**
- **Model Name** (`model_name`) — add to `MENU_SEO_PRIORITY` + ALWAYS-INCLUDE.
- **Style** — *contradictory*: broadcast at `productDetailAttrs.ts:75` but menu-excluded (`348`) and forced per-variant on multi-design (`route.ts:902`). Needs the single/multi-design split.
- **Sleeve Length Description** — the derived composite sub-field `sleeve.length_description` the composite architecture intentionally does **not** write. **Leave out** (writing it resurrects the sleeve sub-field drop bug, #26 territory).
- **Animal Theme** — friendly→`theme` (or per-schema `animal` key) alias.
- **Shirt Form Type** (`shirt_form_type`) — confirm the key exists in the live SHIRT schema before mapping.
- **Fit-to-Size Sentiment** — no standard SP-API key; likely free-text `fit_to_size`/`size_to_size_recommendation` if present; likely degrades to Manual/copy-only.
- **Handmade Classification** — almost certainly HANDMADE-program-only, absent from SHIRT → Manual/copy-only, never a forced wrong key.

Decision: **extend the existing menu + map + prompt trio** (never a parallel attribute list), plus a BLANK_SPECS truth-gate. Force-inclusion must be **schema-gated** (`attributeExistsInSchema`) per listing or a push 400s and creates unfillable Features-gap docks.

### Architecture
Rides existing rails end-to-end. New attributes become generated+pushable when they (a) exist in the live product-type schema, (b) survive `listPushableSchemaAttributes` ranking/ALWAYS-INCLUDE, (c) the audit fills them, (d) resolve/coerce/push auto-maps them. Only new logic: the single-vs-multi-design gate on `style` and the BLANK_SPECS truth-gate generalization.

### Code plan
`src/lib/fba/productTypeDefinitions.ts`
- `MENU_SEO_PRIORITY` (`359`): add `model_name|shirt_form_type|animal|fit_to_size|size_to_size|handmade`. **Verify none collide with `MENU_NOISE` (`362`)** (noise band tested first — see the `compliance_age_range` precedence note at `376-379`).
- `MENU_PER_VARIANT` (`348`): make the `style` exclusion **conditional on multi-design** — thread an `isMultiDesign` flag from `route.ts:600` into `listPushableSchemaAttributes`; exclude `style` only when true.
- Add an apparel **ALWAYS-INCLUDE** block after `397-407` force-adding schema-present PO keys (`model_name`, `special_feature`, `fabric_type`, `care_instructions`, `fit_to_size`, `shirt_form_type`, `theme`). Consider bumping `max` from 26.

`src/lib/fba/productDetailAttrs.ts`
- `ATTR_MAP` (`68`): add `'model name'→model_name`, `'special features'→special_feature`, `'animal theme'→theme`, `'shirt form type'→shirt_form_type`, `'fit to size'`/`'fit-to-size sentiment'`→(confirmed key or omit), all `scope:'broadcast'`. **Do not** add `sleeve length description`.

`src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`
- `600-624`: pass `isMultiDesign` into `listPushableSchemaAttributes`.
- `902`: confirm `style` stays per-variant **only** when `familyMultiDesign`; ensure removing `style` from `MENU_PER_VARIANT` on single-design doesn't leak a multi-design style to broadcast.

`src/lib/fba/listingPipeline.ts`
- `BlankSpec` + `BLANK_SPECS`: extend with `fabricType`/`careInstructions`. Generalize the blankSpec override block (fit+sleeve today) to also snap `material`/`fabric_type`/`care_instructions` when the blank is known; unknown-blank rows stay advisory.
- Audit prompt (`~3537`): optionally name the new apparel attrs in the no-menu fallback string (no structural change).

**Verify each new key against a LIVE SHIRT schema** via `?debug=1&field=details&detail_field=` before claiming it pushable.

### Open questions
1. Force-include (guaranteed offered, may recommend guessed values) vs offer-only-when-confidently-derived?
2. Sleeve Type is blocked by #26 — ship the rest now and treat sleeve separately?
3. Confirm exact keys for `shirt_form_type`, `fit_to_size`; confirm Handmade is HANDMADE-only.
4. Unknown blanks: suppress entirely, or advisory copy-only (recommended)?

### Effort / risk
**M.** Risks: truth violation (LLM-guessed fabric/care for a known blank — must be BLANK_SPECS-grounded); `style` leak to broadcast on a POD family clobbering every design's name slot; forced off-schema attribute 400s + unfillable docks (gate on `attributeExistsInSchema`); Sleeve Length Description resurrecting the sub-field drop bug (keep it out); enum bypass (new field_names must reach the validate-at-regen coercion, `route.ts:857-923`, so enum-invalid → seller-picker not auto-push).

---

## C) One "Ship all core" bulk PATCH

### Problem
Core content ships **one field at a time**. Per-section Ship buttons (title/bullets/description `~page.tsx:2944/2976/3244`, keywords `3013`) → `openPushPreview(field)` (`1272`) → `confirmPush` (`1387`) → POST `push-content`; the route (`push-content/route.ts:191-195`) dispatches **`details_bulk` → `executeBulkDetailsPush`, everything else → `executePush`** (a per-SKU loop for **one** field). Shipping all four = 4 modals, 4 POSTs, 4 × N-SKU × 2 PATCH calls, and a window where a variant shows title-new/bullets-old.

### Root cause / decision
No core-bulk executor exists. The proven template is `executeBulkDetailsPush` (`pushExecutor.ts:3295`): PHASE 1 drops the non-buyable parent (`3339-3340`); PHASE 3 per SKU reads current → `changedDetailFields` → **one `patchSkuMulti`** (VALIDATION_PREVIEW `3415` → LIVE `3419`) with `pushPerFieldFallback` (`3424`/`3539`) isolating fields on atomic rejection; one `keyword_push_log` per (field,SKU) (`3433`); PHASE 4 write-through + **one** re-score (`pickRescoreRepresentative`) + `enqueueVerification` per field (`3441-3502`). **Critically it does NOT stamp the outcome epoch** (`3475-3477`) — details change attributes, not copy.

Core fields already have every per-SKU primitive: `resolveProposed` (`pushFields.ts:132`) handles broadcast (title/bullets/desc) **and** per-child (keywords via `perChild.get(sku)`, plus `per_child_titles/bullets/descriptions` for multi-design/capacity); `buildPatchValue` (`206`); `cacheUpdateFor` (`428`); `deriveActionPlan` (`293`). The single-core path **does** stamp the epoch on strict full-accept (`pushExecutor.ts:3251`).

Decision: add a **third executor `executeBulkCorePush`** — do not overload `executePush` or the details path. Core needs none of the details machinery (enum coercion, composite calibration) but needs everything details_bulk skips: parent-hub broadcast rows, per-child keyword shape, trademark scrub, manual-title semantics, and — the sharp edge — **the outcome-epoch stamp, because copy actually changes.**

### Architecture
Reuses `resolveProposed`/`buildPatchValue`/`cacheUpdateFor`/`deriveActionPlan`/`pickRescoreRepresentative`/`stampOutcomeEpoch`/`enqueueVerification` verbatim. Two divergences the reviewer must not simplify away: (1) **core-bulk MUST stamp the outcome epoch** (mirror `3251`; details_bulk deliberately doesn't, `3475-3477`); (2) a **mixed broadcast + per-child PATCH body** — `generic_keyword` is per-child and must never reach the variation parent.

**The two sharp edges:**
1. **Mixed broadcast/per-child body.** One PATCH per SKU carries broadcast fields (same value, incl. the parent hub that `loadDiff` adds only for broadcast, `565-616`) **and** the per-child `generic_keyword` (only where that SKU has a keyword diff). **Drive ops off each field's own `loadDiff` row presence — not a merged field list** — or a keyword op leaks onto the parent hub. On multi-design/capacity families `resolveProposed` returns `per_child_*` bytes; broadcasting one value poisons variants.
2. **Atomicity.** `patchSkuMulti` is atomic per SKU — one bad field (over-long backend) rejects title+bullets+desc too. A `pushCoreFieldFallback` (core analog of `pushPerFieldFallback`, single-attribute `patchSku`) is **mandatory**.

### Code plan
`src/lib/fba/pushExecutor.ts` — new `executeBulkCorePush(params, emit)` (~+180 lines, no edits to `executePush`), modeled on `executeBulkDetailsPush`:
- `PushParams`: add `core_fields?: PushField[]` (subset of title/bullets/description/keywords; default all four).
- `reconcileFamilyChildren(parent_asin)` once (mirror single-core reconcile).
- For each requested field `loadDiff(parent_asin, field)` (`pushExecutor.ts:401`); build `unionSkus` + `perSkuField: Map<sku, Map<field, {raw,current,changed,notLive,isParent,asin}>>` (broadcast-vs-per-child-in-one-body for free — keywords simply lack a row for parent/no-kw SKUs).
- Per SKU (skip `notLive && asin!==parent` — carry the **UPDATE-ONLY / phantom-listing gate** or offerless SKUs get PATCHed → Amazon creates "Missing offer" ASINs): gather each field where `row.changed`; `scrubTrademarks` each value; `ops = changedFields.map(f => ({op:'replace', path:'/attributes/'+FIELD_CONFIG[f].attribute, value: buildPatchValue(...)}))`. Never include `generic_keyword` on the parent hub.
- `patchSkuMulti` PREVIEW→LIVE; on rejection `pushCoreFieldFallback`.
- Per accepted (field,SKU): one `keyword_push_log` with `field=<PushField>` **unprefixed** (unlike `details:<key>`), `previous_value=row.current`; `cacheUpdateFor` write-through.
- One `rescoreParentFromCache` + `appendScoreHistory{trigger:'push'}`.
- Per core field with ≥1 accept: `enqueueVerification({parent_asin,field})` (verify-push already supports all four, `verify-push/route.ts:13,31`).
- `logPushChange` per field + one `logAudit{mode:'core_bulk'}`.
- **On full-accept (`!cancelled`, every included op accepted): `stampOutcomeEpoch(...)` once** (mirror `3251`). Partial → do **not** stamp.
- Manual titles: batch ships `resolveProposed(recommended_title)` and relies on `title_source='manual'` already living in `recommended_title`; keep the single Title Ship as the path for a freshly-typed title + the manual-title-lock on the single path only.
- Extract a **pure, testable** `buildCoreOps(perSkuFieldRow, marketplaceId)` for unit tests without Amazon.

`src/app/api/fba/listing-optimizer/push-content/route.ts`
- POST body (`157`): add `core_fields?: PushField[]`. Dispatch (`191`): `else if (rawField === 'core_bulk') await executeBulkCorePush({ parent_asin, core_fields, cancel_token, actor }, emit)`. (Lower priority: mirror into push-jobs for background parity.)

`src/app/fba/listing/[asin]/page.tsx`
- State `coreBulkOpen/Items/Running/Progress` mirroring `bulk*`; items from the derived action-plan core elements, default-checked by verdict (REPLACE→checked, DONE→unchecked-but-toggleable).
- `runCoreBulkPush` cloned from `runBulkPush` (`1603`): POST `{field:'core_bulk', core_fields, confirm:true, cancel_token}`; reuse the same NDJSON reader + 60s stall watchdog; on result refetch score + rank-free + GET plan.
- "Ship all confirmed core →" button `~3242`, gated by the concurrent-push guard (`openBulkPush`, `1583`). Reuse `ModalShell` (from A) for the confirm modal.

### Open questions
1. Keywords in the batch by default? (PO framed "Title/Bullets/Keywords/Description" — include, but badge as per-child so the single-value preview isn't misleading.)
2. One combined confirm modal with per-row skip toggles (recommended) vs require each section pre-approved?
3. Read-only preview (recommended) vs edit-before-push?
4. Multi-design/capacity families: relabel/hide "Ship all core" so per-design Ship presets (`onShipDesignField`, `1951`) stay primary?
5. Background-job parity via push-jobs, or is the streaming modal enough for v1?

### Effort / risk
**M–L.** Risks: outcome-epoch divergence (copy-pasting details_bulk drops the stamp — **must** stamp on full-accept); per-child resolution (call `resolveProposed` per SKU or multi-design ships one design's bullets everywhere); parent-hub keyword leak (drive ops off each field's diff row); ship-truth write-through (every accepted field `cacheUpdateFor` or the card stays red, #358); phantom listings (carry the `notLive` gate); atomicity (`pushCoreFieldFallback` mandatory); stream drop mid-batch (idempotent changed-filter re-run + stall watchdog — **#23 applies here too**); trademark scrub each value.

---

## D) Generated bullets must score 85–100 and pushing them must recalc

### Problem
Pushing generated **bullets** does not lift the bullets score the way pushing **title** and **description** do. The PO standard is explicit: *every generated section must score 85–100 per its own label, and shipping the generated content must recalculate the score to reflect the new generation* — exactly as title and description already do.

### Root cause / decision
Two candidate causes were named: **(1)** a real recalc/write-through asymmetry, and/or **(2)** no score-to-threshold self-heal loop for bullets. Verified from code:

**Candidate (1) — plumbing asymmetry: DISPROVED.** Bullets push writes the exact columns the scorer reads and triggers the same field-agnostic re-score as title/description:
- `cacheUpdateFor` (`src/lib/fba/pushFields.ts:428-437`) fans a bullets push into `bullet_1..5` — **exactly the columns the scorer reads** (`syncListingContent.ts` `representativeContent.bullet_1..5`). Title/description write one column; bullets write five; both handled. No column mismatch.
- Applied at push (`pushExecutor.ts:3122-3128`) — same single `listing_content.update({ ...cacheUpdateFor(field, value) })` line for all three fields.
- Re-score trigger (`pushExecutor.ts:3155`): `shouldRescore = accepted > 0 || childTotal === 0` — **field-agnostic, no bullets branch**.
- Re-score body `rescoreParentFromCache` (`pushExecutor.ts:2636`): re-reads `bullet_1..5`, calls `scoreListingContent`, writes **all six** sub-scores including `bullet_score`. No field parameter. Same for bulk (`3457-3469`) and details (`2893-2905`), all via `pickRescoreRepresentative` (`rescoreRepresentative.ts:20`).

So a bullets push **does** recompute `bullet_score` symmetrically. The push mechanism is not the bug.

> **Reconciliation note (an earlier research pass got this wrong).** One pass proposed *removing* the "-12 cross-field opportunity dock" from the bullet card (`syncListingContent.ts:916-937`) as a stale double-count. **Reject that.** The card at `916-937` shows the dock was **already reformed** (the 2026-07-09 "6/18 contract fix", comment `920-930`): its haystack is now **title ∪ bullets ∪ backend** (`931`), it is **off-niche-filtered** via `isOffNicheKeyword` (`916`), capacity/color-filtered (`910-911`), and it docks **only for keywords covered by *no* section** — "an HONEST dock … which regeneration CAN fix" (`928-930`). It is no longer a double-count and must not be ripped out (would reverse a deliberate PO-approved reform; violates *don't-overgeneralize-specific-failures*). The description-card double-count that *was* removed (3c, `1003-1032`) is a different, genuinely-redundant dock.

**Candidate (2) — no score-to-85 self-heal loop for bullets: CONFIRMED. This is the whole bug.**
- **Description HAS the enforced loop** — `runDescriptionAgent` (`listingPipeline.ts:3661-3717`): `THRESHOLD = 85`, `MAX_ITERS = 4`, `scoreDescription` (`1665`) → critique → regenerate, **keep-best-scored**, returns `bestDescription` — the improved text ships.
- **Bullets do NOT.** `runBulletsAgent` (`2703-3146`) has only `validateBullets` (`2918-2964`) — a pass/fail retry keyed on brand-safety / caps-hook / capacity / `<100 chars`. It (a) never optimizes to a numeric `bullet_score` threshold, and (b) uses a **different rulebook than the scorer** (100-char floor vs the scorer's 80; no `titleOnlyKeywords` check; coverage against `opportunityKwsSafe` rather than the scorer's backend-inclusive haystack).
- The only score-shaped bullets machinery is **shadow-only and ships nothing**: `scoreBulletsMetric` (`4397-4411`) explicitly *"EXCLUDES keyword coverage and the length dock BY CONSTRUCTION"*; `metricGatedBulletsLoop` (`4448-4492`) is frozen (`const best = shipBullets // FROZEN in shadow`, `4458`; "shadow ships nothing", `4485`); its call site (`7017-7024`) is gated `BULLETS_METRIC_LOOP === 'shadow'` — **default unset → never runs**, and even set, ships nothing.

**Enumerated `bullet_score` deductions** (from `scoreListingContent`, start at 25, `Math.max(0,…)`): #2 `<5 bullets` −10 (`849-851`); #3 short bullets `<80 chars` −min(15, n·5) (`857-859`); #4 ≥3 bullets not CAPS-benefit-led −3 (`864-866`); #5 ≥2 opportunity kw uncovered across title∪bullets∪backend −min(12, n·2) (`917-937`); #6 >3 title-only keywords absent from bullets −3 (`957-960`); #7 design-name cohesion −4 (`1121-1134`). 85% of 25 = **21.25**, so a shipped set may lose ≤3.75. Any one of #4/#6 (−3), #7 (−4), or a single short bullet (#3, −5) individually pushes it below 85 — and none are what `validateBullets`/`scoreBulletsMetric` drive to zero. That is exactly why generated bullets sit sub-label while title/description reach theirs.

**Decision:** the recalc is already symmetric — **do not touch the push mechanism and do not touch the bullet score card.** Close the gap where description already closed it: add a real `scoreBullets` aligned to the scorer, and **rewrite** the shadow bullets loop into an enforced keep-best loop to 85 (this is a rewrite, not a config flip — see effort note). The existing push re-score then surfaces the higher `bullet_score` to the ring with no further change.

**P1 — this metric deliberately REVERSES task #39, and the plan must say so.** `scoreBulletsMetric` (`4397-4399`) *"EXCLUDES keyword coverage … and the length dock … BY CONSTRUCTION"*, citing Content-step-2 (#39: neuter the prose coverage-backstop, move coverage to backend). `scoreBullets` re-adds **#5 (coverage)** and **#3 (length)**. This is defensible — the *scorer itself* docks for both, so satisfying the scorer is not Goodhart — **but it is undoing #39's central move and must be stated as such in the PR description**, or a reviewer who worked #39 will block on sight. The reversal is bounded (below) so it does not re-break #39: #5 targets only terms **genuinely uncovered across the backend-inclusive haystack AND bullet-appropriate** — never opportunity/backend-home terms that already live in backend.

### Architecture
Mirror the description quality-bar pattern (`gen-description-quality-bar`) for bullets, one-for-one. The metric must agree with the scorer **by construction** (same shared `isCovered`/backend-inclusive haystack, same 80-char floor) so the loop optimizes the exact thing the scorer grades — no rulebook fork. Run it inside the **per-design fan-out** so the per-child multi-design bullets that actually ship also reach 85 (coherence Invariant 5). Fail-open: never ship empty/degraded.

**P1 — hard runtime-ordering constraint (backend before bullets).** `scoreBullets` #5 reads `[title, ...bullets, backend]`. If the bullets loop runs **before** the backend council finalizes for that child, D scores bullets against a stale/pre-council backend, sees a term as uncovered, and stuffs it into bullet prose — re-introducing exactly the backstop #39 removed, *even with #5 gated on the haystack*. Therefore:
- In the per-design fan-out, **backend must be generated for a child before that child's bullets self-heal loop runs**, and `scoreBullets` reads that child's **freshly-generated `per_child_keywords`**.
- On the `#79` **bullets-only** section-regen (where backend is NOT regenerated), `scoreBullets` reads the **live persisted** backend for the child.
State this as a non-negotiable sequencing constraint in the PR.

### Code plan
`src/lib/fba/listingPipeline.ts`
- **New `scoreBullets(bullets, ctx): { score: number; critiques: string[] }`** (0–100), placed next to `scoreDescription` (`~1665`), codifying scorer deductions **#2–#7**:
  - Reuse `missingBulletKeywords` / `missingVerdict` for **#5** against the **same `[title, ...bullets, backend]` haystack** the scorer uses (`syncListingContent.ts:931`) — do **not** fork a tokenizer. Because the haystack includes backend, a term already carried by backend counts as covered: the loop must **not** cram opportunity/backend-home terms into bullet prose. It only ever asks bullets to fix genuinely-uncovered, **bullet-appropriate** residual terms.
  - Include the **length dock at the scorer's 80-char floor** (`857`), not `validateBullets`'s 100. Include #2 (count), #4 (CAPS benefit-lead), #6 (`titleOnlyKeywords`), #7 (design-name cohesion, `1121-1134`). Optionally fold role/profession-leak and fit/widow-POV checks (reuse `ctx.widow`/`ctx.fit` from `scoreDescription`).
- **Rewrite `metricGatedBulletsLoop`** (`4448`, call site `7017-7024`) into an **enforced keep-best loop** — *not a promote/flag-flip*. The shadow loop returns `BulletMetric {total, di, co, st}` in `[0,1]`, keeps-best on `.total`, bar `0.999`, `MAX_ITERS = 2`. The description template it mirrors returns `{score 0-100, critiques}`, bar `85`, `MAX_ITERS 4`. These are **different contracts** — this rewrites the metric's return shape *and* the loop's keep-best/threshold/critique wiring, swapping `di/co/st` for the seven scorer docks. `THRESHOLD = 85`, `MAX_ITERS ~3-4`, generate→`scoreBullets`→critique→regenerate, ship the best-scored set (template = the description loop `3677-3717`). Remove the shadow freeze (`4458`/`4485`) and the `BULLETS_METRIC_LOOP==='shadow'` default-off gate. Keep apparel-gated and fail-open (reuse the `assertCoreHealthy` guard at `7029`; never ship empty).
- Wire the loop into the **per-design fan-out** (`~6346-6408`), **after** backend generation for the child (ordering constraint above), so per-child bullets (the bytes `pushFields.ts` prefers via `per_child_bullets`) reach 85. Mirror into **both write paths** — the full recs upsert and the `#79` bullets-only section-regen in `ai-recommendations/route.ts` — so the section-regen that ships also persists `bullet_1..5` and re-scores before the user pushes (matches description; verify with a live regen per *shipping-from-fact*, not tsc).

`src/lib/fba/pushExecutor.ts:2636`, `ai-recommendations/route.ts` — no mechanism change; the only defensive add is ensuring the `#79` section-regen persists+re-scores (above).

### Open questions
1. Should `scoreBullets` also gate on role/profession-leak and fit/widow-POV, or keep those in `validateBullets` and have `scoreBullets` grade only the seven numeric docks? (Recommend folding them in so one metric governs "generated quality".)
2. `MAX_ITERS` 3 or 4 for bullets (description uses 4)? Cost is one extra LLM pass per miss.
3. Any listing class where 85 on bullets is structurally unreachable (a genuinely-uncovered term that is *not* bullet-appropriate)? The loop must **cap and keep-best**, not spin — and never keyword-stuff to force the number.

### Effort / risk
**M** (a real rewrite of both `scoreBulletsMetric`→`scoreBullets` and the loop, not a flag flip — scope accordingly). Risks: (a) the loop becoming a **keyword-stuffer** that re-introduces the removed prose backstop — mitigated by #5 gated on the backend-inclusive haystack *and* the backend-before-bullets ordering constraint (without the ordering, the haystack gate is insufficient); (b) metric/scorer drift — mitigated by reusing the scorer's exact helpers/haystack; (c) per-design fan-out cost (N children × up to 4 passes) — apparel-gated, keep-best; (d) fail-open — a loop outage degrades to today's `validateBullets` output, never empty (the #352 empty-persist lesson).

**Verification gate.** A real regen + bullets-only push on an apparel ASIN (B0FRYMM56C) must show `bullet_score` rise into the **21–25 (85–100%)** band and the card flip to DONE, **with no dependence on a backend push**, and all three surfaces (card, RANK panel, Intelligence tab) agreeing.

---

## E) Backend keyword council — 220–250 bytes, propose → deliberate → judge

### Problem
Backend keywords must reach **220–250 bytes** of on-niche, non-echo, high-value terms. Today the fill that reaches for the last ~20–50 bytes is a **single-shot LLM call over a drained pool** with no adversary and no relevance judge — the exact "thin deterministic top-up" the PO rejects. It under-delivers on thin pools and has shipped generic/echo/off-niche filler (task #69).

### Root cause / decision
`runBackendAgent` (`listingPipeline.ts:3150-3465`) is deterministic assembly + one thin LLM top-up, **not a council**:
1. Core whole-phrase loop, token-filtered, stops at **200 bytes** (`3198-3253`; `if (getByteLength(...) >= 200) break`, `3252`).
2. Gap-closing token pack to **233** (`3283-3305`).
3. LLM theme-fill — fires only `if (< 220)` (`3314`), one `gpt-4.1-mini` call (`temp 0.6, max_tokens 300`), stops `>= 233` (`3348`), wrapped in a `try/catch` that **silently swallows** errors (`3351`) — **single proposer, no deliberation, no judge**.
4. Per-color tail (`3358-3409`) + `buildString` dedupe/truncate to **250** (`3431-3444`).
5. `fillBackendToBudget` (`451-561`) tops up from `topVolumeBackendPhrases` (`429`) + leftover pool + canonical bigrams; **early-returns at 244** (`522`) — a stop-early cost guard that runs *after* the volume-priority pass (`489-519`) has already force-placed up to 250; cap 250.

Post-conditions: `backendOutputProblems` (`567-599`) only flags `minBytes < 190` (`580`) — a **byte floor, not a quality judge** — plus a per-color differentiation check with the #404 single-confident-color exemption (`594`). Scorer levers (`syncListingContent.ts:1036-1103`): `<100 → −8`, `<200 → −4`, `≥200 → clean`; commas −3; `>250 → −5`; plus the keyword-intelligence `criticalCount` dock (`1089-1101`). So the score-mover is **on-niche, non-echo coverage that closes CRITICAL gaps, and staying in the ≥200 clean band.**

**Key insight (from the critique): the byte number is subordinate to cleanliness.** The scorer already rewards `≥200 → clean`. A clean **205-byte** field beats a padded **240-byte** field that dragged in off-niche/echo terms (which then *dock* `keyword_score` via the off-niche/`criticalCount` levers, `1089-1101`). So the goal is **fill to 220–250 with on-niche non-echo terms *when the pool allows*, and prefer short-and-clean over padded-or-stale when it does not.** A hard 220-floor × hard 0-off-niche gate is **jointly unsatisfiable on a dry pool** (e.g. B0GQXSNQ6R, this item's own target) and reproduces the #352/#404 degrade-preserve failure — that gate design is rejected.

Decision: replace the single-shot fill (step 3) with a **council (propose→deliberate→judge)**; keep the deterministic core+gap-closing (steps 1–2) as the trusted demand-backed **seed/fallback**; wrap it in a `scoreBackend` **self-heal loop whose GREEN condition prefers short-and-clean over padded-or-stale**; and keep `fillBackendToBudget` as the final deterministic **budget guarantee** so a council outage degrades to today's output, never to empty. Mirror the description/bullets pattern (council + metric-gated self-heal).

### Architecture
**Seed** = the deterministic core + gap-closing output (byte-efficient, demand-backed) so the council starts from real terms and can never regress coverage. **Council** fills the residual budget toward 220–250. **Deterministic nets dispose** at every seam (per *editorial-audit-prompt-leaks*). Runs **inside the per-design fan-out** on the bytes that actually PATCH (`per_child_keywords`), mirrored into both write paths (full upsert + `#79` section-regen), and — per D's ordering constraint — **finalizes before that child's bullets loop reads the backend haystack**.

**Council brief inputs:** `finalTitle`, `designName`, the already-placed **core** (so proposers never echo), `excludeWords`/`titleWords` (title+bullet+brand+color echo index — Invariant 3), the **remaining opportunity pool with search volumes**, the live **CRITICAL keyword set** (`scoringCtx.topCriticalKeywords` — the score-mover), the byte budget remaining to 250, and the ban predicates (`banTok`/`banBackendTok`, `THIRD_PARTY_BRANDS`, `kidsWords`, `PRODUCT_TYPE_WORDS` cap, `isOffNicheKeyword`).

**P3 — proposers emit ranked candidates, only the judge packs to budget.** Do **not** ask each of 3 proposers for a full 220–250-byte string — that pushes the byte target to three seams and incentivizes each to pad with filler to hit the count (the exact material the adversary then has to strip, causing oscillation). Instead:
1. **Propose (N=3, varied temperature/persona, JSON) → ranked candidate tokens/phrases WITH volume, no byte target:** (i) **demand/volume maximizer** — highest-volume on-niche opportunity tokens; (ii) **long-tail buyer-intent** — gifting/occasion/recipient/synonym/common-misspelling (the current theme-fill's job, `3319-3325`); (iii) **coverage-completeness** — maximize distinct on-niche tokens, prioritize CRITICAL gaps. Each is hardened to forbid category-speak/promo adjectives/colors/sizes and any token in `excludeWords`/`coreWordSet`.
2. **Deliberate (GPT-5 adversary, drop-only veto):** strike every weak candidate against **deterministic evidence** — off-niche (`isOffNicheKeyword`, the same net used at the bullets/scorer seams per *unfixable-dock*), echo (`excludeWords`/`scorerHave`, fold-aware), trademark/3P-brand (`findThirdPartyBrands`/`THIRD_PARTY_BRANDS`/`findTrademarkPhrases`), wrong-audience (`kidsWords` unless in title), opposite-gender standalone, duplicate tokens, junk/foreign-function-words. Never invents terms (same contract as the title coherence gate).
3. **Judge (GPT-5, the ONLY byte-target seam):** assemble survivors **volume-ordered** (`topVolumeBackendPhrases`, `429`), token-dedup (`dedupeTokenSoup`), pack as close to 250 as the *clean* pool allows — with a **soft 220 target, not a hard floor** — running each survivor through the **same deterministic filters as the core** so nothing the core banned slips back (the recurring "gap-closing must mirror the core" bug, `3289-3295`). If the clean survivor pool cannot reach 220, the judge ships the **longest clean string it can** rather than padding. Fail-open to proposer (i)'s survivors.

**`scoreBackend(str, ctx): { green, score, problems, poolExhausted }`** (deterministic, next to `scoreDescription` `~1745`). **GREEN condition (soft floor — the P1 fix):**
> `(bytes ∈ [220,250] AND clean) OR (bytes ∈ [200,220) AND clean AND poolExhausted)`
where **clean** = 0 off-niche (`isOffNicheKeyword`) · 0 title/bullet echo (design tokens exempt) · 0 third-party-brand/trademark · 0 opposite-gender standalone (hard-lean family) · per-color distinct for ≥2-color families (same rule as `backendOutputProblems:594`, keep the #404 single-confident-color exemption) · ≥K top-volume opportunity phrases covered · residual CRITICAL-gap count ≤ target (`scoringCtx.criticalCount`); and **`poolExhausted`** = the on-niche non-echo candidate pool (after adversary veto) provably cannot supply another clean token. **Never pad off-niche to reach 220, and never prefer a padded-or-stale field over a shorter clean one.** A clean 205-byte field is a *pass* — it already scores `≥200 → clean` at `syncListingContent.ts`.

**Self-heal loop** wrapping the council (mirror `3661-3717`): after the judge, run `scoreBackend`; if not GREEN **and not pool-exhausted**, re-prompt the judge with the specific `problems`; keep-best; loop to GREEN or `MAX_ITERS=3`. **Deterministic repair as the final guarantee:** run `banBackendTok` + echo/gender/trademark scrub + `dedupeTokenSoup` + `fillBackendToBudget` (unchanged — see below) on the best candidate so the field is never empty and never garbage.

### Code plan
`src/lib/fba/listingPipeline.ts`
- New **`runBackendCouncil(openai, seedCore, pool, designName, excludeWords, banTok, colorCtx, criticalSet, onProgress)`** — pattern template `runBulletsCouncil` (`2145-2203`) / `runDescriptionCouncil` (`3558-3603`): 3 proposers emitting **ranked candidates+volume** (`Promise.all`, per-call timeout, `maxRetries:0`, `onProgress` keepalives) → GPT-5 adversary (drop-only) → GPT-5 judge (sole byte-packer) → fail-open to proposer (i), logged (`2199-2202`).
- **Replace** the single-shot theme-fill block (`3306-3352`) with `runBackendCouncil`, seeded by the deterministic core+gap-closing (`3184-3305`) — the council **augments** the demand-backed core, never replaces it (coverage never regresses; council outage = today's deterministic output).
- New **`scoreBackend`** (`~1745`) with the soft-floor GREEN condition above + wrap the council in the keep-best self-heal loop.
- **Byte-target / degrade-gate changes (P1/P2 corrections):**
  - **DO NOT edit `fillBackendToBudget:522`.** The draft proposed lowering the `>= 244` early-return to `>= 220`; that is a *stop-early* guard, so lowering it makes the function fill **less** (stop at 220), leaving 220–244 unfilled — the reverse of the intent. Leave line 522 alone; the ≥220 reach comes from the priority pass (`489-519`) + council, not this line.
  - **Do NOT raise `backendOutputProblems:580` from `<190` to `<220` as a throw.** On a genuine dry pool + council quota outage (#352, no banner on backend raw-fetch regens), the council is the only new-term source; `fillBackendToBudget` can only append tokens that already exist in `poolKeywords`/`priorityPhrases`/canonical bigrams. Raising the throw floor to 220 would **preserve stale junk silently** on exactly the thin ASINs this item targets. Instead: **keep `< 190` as the hard garbage floor (throw)**; make **190–220 an advisory quality problem, not a throw** (surfaced, best-deterministic shipped). Keep the per-color differentiation check + the #404 single-confident-color exemption.
  - The theme-fill trigger `< 220` (`3314`) becomes the council entry. Core truncate 233 (`3356`) unchanged (leaves room for the tail). Keep the 250 hard cap everywhere.
- **Coexistence with per-color tail:** each child = `dedupe(core + colorTail)`; target the council core at ~230–244 so core+tail lands **240–250 when the pool allows**; `fillBackendToBudget` (unchanged) tops any child that fell short after tail-dedup. Per-color uniqueness preserved by the tail + the `scoreBackend`/`backendOutputProblems` differentiation check.
- **Fan-out wiring (both write paths, backend-before-bullets):** because the council lives inside `runBackendAgent`, all call sites inherit it — `finishBackendFull` (`~6719`), `finishBackend` (`~6626`), `runBackendPerDesign` (`~6543/6552`), and the ungrouped remainder (`~6571/6577`). Sequence backend generation **before** the bullets loop for each child (D's constraint). Ensure the `#79` backend section-regen in `ai-recommendations/route.ts` routes through `runBackendAgent` so it persists `per_child_keywords` + re-scores before the user pushes.

Scorer levers to codify in `scoreBackend`: `src/lib/sync/syncListingContent.ts:1036-1103`.

### Open questions
1. Inline self-heal (blocking, up to 3 extra LLM passes) vs deferred background top-up? (Inline recommended; each pass is ~300 tokens and backend quality is a ship-gate.)
2. Exact `K` (min top-volume opportunity phrases covered) and the `poolExhausted` predicate's exhaustion threshold — tune against a handful of live thin listings so a genuinely small clean pool passes as *clean-and-short* rather than false-failing.
3. Council proposer model — `gpt-4.1-mini` (matches other councils' fast proposers) vs a stronger proposer for the demand maximizer?

### Effort / risk
**L.** Risks: council keyword-stuffing off-niche/echo terms (mitigated by ranked-candidates-not-strings from proposers + adversary + `scoreBackend` + deterministic repair — the byte target lives only at the judge, removing the padding incentive); gap-closing/repair not mirroring the core filters (the recurring `3289-3295` bug — run every survivor through the core's exact predicates); **degrade-preserve on a dry pool** (the #352/#404 trap — mitigated by the soft-floor GREEN condition + keeping 190–220 advisory-not-throw, so the system ships short-and-clean rather than preserving stale); per-color false-fail (keep the #404 single-confident-color exemption); fan-out cost (N children × up to 3 passes — apparel-gated, keep-best, fail-open).

**Verification gate.** A real regen on a thin ASIN (B0GQXSNQ6R) must produce, for every child, a **clean** backend field: zero off-niche/echo/trademark, per-color distinct, in the ≥200 clean band, ideally 220–250 but **acceptably a clean 200–220 when `poolExhausted`** — and *never* a padded-or-stale field. After a backend push, `keyword_score` reflects the ≥200 (ideally clean) band with the CRITICAL-gap dock reduced — all three surfaces agreeing. Confirm no silent preserve-stale by checking the SSE stream-error event on a forced-outage dry run.

---

## F) A+ content "Scan now" (score tile + A+ module card)

### Problem
A+ status is fetched by exactly one function, `fetchAplusStatus` (`src/lib/sync/syncListingContent.ts:233-279`, module-private), which GETs `searchContentPublishRecords`; `hasAplus = publishRecordList.length > 0`. It writes `has_aplus`/`aplus_module_count`/`aplus_has_brand_story`/`aplus_has_headline`/`aplus_images_missing_alt` (`1541-1547`, `1662-1667`) on a representative **child** with parent fallback. The "A+ 0% · 0/16" tile is a pure function of stored `has_aplus` (`aplusScore` 25→0 + critical issue, `1152/1158-1160`; weight 16, `scoreWeights.ts:15`; rendered `page.tsx:1977`).

**The 0/16 is structurally stale.** `has_aplus` is written only by a full content sync, of which both producers are heavy: bulk `syncListingContent(topN=50)` (`1569`, top-50-by-30d-sales only — a low-traffic parent is never re-touched) and on-demand `syncSingleAsinContent` (`1467`, only via `?pull=`/search-miss, `route.ts:349-364/457`). Nothing on the listing page re-runs either for A+. So A+ created/published in Amazon after the last sync shows 0/16 forever. Confirmed: the only callers of `fetchAplusStatus` are those two syncs.

### Root cause / decision
Two staleness sources must both surface: (1) the cache is never refreshed for low-traffic parents; (2) `searchContentPublishRecords` returns only APPROVED+PUBLISHED records, so A+ **submitted but under Amazon review** reads `hasAplus=false` even on a fresh scan. So "Scan now" must distinguish *not created* from *submitted, pending review*. **Phase 1** ships publish-records-only with a "pending" caveat in copy; **phase 2** adds `getContentDocument.status` (`DRAFT|SUBMITTED|APPROVED|PUBLISHED|REJECTED`) via `searchContentDocuments`/`listContentDocumentAsinRelations` for a true `pending` verdict. `getListingsItem` summaries do not carry A+ — keep A+ its own API. A narrow A+-only self-heal (one call → UPDATE only A+ columns → re-score → refetch) avoids a full `syncSingleAsinContent` that could stomp freshly-pushed-but-not-yet-live copy under the 15min–6hr lag.

### Architecture
Detect → inherit valid value → re-verify → surface (*self-healing-system-directive*), blast radius = A+ columns only.

### Code plan
- **New exported fn in `syncListingContent.ts`** (co-located to reach private `fetchAplusStatus`): `rescanAplusForAsin(supabase, asin): Promise<{ has_aplus; aplus_module_count; aplus_has_brand_story; aplus_status:'live'|'pending'|'none'; aplus_score; overall_score } | null>`. Steps: `getAccessToken` + resolve family via the existing `listing_health` `.or(parent_asin.eq/asin.eq)` query (`1478-1494`, incl. `discoverSkusForAsin` fallback); `fetchAplusStatus(token, firstChildAsin)` with the parent fallback (`1531-1537`); **UPDATE only the A+ columns** on the family's `listing_content`; call the already-exported `ensureListingScored(supabase, parentAsin)` (imported at `route.ts:21`) to recompute `aplus_score`+`overall_score`; return the new numbers.
- **New endpoint** `POST /api/fba/aplus-scan` (or fold into the optimizer route as `?aplusScan=<asin>`, parallel to `?pull=` at `route.ts:349-364`). Body `{ asin }` → the `rescanAplusForAsin` object or `{ scanned:false, reason }`. Behind the `/api/fba` auth gate.
- **UI — score tile.** In `bars` (`page.tsx:1969-1978`, A+ bar `1977`) add "Scan now": POST + spinner ("Re-checking Amazon for A+…") → `refreshScore()` (`904-912`) so tile, ring (`2045`), and child table (`3624`) re-read `score`. Toast: "A+ found — N modules (X/16)" / "Submitted, pending Amazon review" / "Still no A+ detected."
- **UI — APLUS MODULES card.** Renders from `item.aplus_modules` (`page.tsx:3272-3288`; type `AplusModuleAction`, `ai-recommendations/route.ts:163-179`). Add the same "Scan now" in the header → same `refreshScore()`. On a `has_aplus` flip, chain into `generateAiRecs()` (`page.tsx:1116`) so the card self-updates CREATE→EDIT without a second click (*don't-gate*).

### Open questions
1. Ship phase-1 (publish-records only, "pending" as caveat) now, or wait for phase-2 real `pending`? (Recommend phase-1 now.)
2. Auto-chain the AI-recs regenerate on a `has_aplus` flip (recommended per don't-gate) or a second explicit click?

### Effort / risk
**M** for `rescanAplusForAsin` + endpoint (one API call, narrow UPDATE, reuse of `ensureListingScored`/`refreshScore` — low risk, A+ columns only); **S** for the two UI surfaces; phase-2 `getContentDocument` pending-detection is additive/deferrable.

---

## G) The A+ "Create" link is broken

### Problem
There is **no clickable CREATE link on the aplus_modules card**. "CREATE" renders only as an inert badge — `<span className="…text-slate-400">{item.verdict}</span>` (`page.tsx:3058`), no `href`/`onClick`. The card flows through the generic Edit-Once map (`3027`); `seller_central_path` is an unclickable `<p>` (`3087-3092`); module briefs (`3273-3288`) are inert `<div>`s; and the Ship button returns `null` for anything not title/description/bullets:
```
const shipField: PushField | null =
    item.element === 'title' ? 'title'
  : item.element === 'description' ? 'description'
  : /^bullet/.test(item.element) ? 'bullets'
  : null
if (!shipField || item.verdict === 'SKIP') return null   // page.tsx:3230-3238
```
The only working A+ anchor is the header button (`2057-2061`) pointing at the **edit** endpoint `…/enhanced-content/edit?asin=${asin}` — which for a no-A+ listing lands on an empty "nothing to edit" state (reads as broken) and is detached from the CREATE card. The codebase already uses the correct create destination elsewhere — `src/app/fba/page.tsx:3475` and `syncListingContent.ts:1160,1168` all use `…/enhanced-content/content-manager`.

### Root cause / decision
The CREATE verdict is a `<span>`, never an `<a>`; the natural link home (`seller_central_path`) is a dead `<p>`; the Ship button returns `null` for `aplus_modules`. A+ creation is **not push-automatable** here (`auto_fixable:false`, `syncListingContent.ts:1160/1168`; the A+ Content API is not wired for writes), so CREATE must be a **hand-off deep link** into A+ Content Manager carrying the module brief — not an API push. Use `/enhanced-content/content-manager` (create/list surface), not `/enhanced-content/edit?asin=` (edit-existing), so all A+ links agree on one destination.

### Architecture
One destination for all A+ links (coherence). Real `<a>` CTA on the CREATE card body; header link branches on `has_aplus`; optional "copy module brief" for the hand-off. Same treatment for the `brand_story` CREATE card (server sets it identically, `listingPipeline.ts:6823-6828`).

### Code plan
`src/app/fba/listing/[asin]/page.tsx`
- **Primary — real link on the card.** In the aplus_modules body (Row 4 `3087-3092`, or a CTA above the module list `3273`), when `item.element === 'aplus_modules' && item.verdict !== 'SKIP'` (and `brand_story` CREATE too), render `<a href="https://sellercentral.amazon.com/enhanced-content/content-manager" target="_blank" rel="noopener noreferrer">Create A+ in Content Manager →</a>` styled as a blue button (`Icon.External`). Match `fba/page.tsx:3475`.
- **Secondary — header link.** At `2057`, branch on `score.has_aplus` (interface `page.tsx:27-34`): `edit?asin=${asin}` when true, `content-manager` when false; label "Edit A+ Content" vs "Create A+ Content".
- **Optional — copy brief.** "Copy module brief" next to the CREATE link copying `item.aplus_modules[]` (position/module_type/content_brief), mirroring the copy pattern at `3199-3209`.

### Open questions (verify live per *shipping-from-fact*)
1. Does `…/enhanced-content/content-manager` open the create wizard (or the list where "Create" is one click) for an authenticated session?
2. Does `/enhanced-content/edit?asin=<asin>` honor the ASIN param? If not, use `content-manager` in **both** header branches.

### Effort / risk
**S.** Only real risk is the deep-link destinations themselves — both URLs must be validated in a live Seller Central session before calling this fixed (a wrong endpoint is exactly the reported "link doesn't work" symptom).

---

## H) Multi-design regression — reference inputs ignored + niche-starved generation

> Live case: **B0DMXMH266** (multi-design fishing-humor apparel family). PO supplied two niche signals in the optimizer UI — competitor reference ASIN **B08T4JB5D1** and Design Name **"Funny Fishing Humor Tee Shirts"** — and the system used **neither** as *grounding*. Output: generic parent title *"THE CEO Funny Fishing Graphic T-Shirt for Men"*, **0 fishing keywords** on the Intelligence tab, and mis-sized/word-salad per-design titles (*"THE CEO A Day Without Fishing T-Shirt, Funny Graphic Tee, Vintage for Men"*).

### Problem

Two fields exist precisely to inject a niche the seller's own thin content can't supply — the **Competitor Reference ASIN** and the **Design Name** — and both are dead or near-dead as *grounding* inputs. The symptoms present as four separate bugs, but they are one failure surfacing four ways:

| Sub | Symptom | Immediate cause | Anchor |
|---|---|---|---|
| **H1** | Competitor ASIN never influences anything | Read then dropped; the one consumer that would ingest it (`reverseAsinLookup`) has **zero callers**; the auto-competitor module (`findBestCompetitor`) is dead + stubbed | `ai-recommendations/route.ts:489,492`; `syncKeywordIntelligence.ts:51,74-81,184-189`; `jungleScoutClient.ts:188`; `competitorFinder.ts:45,~150` |
| **H2** | Design Name doesn't ground the parent title | Scalar `design_name_override` honored only for **single**-design; multi-design **force-blanks** the family name (`effectiveDesignName=''`); `buildNicheParentTitle` receives the design names **only as an exclusion constraint**, never as niche grounding | `listingPipeline.ts:5598,5866,5922,4827,4841,4846` |
| **H3** | Intelligence tab shows 0 fishing keywords | Keyword universe is seeded once from an auto-derived seed off the seller's thin identity, then frozen (empty-only auto-sync, seed-pool reuse, 14-day TTL); neither PO signal seeds or force-refreshes it | `keywordResearcher.ts:78,143,671-740`; `route.ts:480,494`; `syncKeywordIntelligence.ts:84-96` |
| **H4** | Per-design titles wrong length/format | The design-grounded fill source (`nicheSeeds`, assigned only at `:5671` inside the `!isMultiDesign` gate) and the formatting audit are **disabled for multi-design**; the LLM then fills its 68–75 char *budget instruction* from a niche-empty pool with generic adjectives | `listingPipeline.ts:5645,5671,5962,2383-2384,4606-4804` |

### Root cause / decision — the one abstraction

**The two user-supplied reference signals are never threaded into the keyword universe, so the whole family generates the niche with no niche in the pool.** Every downstream surface (Intelligence tab, parent title, per-design titles, and — by extension — the **E** backend council and the **D** bullets loop) reads from `keyword_analysis`; when that universe is seeded only from the seller's own thin title/vision and both niche-injection channels are off, "fishing" survives only as a literal title token, never as ranked keyword opportunities. H1–H4 are not four patches; they are one **missing wire plus one disabled channel**, both traceable to a single absent abstraction.

**Decision: make the competitor ASIN and the design name first-class `ReferenceGrounding` that flows into the keyword universe *before the relevance/niche gates run*, and from there into every council brief and the per-design fan-out — mediated by explicit niche detection.** One small carrier threaded end-to-end:

```
ReferenceGrounding = {
  competitorAsin?:  string          // PO-entered, or findBestCompetitor result
  designName?:      string          // scalar design_name_override (verbatim → title anchor)
  nicheTokens:      string[]        // derived: expandDesignNiche(designName) ∪ reverseAsinLookup(competitorAsin) terms, AFTER isOffNicheKeyword
}
```

It enters at exactly **two seams** and nowhere else (no new parallel lists — same discipline as **B** and the coherence skill):

1. **Keyword-universe seed + harvest (primary — fixes H3, which unblocks H2/H4/E).** In `researchKeywords`/`selectSeeds`, the competitor's ranked terms (via `reverseAsinLookup`) and the **niche-extracted** design name merge into the research pool **before** `keywordIsRelevant`/`isOffNicheKeyword`/`classifyOffNicheKeywords` run — so fishing terms land in `keyword_analysis`, surface on the Intelligence tab, feed `topUpgradeKws`/`candidates`, and populate the **E** council's opportunity pool. Every ingested competitor term passes the same `isOffNicheKeyword`/`classifyOffNicheKeywords` nets already imported at `syncKeywordIntelligence.ts:34-35,315-317`, so a competitor's off-niche terms can't contaminate the CRITICAL set (guards open task **#72**). **Critical: seed the *niche extraction* of the design name, not the verbatim slogan** (see below).

2. **Design-name grounding of titles (secondary — fixes H2, hardens H4).** The scalar `design_name_override` becomes a **grounded family-niche anchor** for `buildNicheParentTitle`, and `nicheSeeds` is computed **per group** inside the multi-design fan-out instead of being disabled wholesale.

This is deliberately the **E**-shaped pattern: **E** already routes the opportunity pool → propose/deliberate/judge for backend. H feeds the *upstream* of that same pool. Once the universe carries the niche, **E**'s council, **D**'s bullets haystack, and the title path all inherit it with no per-surface patch — cohesion by construction. **The single exception (the one true bolt-on) is the parent-title deterministic backstop (P3), which must be framed as a fail-open last resort, not a routine welder** — see Architecture.

### Architecture

`ReferenceGrounding` is resolved **once** at the top of the recs/audit run (in `ai-recommendations/route.ts`, alongside the existing `competitor_asin`/`design_name_override` reads) and threaded down, riding the existing rails:

```
UI (competitor ASIN + Design Name)
      │  persist (already works)
      ▼
listing_seo_scores.competitor_asin / .design_name_override
      │  route resolves ReferenceGrounding; forces a re-seed when either signal changed
      ▼
syncKeywordIntelligence → researchKeywords/selectSeeds
      │  reverseAsinLookup(competitorAsin) rows  +  expandDesignNiche(designName) mandated seed
      │  → merged into pool BEFORE relevance/niche gates
      │  → research-THEN-replace (never delete-then-fetch; see P2)
      ▼
keyword_analysis (now carries fishing)  ── Intelligence tab (H3 fixed)
      ▼
buildKeywordContext → analysis/topUpgradeKws/candidates
      ├──► E backend council (opportunity pool now on-niche)
      ├──► title path: buildNicheParentTitle (+ familyNiche anchor, fail-open backstop, H2)
      │                 buildTitleFor per group (pool now has fishing, H4)
      └──► per-group nicheSeeds via expandDesignNiche (H4)
      ▼
per-design fan-out — backend BEFORE bullets (guardrail 2), both write paths
```

**Niche detection** is the pivot: `designName` (or the top competitor terms) yields a niche token set via the existing `expandDesignNiche` (`listingPipeline.ts:5649`); the parent-title backstop and the per-group `nicheSeeds` both draw from it, so grounding is deterministic even on a total council/LLM miss (fail-open per the *self-healing-system* directive — degrade to grounded-deterministic, never to generic).

**Seed the niche, not the slogan (fold of P1 — CRITICAL).** The draft's "mandate the verbatim design name as a seed" is a trap. The Phase 2c note in `keywordResearcher.ts` (~`:180`) already documents that a too-specific slogan seed has **no search-volume data → empty pool**. Forcing *"A Day Without Fishing"* past `validateSeeds` (`:724`) can *replace* a working agent seed (`"funny fishing shirt"`) and return a **thinner** pool than today. Route the mandated seed through `expandDesignNiche` (design name → niche noun `"fishing shirt"`); keep the verbatim name for the *title anchor* only.

**Add a mandated seed — don't reuse the `manualSeed` slot (fold of P5 — MEDIUM).** `selectSeeds` already has a mandated-seed mechanism: the `manualSeed` fast-path (~`:681`) returns a single scrubbed seed with `source:'manual'`. But Phase 2b multi-universe expansion (`:167`) fires **only for `source==='agent'`** ("Only the 'agent' source ever yields >1 seed"). Routing the design-niche through `manualSeed` would **collapse the universe to one seed** and kill the ∪-of-niches breadth. Instead, add the niche-extracted design seed as an **additional** mandated seed *alongside* the agent seeds, preserving Phase 2b.

**Parent-title backstop is fail-open only, and must clear the same gates (fold of P3 — HIGH).** `buildNicheParentTitle` deliberately has **"NO design-name backstop (intentional)"** (~`:4863`) and runs trademark discipline. A naive "weld the niche token in if the council missed it" is a post-council **output-string mutation** that bypasses `scrubTrademarks`, `isOffNicheKeyword`, and `TITLE_COHERENCE_GATE` — a design name like "Bluey Fishing Tee" would inject a trademark straight into the parent. The welded token **must pass `scrubTrademarks` + `isOffNicheKeyword` and be sequenced *before* the coherence gate**, and it fires only as a last resort after the pool-grounded path (H3) misses. This is in acknowledged tension with the **#401** lesson the plan cites ("fix at the input, never output-string cleanup"), so the primary fix stays the pool seed; the backstop is the degrade hedge, gated on the niche actually being absent.

**The one false promise to retire (fold of P8 — LOW).** Only the UI subtitle *"Used for Jungle Scout lookup when your ASIN has no data"* (`page.tsx:2185`) is a rendered, user-facing false promise — the lookup has zero callers. The `page.tsx:2188-2191` block the draft also flagged is a **dev code comment**, not a tooltip, and is **accurate for single-design** (verbatim honored via `extractDesignName` at `:4088-4089`). Drop it from the claim.

### Code plan (file-by-file, verified anchors)

`src/lib/sync/jungleScoutClient.ts`
- `reverseAsinLookup(...)` exists at **`:188`** (verified — real function under `lib/sync/`, not `lib/keyword-engine/`; a `.bak` copy sits at `jungleScoutClient.ts.bak:146`). It is the competitor→keyword ingestion primitive and has **zero callers**. No change to the function; wire a caller (below). Confirm its return shape merges cleanly into the researcher's pool row type.

`src/lib/keyword-engine/keywordResearcher.ts`
- Add a real `competitorAsin?: string` to the `researchKeywords` options (`:93-108`) and thread it into `selectSeeds` (`:671-740`).
- Promote the **niche-extracted** design override from advisory (`overrideLine`, ~`:706`) to a **mandated additional seed** that survives `validateSeeds` (`:724`) — added alongside the agent seeds so Phase 2b multi-universe expansion (`:167`) still fires. Never route it through the single-seed `manualSeed` fast-path (~`:681`). Never mandate the verbatim slogan (P1).
- New step in `researchKeywords`: when `competitorAsin` present, `reverseAsinLookup(competitorAsin)` → merge rows into the research pool **before** the relevance/niche gates. This is the only place the competitor's ranking terms can enter the universe.
- Guard the freeze for this path: a newly-supplied competitor/design must bypass `getSeedPool` reuse (`:143`) / `RESEARCH_TTL_DAYS` (`:78`) when the grounding signal changed (see route re-seed below).

`src/lib/sync/syncKeywordIntelligence.ts`
- **Destructure and use `competitorAsin`** — today declared (`:51`, "legacy — now auto-detected via SOV") but **not destructured** at `:74-81` and omitted from the `researchKeywords` call (`:184-189`), so it's a no-op even when passed. Thread it through. Keep SOV auto-detect as a fallback when the PO left the field blank.
- **Research-then-replace, not delete-then-fetch (fold of P2 — CRITICAL).** The current re-seed deletes `keyword_analysis` first (`:93-95`) then researches. If the competitor fetch or research quota-outs or returns empty (the *ai-quota-outage-looks-like-success* / #352 failure mode), the universe is left **empty and persists**, and E dutifully builds a fishing-less backend on top of it. Change the force-refresh path to compute the fresh analysis first and **only overwrite when the fresh set is non-empty** — never let a re-seed blank a populated universe. This is a code change to the re-seed path itself, not just an instruction.
- Keep `isOffNicheKeyword`/`classifyOffNicheKeywords` (`:34-35`, `:315-317`) on the **merged** pool so competitor off-niche terms are filtered exactly like organic ones (coherence guardrail 1 / #72). Verify the `reverseAsinLookup` rows land in the pool consumed by `:315`, not a side-channel write.

`src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`
- `:483-497` — the local `competitorAsin` is read at **`:489`** then **dropped** (absent from the options at `:492-497`). Pass it: `syncKeywordIntelligence(syncAsin, { …, competitorAsin, designName: design_name_override })`.
- **Fix the empty-only sync gate.** The sync block is `if (!existingKws || existingKws.length === 0)` with `forceRefresh:false` (`:480,494`) — so once *any* (fishing-less) rows exist, entering a competitor/design can **never** re-seed. Add: when the resolved `ReferenceGrounding` changed since the last sync (compare a stored fingerprint), run with `forceRefresh:true` — routed through the research-then-replace path above so a quota-out can't blank the universe. This is the "once-and-frozen" unlock; without it H1/H2 wiring is inert on any listing with stale rows.
- Resolve `ReferenceGrounding` once here (already reads `competitor_asin` at `:485`, `design_name_override` for the pipeline at `:687`) and pass `designName` into the title path.

`src/app/api/fba/design-name-override/route.ts` and `src/app/api/fba/competitor-asin/route.ts`
- The scalar design-name POST (`design-name-override/route.ts:89-92`) writes the column but triggers **no refresh** and does a silent 0-row `.update().eq('parent_asin', …)`; same at `competitor-asin/route.ts:48-52`. Make the write **upsert** (create-the-row) and fire the re-seed fingerprint. **But (fold of P6 — MEDIUM): this upsert is hardening, not the root cause for B0DMXMH266.** The observed output (a *generated* parent title, a *read* design name) strongly implies a `listing_seo_scores` row already exists for this ASIN — the live cause here is the **missing refresh trigger + the dead competitor wire**, not the 0-row silent update. Don't let the upsert fix masquerade as the root; verify the row's existence against live DB before attributing.

`src/lib/fba/listingPipeline.ts` — title path (relates directly to **E** and the title path)
- **`buildNicheParentTitle` already takes design names (fold of P4 — HIGH).** Its signature at **`:4827`** includes `designNames: string[]` (call site passes `allDesignNames` at `:5922`, built ~`:5912-5914`), consumed as a **negative/exclusion** constraint (`:4841,4846` — "DO NOT name these"). The draft's "takes no design/niche input" is wrong; the *conclusion* (niche is pool-hostage) stands. Add a **separate `familyNiche` parameter** (from `design_name_override` → niche token) — do not overload the existing exclusion arg — and recognize this **reverses the documented "NO design-name backstop (intentional)"** decision (~`:4863`), raising the review bar. The audience-dedup comment (~`:4900`) is evidence this exact title path is already inside the patch-loop the PO is complaining about — one more reason to fix at the root, not add a fifth patch.
- The deterministic backstop mirrors `runTitleAgent`'s `designLine` (`:2346-2347`) but **must pass `scrubTrademarks` + `isOffNicheKeyword` and sequence before the coherence gate** (P3), and fires **only** when the pool-grounded niche is absent — fail-open last resort, not routine.
- **`effectiveDesignName=''` (`:5598`)** force-blanks the family name for multi-design to dodge a bullet-cohesion dock. Do **not** rip this out (it prevents a real false-negative dock — *don't-overgeneralize*); **separate the niche channel from the cohesion channel**: keep `effectiveDesignName=''` feeding the bullet-cohesion scorer, but pass the un-blanked `design_name_override` niche token to `buildNicheParentTitle` and to the per-group `nicheSeeds`.
- **`nicheSeeds` is assigned at exactly one place — `:5671`, inside the `!isMultiDesign` gate (`:5645`).** Move `expandDesignNiche` (`:5649`) **inside** `resolveGroupDesignName` (`:5823-5877`) so each group computes its **own** `nicheSeeds` from its own resolved design name — the natural per-group seam — instead of the all-or-nothing family gate. This feeds the council `nicheLine` (`:2384`), `groundVocab` (`:2260`), and the 6b harvest (`:4790`), so per-design titles seat real fishing phrases into the 68–75 char budget instead of `Vintage`.
- **Per-design override chain (`:5866`)** reads only the per-**key** map (`designNameOverridesByKey`); the scalar the PO typed is absent. Fold the scalar `design_name_override` in as a family-level fallback so a single typed family name anchors each group when no per-key override exists.
- **No deterministic 73-char floor exists (fold of P7 — LOW).** The `"…Tee, Vintage for Men"` word-salad is the LLM filling its 68–75 char *budget instruction* (`nicheLine`/title brief, `:2384`) from an **empty niche pool** with generic adjectives — not a deterministic pad. The causal story is "LLM budget-filling on a starved pool," and it self-resolves once H3 seeds the pool. `runFinalEditorialAudit` is gated off at `:5962`; enabling a per-group formatting pass is a lower-priority hedge for residual thin groups, not the fix.

`src/lib/keyword-engine/competitorFinder.ts`
- `findBestCompetitor` (`:45`, "manual competitor always wins") is dead (zero callers) and its auto-search is a stub (`return null` ~`:150`). **Decision:** for v1 wire the **manual** path only — `reverseAsinLookup(competitor_asin)` in the researcher — and leave the auto-search stub unwired (do not ship a stub that returns `null` as if it worked). Delete `findBestCompetitor`'s auto-search or mark it explicitly deferred.

`src/app/fba/listing/[asin]/page.tsx`
- After the wiring lands, the subtitle (`:2185`) becomes accurate. Optionally surface a "re-researching with your competitor/design" affordance when the re-seed fires (mirrors the Intelligence "Re-research" at `intelligence/[asin]/route.ts:373-383`). No change to the `:2188-2191` dev comment (P8).

### Relation to E and the title path (cohesion, not a bolt-on)

- **E consumes what H produces.** E's backend council brief inputs (remaining opportunity pool with volumes, the live CRITICAL set) come from `keyword_analysis`. H is the reason that pool contains fishing terms at all. Sequence: **H's universe seed → E's council → D's bullets haystack** — H sits *upstream* of guardrail 2's backend-before-bullets chain. If H doesn't land, E dutifully builds a clean, on-budget backend field **with no fishing in it**. H is a precondition for E delivering the *right* keywords, not just 220–250 clean bytes.
- **The title path inherits H twice.** The parent title gets a `familyNiche` anchor (fail-open backstop) *and* a richer `topUpgradeKws` pool; per-design titles get per-group `nicheSeeds` *and* an on-niche `candidates` pool. The **#401** fact holds: fixes land at `runTitleAgent`/`buildNicheParentTitle` **inputs** (the pool + the anchor), **not** as output-string cleanup in `buildTitleFor` — the one exception, the P3 backstop, is explicitly a gated fail-open degrade, not a general output patch.

### Open questions

1. **Re-seed trigger granularity.** Fingerprint on `(competitor_asin, design_name_override)` change is clean, but a competitor ASIN's own ranking keywords drift over time. Recommend signal-change fingerprint for v1; competitor-drift TTL deferred.
2. **`reverseAsinLookup` data source/quota.** Confirm the Jungle Scout reverse-ASIN endpoint is live and quota'd — per *ai-quota-outage-looks-like-success*, a quota-out must **fail-open to organic seeds** and, via the research-then-replace fix, must **never** overwrite a populated universe with empty. Instrument with `errorClass` and surface via the SSE stream-error event.
3. **Mandated design seed safety.** The seed is the niche extraction (P1), gated through `isOffNicheKeyword` + a minimum-plausibility check before it can force a term into CRITICAL — this also covers a garbage/typo family name.
4. **Scalar vs per-key design name.** Recommend keeping one family-scoped "Design Name" field (grounds parent + all groups as fallback per H2's chain fix) — no new UI.
5. **`findBestCompetitor`:** recommend deleting the auto-search stub; keep only the manual reverse-lookup wire.

### Effort / risk

**L.** Widest-blast-radius item after **E** — it touches the keyword researcher, the intelligence sync, the recs route, two persistence routes, and the title/fan-out region of `listingPipeline.ts` — but each edit is a **wire or a gate-relaxation**, not a new subsystem (`reverseAsinLookup`, `expandDesignNiche`, the deterministic niche nets already exist).

Risks:
- **Empty-universe persist on re-seed** (#352 class) — the draft's own delete-then-fetch mechanism triggers it; mitigated by **research-then-replace** (overwrite only on non-empty fresh set).
- **Slogan seed starves the pool** (P1) — mitigated by seeding `expandDesignNiche(designName)`, never the verbatim name.
- **Universe collapse to one seed** (P5) — mitigated by adding the mandated seed alongside the agent seeds, never via the `manualSeed` single-seed fast-path (preserves Phase 2b).
- **Off-niche contamination from the competitor** (#72 class) — mitigated by running every ingested competitor term through `isOffNicheKeyword`/`classifyOffNicheKeywords` on the merged pool *before* the CRITICAL set is built.
- **Trademark/coherence bypass via the parent backstop** (P3) — mitigated by passing the welded token through `scrubTrademarks` + `isOffNicheKeyword` before the coherence gate, fail-open only.
- **Re-seed thrash** — gate strictly on signal-change fingerprint; reuse the 14-day cache otherwise.
- **Regressing the intentional `effectiveDesignName=''` cohesion guard** — mitigated by separating the niche channel from the cohesion channel (add a parallel anchor, don't remove the blank).

**Highest-leverage sequencing.** Land **research-then-replace (P2) + signal-change force-refresh (H3) + niche-extracted mandated seed (P1)** first — that is the actual single root and it self-heals E/D/titles. Treat P3's parent backstop and H4's editorial-audit enable as gated fail-open hedges, added only after verifying (per *shipping-from-fact*) that the live pool carries fishing terms and the competitor fetch **fired** (inspect the reverse-lookup call in logs — a dead read is UI-indistinguishable from a live one).

**Verification gate.** A real regen on **B0DMXMH266** after entering competitor **B08T4JB5D1** and Design Name **"Funny Fishing Humor Tee Shirts"** must show: (a) the Intelligence tab carrying multiple fishing keyword opportunities (H3); (b) a parent title anchored on the fishing niche — from the pool, with the deterministic backstop only if the council misses (H2); (c) per-design titles seating real fishing phrases at correct length instead of `Vintage`-padded word-salad (H4); and (d) **E**'s backend field carrying on-niche fishing terms — all four surfaces agreeing on a live ASIN. Confirm the competitor fetch actually fired (reverse-lookup call in logs) and that the re-seed did **not** blank a populated universe (research-then-replace held) — the quota-out degrade path must be confirmed via the SSE stream-error event, not a green-looking empty.

### Roadmap placement

H is a **precondition upstream of E**, not a sibling patch: E's council consumes the `keyword_analysis` pool that H seeds. Land H as **PR-2**, immediately after PR-1 (A) and **before** E — E cannot be signed off until H feeds it a niche-bearing pool (E on an empty pool produces a clean, on-budget backend field with no fishing in it, which *looks* shipped). H's Seam 1 (research-then-replace + signal-change re-seed + niche-extracted mandated seed + competitor harvest) is the hard blocker for E's acceptance gate; Seam 2 (parent-title anchor + per-group `nicheSeeds`) rides in the same PR or immediately behind it, honoring the #401 input-not-output discipline.

---

## Cross-cutting guardrails (every item must honor)

*(From the always-on `fba-optimizer-coherence` / ship-truth model — `pushFields.ts:228-238`.)*

1. **One coverage predicate.** No item may re-introduce a keyword into bullets/title as a coverage backstop; opportunity keywords live in `generic_keyword`/backend. **D's** bullet loop targets only genuinely-uncovered *bullet-appropriate* residual terms (haystack includes backend); **E's** council owns the backend coverage surface. Neither forks the tokenizer — both reuse the scorer's `isCovered`/`missingVerdict` helpers.
2. **Backend-before-bullets ordering (hard constraint).** In the per-design fan-out, E's backend council **finalizes before** D's bullets loop reads the `[title, ...bullets, backend]` haystack for that child; the `#79` bullets-only regen reads the **live persisted** backend. Without this, D's haystack gate is insufficient and re-breaks #39.
3. **Ship-truth is derived, not stamped.** Cards/cohesion/score derive from live-vs-`resolveProposed` via `deriveActionPlan` (`pushFields.ts:293`). Every accepted push (C, and any regen path in D/E) **must** `cacheUpdateFor` per (field,SKU) so cards flip DONE — omitting any accepted field = "shipped but still red" (#358).
4. **Per-child multi-design bytes are the truth.** D's bullet loop and E's council run **inside the per-design fan-out** on the bytes that actually PATCH (`per_child_bullets`/`per_child_keywords`), mirrored into **both** write paths (full upsert + `#79` section-regen). Broadcasting `recommended_*` poisons variants (Invariant 5).
5. **Spec-grounding over search/LLM.** B's new fabric/material/care/fit ground to authoritative `BLANK_SPECS`, never LLM guesses; unknown blanks stay advisory.
6. **Self-heal, don't gate — prefer clean-and-short over padded-or-stale.** D (bullets→85) and E (backend→GREEN) detect→regenerate→re-verify→keep-best in-system; F re-checks A+ and re-scores. Every metric-gated loop is **fail-open** — degrade to the last-good deterministic output, never to empty (the #352 empty-persist lesson). E's GREEN condition explicitly ships a **clean sub-220 field on a provably-exhausted pool** rather than padding off-niche or preserving stale (#352/#404). Back every LLM invariant with a **deterministic per-field net** (editorial-audit-prompt-leaks).
7. **Don't over-generalize a specific failure.** D scopes the fix to the missing self-heal loop; it does **not** rip out the already-reformed bullet coverage dock (`syncListingContent.ts:916-937`). E does **not** raise the `backendOutputProblems` throw floor to 220 (keeps 190 hard-fail; 190–220 advisory) and does **not** edit `fillBackendToBudget:522` (that edit is counterproductive) — because 220 is *not* deterministically reachable on a dry pool.
8. **Outcome-epoch semantics.** C stamps the epoch on full-accept (`pushExecutor.ts:3251`); attribute-only pushes (details_bulk) do not (`3475-3477`). Core copy = **stamp**.
9. **UPDATE-ONLY / enum validity.** C and B drop the non-buyable parent and gate offerless/not-live SKUs (phantom-listing prevention); B's new detail values must pass the validate-at-regen coercion (`route.ts:857-923`) → enum-invalid becomes a seller-picker, never auto-push.

---

## Sequenced roadmap

| PR | Item(s) | Depends on | Rationale |
|---|---|---|---|
| **PR-1** | **A** (ModalShell) | — | Small, pure-UI, zero data-path risk; builds `ModalShell` that C reuses. Fastest PO-visible win. |
| **PR-2** | **H** (reference grounding + universe re-seed) | — | The regression fix and the upstream seed of everything: research-then-replace + signal-change force-refresh + niche-extracted mandated seed + competitor harvest. **Hard-blocks E's acceptance.** Seam 2 (title anchor + per-group `nicheSeeds`) rides here or immediately behind. |
| **PR-3** | **E** (backend council + `scoreBackend`) | PR-2 (niche-bearing pool) | The council can only judge "on-niche" against a pool that carries the niche; verifying E before H produces a clean fishing-less field that looks shipped. |
| **PR-4** | **D** (bullets score-to-85 + self-heal) | PR-3 (backend-before-bullets ordering) | Delivers the PO standard on bullets; `scoreBullets` + enforced keep-best loop. Template = `runDescriptionAgent`. |
| **PR-5** | **F + G** (A+ surface: Scan now + Create link) | — | Independent of push/scoring; natural pair, same files/region. Can proceed in parallel with anything. |
| **PR-6** | **C** (core bulk PATCH) | PR-1 (`ModalShell`) | Highest-leverage push feature; the two sharp edges (mixed body, epoch stamp) want a focused PR + `buildCoreOps` unit test + adversarial review. |
| **PR-7** | **B** (attribute expansion) | live-schema debug pass; watch #26 | Needs schema verification + BLANK_SPECS truth-gate reviewed independently; collides most with in-flight #26 (sleeve). Last among push-side items. |

**Ordering guidance.** Land **PR-1** fast (unblocks C, PO-visible). **PR-2 (H) before PR-3 (E) before PR-4 (D)** is a hard chain: H seeds the universe → E's council consumes it → D's bullets haystack reads E's finalized backend (guardrail 2). **PR-5** (F/G) floats freely. **PR-6** (C) after PR-1. **PR-7** (B) last. D and E must **not** share a PR (overlapping `listingPipeline.ts` regions, each needs its own live verification); H and E should share reviewers.

**Coordination.** A, C, D, E, F, G, H all touch high-churn files — `page.tsx` (~4941 lines), `pushExecutor.ts`, `listingPipeline.ts`, and now `keywordResearcher.ts`/`syncKeywordIntelligence.ts` — with active work (**#23** details stream-drop, **#26** sleeve writes). Land PR-1 fast, rebase the rest on it, keep edits out of the bulk-push and sleeve regions until #23/#26 settle. Every metric-gated loop (D, E), every push path (C), and the H re-seed must be verified on a **real live ASIN** (B0FRYMM56C for D; B0GQXSNQ6R for E/F/G; **B0DMXMH266 with competitor B08T4JB5D1 + "Funny Fishing Humor Tee Shirts" for H**) — not just `tsc` — with all coherence surfaces agreeing, and every degrade path confirmed via the SSE stream-error event, not a green-looking empty.
