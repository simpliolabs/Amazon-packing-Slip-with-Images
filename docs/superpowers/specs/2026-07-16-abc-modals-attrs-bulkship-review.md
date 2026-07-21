All findings are grounded in the actual code. I have verified: the five hand-rolled modal backdrops (4078/4118/4206/4296/4421) with their `onClick` close + tiny `×`/`&times;` X buttons; the route dispatch at 191-195 (details_bulk vs executePush, no core_bulk); `resolveProposed` per-SKU/per_child logic (pushFields.ts:132); the outcome-epoch stamp gate in the single-core path (pushExecutor.ts:3250, which details_bulk deliberately omits at 3476); the menu-curation regexes and PER_VARIANT/ALWAYS-INCLUDE seams (productTypeDefinitions.ts:348-407); and the ATTR_MAP (productDetailAttrs.ts:68-120, confirming `style` present but per-variant-excluded in the menu). Writing the review doc.

# FBA Listing Optimizer — Review & Build Plan: A) Dismiss-only modals · B) More pushable clothing attributes · C) "Ship all" core bulk PATCH

> Status: **PLAN ONLY — no code written.** For PO approval before any implementation. All anchors verified against the live tree at `C:/Users/Admin/AppData/Local/Temp/fba-portal`.

---

## A) Modals should close only via a (more prominent) X

### Current state
Every dialog on the listing page is **hand-rolled** — there is no shared `<Modal>` component. Each is an outer backdrop `<div class="fixed inset-0 ... bg-black/40" onClick={close}>` wrapping an inner card with `onClick={(e)=>e.stopPropagation()}`, so any backdrop/outside click closes it. Confirmed instances in `C:/Users/Admin/AppData/Local/Temp/fba-portal/src/app/fba/listing/[asin]/page.tsx`:

| Modal | Backdrop close (`onClick`) | X button |
|---|---|---|
| Takeover ("Take over this listing?") | `page.tsx:4078` → `!claimBusy && setTakeoverOpen(false)` | `4083`, `&times;`, `text-slate-400 ... text-lg` |
| Fix-capacity | `page.tsx:4118` → `!fixCapLoading && setFixCapTarget(null)` | `4122`, `&times;`, same tiny style |
| Relink | `page.tsx:4206` → `!relinkLoading && setRelinkTarget(null)` | (same pattern) |
| Auto-Push / bulk-details | `page.tsx:4296` → `setBulkOpen(false)` | `4300`, `×`, `text-slate-400 ... text-lg` |
| Core Ship / push-preview | `page.tsx:4421` → `setShowPushModal(false)` | `4433-4437`, `&times;`, `text-lg ... text-slate-400` |

Verified details worth preserving:
- The push/bulk modals are **intentionally closeable during a running stream** — the fetch lives in page JS, not the modal, and a floating progress pill (`page.tsx:4407`) reopens it. Titles literally say *"Safe to close — the push keeps running in this tab"* (`4300`, `4435`).
- Three modals guard the close behind an in-flight flag (`!claimBusy`, `!fixCapLoading`, `!relinkLoading`).
- `page.tsx:1990` is a **loading/lock overlay** (`blockedByOther`), not a dismissable modal — no `onClick`, no X. **Leave it alone.**
- No Escape handler and no focus trap exists anywhere.

### Recommendation
Make dismissal **explicit-only**: remove the backdrop `onClick` close on the five modals (keep the inner `stopPropagation`), and promote the X to a real button (≈32px, `rounded-full`, `bg-slate-100 hover:bg-slate-200`, `aria-label="Close"`). Add **Escape → close** per modal so keyboard dismissal survives (recommended once backdrop-click is gone — but see Open questions; PO may want strictly X-only).

**Best option: extract one tiny shared shell** `src/components/fba/ModalShell.tsx` and migrate all five, rather than editing five divergent call-sites. This is the durable fix — it stops the next hand-rolled dialog from re-introducing backdrop-close. If churn risk (see below) is a concern for this PR, the fallback is five surgical edits with identical semantics.

### Architecture
Pure presentational/UI change. Touches **no** ship-truth, push, or scoring code. `ModalShell` owns: the `fixed inset-0` backdrop with **no** close-on-click, an optional `dismissDisabled` prop (to preserve `claimBusy`/`fixCapLoading`/`relinkLoading` guards), a `useEffect` Escape listener gated on the same flag, sticky header/footer slots, and the prominent X. Each existing modal keeps its own body, header title, and tooltips.

### Code plan
`src/app/fba/listing/[asin]/page.tsx`
- **Shell path (preferred):** new `ModalShell` component (props `open`, `onClose`, `dismissDisabled?`, `title`, `headerRight?`, `children`, `footer?`, `maxW?`). Migrate `4078`, `4118`, `4206`, `4296`, `4421`. Preserve per-modal `max-h-[85vh] overflow-y-auto` and the sticky top/bottom bars on the bulk (`4298`/`4381`) and ship modals — a regression here drops those bars.
- **Surgical path (fallback):** at each of the five backdrop `<div>`s, delete the `onClick` (or replace with a no-op); replace the X `<button>` with the prominent variant + `aria-label`; add a `useEffect` keydown→close (respecting the busy guard).
- Keep the X **always enabled** on push/bulk modals so the "safe to close mid-push" behavior and the reopening pill (`4407`) still work.
- **Do not touch** `page.tsx:1990`.

### Open questions
1. **Escape-to-close: yes or strictly X-only?** Recommendation is Escape allowed (a11y; matches today's X behavior mid-push). Confirm.
2. Shared `ModalShell` refactor (durable) **or** five surgical edits (smaller diff, less churn on a high-traffic file)? Recommendation: shell, unless we want to minimize collision with in-flight tasks #23/#26.

### Effort / risk
**S.** Risks: (a) A shared shell can regress z-index/scroll-lock or drop the sticky header/footer of the bulk & ship modals — verify the streaming pill still appears when closed mid-push. (b) Preserve the three busy-guards so a modal can't be dismissed mid-write (X **and** Escape must both respect them). No data-path risk.

---

## B) Add many more pushable clothing attributes

PO's requested set: Model Name, Handmade Classification, Special Features, Style, Fabric Type ("100% Cotton"), Care Instructions, Shirt Form Type, Sleeve Length Description, Sleeve Type, Animal Theme, Fit-to-Size Sentiment.

### Current state — this is a curation problem, not a plumbing problem
The detail system is **already schema-menu-driven and fully dynamic**; the static map is only the no-menu fallback. The push machinery auto-maps *any* schema attribute. The flow:

1. **Generation** — `runAuditAgent` (`src/lib/fba/listingPipeline.ts:3477`) emits `product_details_improvements[{field_name, current_value, recommended_value, reason}]`, grounded by `specsLine` (BLANK_SPECS) + `menuLine` (the live schema menu, `.slice(0,26)`). The PRODUCT DETAILS rule (~`3537`) tells the model to fill every applicable menu attribute using exact menu names.
2. **Schema menu** — `listPushableSchemaAttributes` (`src/lib/fba/productTypeDefinitions.ts:364`). Filters `MENU_EXCLUDE` (`334`), `MENU_PER_VARIANT` (`348` = `color/size/memory_storage_capacity/`**`style`**), and image locators; **bands** by `MENU_SEO_PRIORITY` (`359`) first / `MENU_NOISE` (`362`) last; returns top `max=26`; then an **ALWAYS-INCLUDE** loop force-adds `item_highlights`/`title_differentiation` if present (`397-407`). Called from `ai-recommendations/route.ts:600-624`.
3. **UI enrichment** — the recs GET computes `pushable`/`sp_api_key`/`enum_accepted` server-side (`ai-recommendations/route.ts:882-919`): static `resolveDetailAttribute` → dynamic `resolveSpApiKeyFromTitle` → `attributeExistsInSchema` → `coerceDetailValue`. Multi-design forces `DESIGN_NAME_SLOT_KEYS` (`style_name`/`color_name`/**`style`**/`color`) to per-variant/unpushable (`902`).
4. **Push** — single via `executePush` details branch; bulk via `executeBulkDetailsPush` (`pushExecutor.ts:3295`). `buildDetailPatchValue` for simple attrs; composites (neck/sleeve/closure) via calibrate→`buildShapedDetailValueVariants` (`pushExecutor.ts:3346-3373`).

**What already ships today** (verified in `ATTR_MAP`, `src/lib/fba/productDetailAttrs.ts:68-120`, and the SEO band): `material`, `fabric_type`, `fit_type`, `style` (mapped broadcast at `:75` **but** excluded from the *menu* by `MENU_PER_VARIANT`), `style_name`, `pattern`, `sleeve_type`, `neck_style`, `care_instructions`, `department`, `target_gender`, `age_range_description`, `occasion`, `theme`, `special_feature`, `item_shape`. So of the PO list: **Special Features, Fabric Type, Care Instructions map to existing seams already**; **Sleeve Type** is mapped/ranked **but blocked by the open sleeve write-rejection saga (task #26 in_progress — all write forms rejected).**

**Not yet reliably surfaced, per requested item:**
- **Model Name** (`model_name`) — not in `ATTR_MAP`, not in `MENU_SEO_PRIORITY` → only lands if it survives the 26-cap in the neutral band. Add to priority + ALWAYS-INCLUDE.
- **Style** — *contradictory today*: mapped broadcast at `productDetailAttrs.ts:75`, but excluded from the menu by `MENU_PER_VARIANT` (`348`) **and** forced per-variant on multi-design by `DESIGN_NAME_SLOT_KEYS` (`route.ts:902`). Needs the single/multi-design split (below).
- **Sleeve Length Description** — this is the **derived composite sub-field** `sleeve.length_description` the composite architecture **intentionally does not write**. **Leave out of the pushable set** (writing it resurrects the sleeve wrong-sub-field drop bug — task #26 territory).
- **Animal Theme** — needs a friendly→`theme` (or a per-schema `animal` key) grounding.
- **Shirt Form Type** (`shirt_form_type`) — confirm the key exists in the live SHIRT schema before mapping.
- **Fit-to-Size Sentiment** — no standard SP-API key; likely free-text `fit_to_size`/`size_to_size_recommendation` **if present**. Likely degrades to Manual/copy-only.
- **Handmade Classification** — almost certainly a **HANDMADE-program-only** attribute, absent from SHIRT. Likely unmappable → Manual/copy-only, never force a wrong key.

### Recommendation
Extend the existing **menu + map + prompt trio** — do **not** invent a parallel attribute list. Three coordinated edits, plus a truth-gate:

1. **Rank + guarantee** the PO's tokens into the menu (`productTypeDefinitions.ts`).
2. **Resolve the `style` contradiction** by family: broadcast-pushable on **single-design** apparel; per-variant/unpushable on **multi-design** (keep `DESIGN_NAME_SLOT_KEYS` authoritative there).
3. **Add missing friendly aliases** to `ATTR_MAP` for the no-menu fallback path.
4. **Truth-gate** fabric/material/care against `BLANK_SPECS` so values are authoritative, not LLM guesses (the spec-vs-search-grounding rule; a relaxed CC tee was once mislabeled "Oversized"). Unknown blanks stay **advisory/copy-only** — never push invented fabric/care/fit.

Force-inclusion must be **schema-gated** (`attributeExistsInSchema`) per listing, or a push 400s ("attribute path is not valid") and creates unfillable Features-gap docks.

### Architecture
Rides existing rails end to end. New attributes become generated+pushable when they (a) exist in the live product-type schema, (b) survive `listPushableSchemaAttributes` ranking/ALWAYS-INCLUDE, (c) the audit fills them, and (d) resolve/coerce/push auto-maps them. The only new logic is the single-vs-multi-design gate on `style` and the BLANK_SPECS truth-gate generalization.

### Code plan
`src/lib/fba/productTypeDefinitions.ts`
- `MENU_SEO_PRIORITY` (`359`): add `model_name|shirt_form_type|animal|fit_to_size|size_to_size|handmade` to the alternation. **Verify none collide with `MENU_NOISE` (`362`)** — the noise band is tested first (see the `compliance_age_range` precedence note at `376-379`).
- `MENU_PER_VARIANT` (`348`): make the `style` exclusion **conditional on multi-design** — thread an `isMultiDesign` flag from the caller (`route.ts:600`) into `listPushableSchemaAttributes`, and only exclude `style` when true. Single-design keeps `style` broadcast.
- Add an apparel **ALWAYS-INCLUDE** block after the item_highlights loop (`397-407`) that force-adds schema-present PO keys (`model_name`, `special_feature`, `fabric_type`, `care_instructions`, `fit_to_size`, `shirt_form_type`, `theme`) if not already in `out`. Consider bumping `max` from 26 to absorb the additions.

`src/lib/fba/productDetailAttrs.ts`
- `ATTR_MAP` (`68`): add `'model name'→model_name`, `'special features'→special_feature`, `'animal theme'→theme`, `'shirt form type'→shirt_form_type`, `'fit to size'`/`'fit-to-size sentiment'`→(confirmed schema key or omit), all `scope:'broadcast'`. **Do not** add `sleeve length description` (derived sub-field).

`src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`
- `600-624`: pass the `isMultiDesign` flag into `listPushableSchemaAttributes`.
- `902` `DESIGN_NAME_SLOT_KEYS`: confirm `style` stays per-variant **only** when `familyMultiDesign` (already the case) — ensure removing `style` from `MENU_PER_VARIANT` on single-design doesn't let a multi-design style leak to broadcast.

`src/lib/fba/listingPipeline.ts`
- `BlankSpec` + `BLANK_SPECS`: extend with `fabricType`/`careInstructions` (material already present). Generalize the blankSpec override block (fit+sleeve today) to also snap `material`/`fabric_type`/`care_instructions` when the blank is known; unknown-blank rows stay advisory.
- Audit prompt (`~3537`): optionally name the new apparel attrs in the no-menu fallback string. No structural change (already "fill as many as the menu offers").

**Verify each new key against a LIVE SHIRT schema** via `?debug=1&field=details&detail_field=` before claiming it pushable.

### Open questions
1. **Force-include vs confident-derive.** Do you want these attributes **guaranteed offered** on every apparel listing (may recommend unfillable/guessed values), or **only offered when the audit confidently derives a value**? Force-include risks bad values and Features-gap docks.
2. **Sleeve Type** is blocked by task #26 (all write forms rejected). Ship the other attributes now and treat sleeve separately, or wait?
3. **Confirm exact schema keys** for `shirt_form_type`, `fit_to_size` via the `?debug` route. **Handmade Classification** is likely HANDMADE-program-only — confirm; if absent on SHIRT it degrades to Manual/copy-only, never a forced wrong key.
4. **Unknown blanks** (no BLANK_SPECS match): suppress the new values entirely, or show as advisory copy-only (recommended)? PO may want them pushable when a seller confirms.

### Effort / risk
**M.** Risks:
- **Truth violation** — emitting LLM-guessed fabric/material/care for a known blank breaks spec-grounding. New attrs **must** be BLANK_SPECS-grounded before becoming pushable.
- **`style` leak on multi-design** — if `style` reaches broadcast-pushable on a POD family, one value clobbers every design's name slot and poisons the next regen. `DESIGN_NAME_SLOT_KEYS` must stay authoritative for multi-design.
- **Force-include off-schema** — a forced attribute absent from a given product type 400s and creates unfillable docks. Gate on `attributeExistsInSchema`.
- **Sleeve Length Description** — derived sub-field Amazon doesn't honor on writes; recommending it resurrects the sleeve drop bug. Keep it out.
- **Enum bypass** — new field_names must actually reach the validate-at-regen coercion (`route.ts:857-923`) so enum-invalid rows surface as a seller-picker, not auto-push.

---

## C) One "Ship all" bulk PATCH for the core content

### Current state — no core-bulk executor exists
Core content ships **one field at a time**. Per-section Ship buttons (title/bullets/description ~`page.tsx:2944/2976/3244`, keywords `3013`) → `openPushPreview(field)` (`1272`) → `confirmPush` (`1387`) → POST `push-content`. The route (`push-content/route.ts:153`) dispatches at `191-195`: **`details_bulk` → `executeBulkDetailsPush`, everything else → `executePush`** (a per-SKU loop for **one** field). Shipping all four = 4 modal opens, 4 POSTs, 4 × N-SKU × 2 PATCH calls, and a window where a variant shows title-new/bullets-old between pushes.

The **proven template is `executeBulkDetailsPush`** (`pushExecutor.ts:3295`), verified in full:
- PHASE 1 drops the non-buyable parent (`asin===parent_asin`, `3339-3340`).
- PHASE 3 per SKU: read current → `changedDetailFields` (only-changed keys) → **one `patchSkuMulti`** with many replace ops, VALIDATION_PREVIEW (`3415`) → LIVE (`3419`), with `pushPerFieldFallback` (`3424`/`3539`) isolating fields per SKU on atomic rejection.
- One `keyword_push_log` row **per (field, SKU)** (`3433`).
- PHASE 4: write-through per accepted field + **one** re-score via `pickRescoreRepresentative`/`scoreListingContent` + `enqueueVerification` per accepted field (`3441-3502`).
- **Critically: it does NOT stamp the outcome epoch** (`3475-3477`) because details change attributes, not copy.

Core fields already have all the per-SKU primitives: `resolveProposed` (`pushFields.ts:132`) handles broadcast (title/bullets/desc) **and** per-child (keywords via `perChild.get(sku)`) **and** `per_child_titles/bullets/descriptions` for multi-design/capacity families; `buildPatchValue` (`206`); `cacheUpdateFor` (`428`); `deriveActionPlan` (`293`) derives DONE/REPLACE purely from cache write-through. `FIELD_CONFIG` marks title/bullets/description broadcast, keywords per-child. The single-core path **does** stamp the outcome epoch on strict full-accept (`pushExecutor.ts:3250`, `failed===0 && !cancelled && accepted>0`).

### Recommendation
Add a **third executor `executeBulkCorePush`** as a sibling of `executeBulkDetailsPush` — do **not** overload `executePush` or the details path. Core fields need none of the details machinery (enum coercion, composite calibration, product-type schema checks) but need everything details_bulk skips: parent-hub broadcast rows, per-child keyword shape, trademark scrub, manual-title semantics, and — the sharp edge — **the outcome-epoch stamp, because copy actually changes.**

Per SKU, assemble **one `patchSkuMulti`** mixing broadcast ops (`item_name`/`bullet_point`/`product_description`, same value) and the per-child `generic_keyword` op **only when that SKU has a keyword diff row**, each value from `resolveProposed(field, rec, perChildKw, sku)`. VALIDATION_PREVIEW → LIVE → per-field fallback. Write one `keyword_push_log` row per (field, SKU); `cacheUpdateFor` per accepted field; one re-score; `enqueueVerification` per core field; **stamp the outcome epoch once on full-accept.** This collapses 4 POSTs × N × 2 into 1 POST × N × 2 (~4× fewer calls), atomic per SKU.

UX: a **"Ship all confirmed core →"** button at the top of the EDIT ONCE core section (near the per-section Ship cluster `~page.tsx:3242`) opening a checklist modal (Title / Bullets / Description / Backend keywords, each with its derived DONE/REPLACE verdict, preview, and include/skip toggle). Reuse the details-bulk modal chrome (stall watchdog, Stop, "safe to close"). Default a field to unchecked when it's already DONE across all cached children.

### Architecture
Reuses `resolveProposed`/`buildPatchValue`/`cacheUpdateFor`/`deriveActionPlan`/`pickRescoreRepresentative`/`stampOutcomeEpoch`/`enqueueVerification` verbatim. **The single divergence the reviewer must not simplify away: core-bulk MUST stamp the outcome epoch (mirror `pushExecutor.ts:3250`); details_bulk deliberately does not (`3475-3477`).** The other divergence is the **mixed broadcast + per-child PATCH body** — keywords are per-child and must never reach the variation parent.

### The two sharp edges (call them out explicitly)
1. **Mixed broadcast/per-child body.** The single PATCH per SKU carries broadcast fields (same value everywhere, including the parent hub, which `loadDiff` adds only for broadcast fields at `565-616`) **and** the per-child `generic_keyword` (present only where that SKU has a keyword diff; `loadDiff` drops no-keyword SKUs). **Drive ops assembly off each field's own `loadDiff` row presence — not a merged field list** — or a `generic_keyword` op leaks onto the parent hub. On multi-design/capacity families, `resolveProposed` per SKU returns `per_child_*` bytes; broadcasting one value writes the wrong content to variants (the exact class of bug the `broadcast` vs `effectiveBroadcast` guard exists for).
2. **Atomicity.** `patchSkuMulti` is atomic per SKU — one bad field (e.g. an over-long backend string) rejects the SKU's title+bullets+desc too. `pushCoreFieldFallback` (a core analog of `pushPerFieldFallback` using single-attribute `patchSku`) is **mandatory**, not optional.

### Code plan
`src/lib/fba/pushExecutor.ts` — new `executeBulkCorePush(params, emit)` (~+180 lines, **no** edits to `executePush`), modeled on `executeBulkDetailsPush`:
- `PushParams`: add `core_fields?: PushField[]` (subset of title/bullets/description/keywords; default all four).
- `reconcileFamilyChildren(parent_asin)` once (mirror the single-core full-push reconcile).
- For each requested field call `loadDiff(parent_asin, field)` (`pushExecutor.ts:401`). Build `unionSkus` (ordered set across diffs) + `perSkuField: Map<sku, Map<field, {raw,current,changed,notLive,isParent,asin}>>`. This gives broadcast-vs-per-child-in-one-body for free (keywords simply have no row for parent/no-kw SKUs).
- Per SKU (skip `notLive && asin!==parent` — carry the **UPDATE-ONLY / phantom-listing gate** from `executePush`, or offerless SKUs get PATCHed and Amazon creates "Missing offer" ASINs): gather each field where `row.changed` (idempotent re-run touches only still-wrong (field, SKU)); `scrubTrademarks` each value; `ops = changedFields.map(f => ({op:'replace', path:'/attributes/'+FIELD_CONFIG[f].attribute, value: buildPatchValue(scrubbed, MARKETPLACE_ID)}))`. For the parent hub SKU, never include `generic_keyword`.
- `patchSkuMulti` VALIDATION_PREVIEW → LIVE; on rejection `pushCoreFieldFallback` (new; uses `patchSku` + `FIELD_CONFIG.attribute`).
- Per accepted (field, SKU): `logPush` one `keyword_push_log` row with `field=<PushField>` **unprefixed** (unlike `details:<key>`), `previous_value=row.current`; `cacheUpdateFor(field,value)` write-through.
- One `rescoreParentFromCache` + `appendScoreHistory{trigger:'push'}` for the batch.
- Per core field with ≥1 accept: `enqueueVerification({parent_asin, field})` — reuses the existing per-field Verify-live (verify-push already supports title/bullets/description/keywords, `verify-push/route.ts:13,31`).
- `logPushChange` per accepted field + one `logAudit{mode:'core_bulk'}`.
- **On full-accept (every included child op accepted, `!cancelled`): `stampOutcomeEpoch(...)` once** (mirror `3250`). Partial → do **not** stamp.
- Manual titles: batch ships `resolveProposed(recommended_title)` and relies on `title_source='manual'` already living in `recommended_title` — do **not** thread `title_override`; keep the single Title Ship as the path for a freshly-typed title. Keep the manual-title-lock on the single path only.
- Extract a **pure, testable** `buildCoreOps(perSkuFieldRow, marketplaceId)` (like `changedDetailFields`) so ops assembly is unit-tested without Amazon.

`src/app/api/fba/listing-optimizer/push-content/route.ts`
- POST body type (`157`): add `core_fields?: PushField[]`.
- Dispatch (`191`): `else if (rawField === 'core_bulk') await executeBulkCorePush({ parent_asin, core_fields: body.core_fields, cancel_token: body.cancel_token, actor }, emit)`.
- (Lower priority) mirror into push-jobs for background-job parity with details_bulk.

`src/app/fba/listing/[asin]/page.tsx`
- New state `coreBulkOpen/coreBulkItems/coreBulkRunning/coreBulkProgress` mirroring `bulk*`. Build items from the derived action-plan core elements, default-checked by `verdict` (REPLACE→checked, DONE→unchecked-but-toggleable).
- `runCoreBulkPush` cloned from `runBulkPush` (`page.tsx:1603`): POST `{field:'core_bulk', core_fields, confirm:true, cancel_token}`; reuse the **same NDJSON stream reader + 60s stall watchdog**; on result map `perField` tallies to rows, refetch score + rank-free + the GET plan so cards re-derive DONE.
- "Ship all confirmed core →" button at `~3242`, gated by the concurrent-push guard (`openBulkPush`, `1583`). Reuse/parameterize the Auto-Push modal shell (`4296`).

`src/lib/fba/pushFields.ts` — no change (optionally a shared `CORE_PUSH_FIELDS` constant).

### Open questions
1. **Keywords in the batch by default?** PO framed it as "Title/Bullets/Keywords/Description," so include — but confirm the modal makes clear keywords are **per-child** (a different value per variant), so a single-value preview isn't misleading. Show broadcast/representative value with a "per child" badge (like the single-field modal).
2. **One combined confirm modal with per-row skip toggles**, or require the user to have opened/approved each of the four sections first? Recommendation: one modal, per-row toggles.
3. **Read-only preview**, or the same edit-before-push affordance the details modal has (`page.tsx:4347`)? Core copy is edited upstream via regen — recommend read-only preview + confirm.
4. **Multi-design/capacity families:** `resolveProposed` makes the batch per-child-correct, but should "Ship all core" be relabeled/hidden there so the per-design Ship presets (`onShipDesignField`, `page.tsx:1951`) stay primary?
5. **Background-job parity:** queue `core_bulk` via push-jobs (survives tab close) like details_bulk, or is the streaming modal enough for v1?

### Effort / risk
**M–L** (larger than it looks — the mixed body + epoch divergence are the cost). Risks:
- **Outcome-epoch divergence** — copy-pasting details_bulk silently drops the epoch stamp, breaking Phase-C outcome measurement (the ai-quota / ship-truth memories). Core-bulk **must** stamp on full-accept.
- **Per-child resolution** — must call `resolveProposed` per SKU or multi-design families ship one design's bullets to every child (cards read permanently REPLACE).
- **Parent-hub keyword leak** — `generic_keyword` must never reach the variation parent; drive ops off each field's own diff row.
- **Ship-truth write-through** — every accepted field must `cacheUpdateFor`, or the derived card stays red ("shipped but still red," the #358 regression).
- **Phantom listings** — carry the `notLive` UPDATE-ONLY gate into the union loop.
- **Atomicity** — `pushCoreFieldFallback` mandatory; without it one keyword defect silently blocks a good title on that SKU.
- **Stream drop mid-batch** — one long stream doing all four fields; a Coolify/Cloudflare ~100s kill leaves some fields pushed. Keep the changed-filter re-run idempotent + reuse the stall watchdog. **Open task #23 (details Auto Push stream drop) applies here too.**
- **Trademark scrub** — scrub each value at push (`executePush:3106`); a batch that forgets it could write a protected term.

---

## Guardrails (invariants B & C must honor)

*(From the always-on `fba-optimizer-coherence` / ship-truth model — `pushFields.ts:228-238`.)*

1. **One coverage predicate.** Neither B's new detail rows nor C's core bulk may re-introduce a keyword into bullets/title; keywords stay `generic_keyword`/backend. Core bulk ships exactly what `resolveProposed` returns per field — it must not re-place keywords.
2. **Ship-truth is derived, not stamped.** Cards/cohesion/score derive from live-vs-`resolveProposed` via `deriveActionPlan` (`pushFields.ts:293`). Any accepted push **must** `cacheUpdateFor` per (field, SKU) so cards flip DONE; omitting any accepted field = "shipped but still red."
3. **Per-child multi-design bytes are the truth.** Every field routes through `resolveProposed(field, rec, perChild, sku)` — the same function `deriveActionPlan` and single-field `executePush` use. Broadcasting `recommended_*` instead poisons variants.
4. **UPDATE-ONLY.** Drop the non-buyable parent and gate offerless/not-live SKUs (phantom-listing prevention) in both the core union loop and any new detail push path.
5. **Spec-grounding over search/LLM.** New B attributes (fabric/material/care/fit) ground to authoritative `BLANK_SPECS`, never LLM guesses; unknown blanks stay advisory.
6. **Outcome-epoch semantics.** Core copy pushes stamp the epoch on full-accept (`pushExecutor.ts:3250`); attribute-only pushes do not (`3475-3477`). Core-bulk = copy → **stamp.**
7. **Enum validity.** New detail values must pass the validate-at-regen coercion (`route.ts:857-923`); enum-invalid → seller-picker, never auto-push.

---

## Suggested sequencing

**PR-1 (do first): A — dismiss-only modals.** Small, pure-UI, zero data-path risk, and it builds `ModalShell` — which C's new confirm modal can then reuse. Fastest PO-visible win.

**PR-2: C — core bulk PATCH.** Highest-leverage feature; self-contained on the push/executor side; consumes the `ModalShell` from PR-1. The two sharp edges (mixed body, epoch stamp) want a focused PR with the adversarial review + a `buildCoreOps` unit test.

**PR-3: B — attribute expansion.** Depends on a live-schema debug pass (which keys actually exist on SHIRT/HANDMADE) and touches the audit/generation + BLANK_SPECS truth-gate. Do it after C so the two don't collide in the recs route, and so any schema surprises (Handmade, fit-to-size, shirt_form_type) don't hold up the higher-value C work.

**Sharing a PR:** A + C **can** share a PR only if the `ModalShell` lands first within it (C reuses it); otherwise keep them separate for a cleaner review. **B should be its own PR** — it needs the schema-verification gate and BLANK_SPECS changes reviewed independently, and it collides most with in-flight tasks #26 (sleeve) and the recs route.

**Coordination note:** all three touch `page.tsx` (~4941 lines) and B/C touch `pushExecutor.ts` (~3568 lines) — high-churn files with active work (tasks #23, #26). Land PR-1 fast, rebase PR-2/PR-3 on it, and keep edits out of the bulk-push region until #23/#26 settle.

---

# Round 2 — B0GQXSNQ6R (score/backend/A+)

## D) Bullets pushed but the score didn't update (recurring)

**Current state.** The score ring reads a single `score` state object rendered at `src/app/fba/listing/[asin]/page.tsx:2045` (`<ScoreRing score={score.overall_score} />`). After a push, `confirmPush` already refetches the persisted score on `data.pushed > 0` and calls `setScore(found)` (`page.tsx:1501-1509`), with `refreshScore()` also firing in the finally block (`page.tsx:1749`). Server-side, `executePush` write-throughs the pushed bytes into `listing_content` via `cacheUpdateFor(field, value)` (`src/lib/fba/pushExecutor.ts:3122-3128`), then calls `rescoreParentFromCache` (`pushExecutor.ts:3159` → `2624-2651`), which re-reads the now-current row, re-scores, and persists `overall_score` + all six sub-scores **before** the terminal `emit({type:'result'})` at `pushExecutor.ts:3259`. So the number the seller sees is the true, freshly-persisted `overall_score` — there is no refetch gap here (unlike the #408 cohesion case).

The overall is a weighted fold of six sub-scores each graded 0–25 (`src/lib/sync/syncListingContent.ts:1291-1297`), with weights title 22 / keyword 20 / bullets 18 / aplus 16 / description 12 / features 12 (`src/lib/fba/scoreWeights.ts:11-18`), folded by `weightedPoints(s25, w) = Math.round((clamp(s25,0,25)/25) * w)` (`scoreWeights.ts:21-24`).

**Root cause / recommendation — this is NOT a bug; it is coherence reality plus a rounding floor.** A bullets push can only move `bullet_score` (weight 18, `syncListingContent.ts:835-964`) via format/length/design-name-cohesion deductions (`:849-868`, `:1133-1135`). It **cannot** move `keyword_score` (weight 20, `:1036-1103`): per Invariant 3 the generator deliberately routes opportunity keywords to backend, not bullet prose, so `criticalCount` in `fetchScoringContext` (`:467-481`) is unchanged, and the field-agnostic bullet opportunity dock (`:917-937`, haystack `[title, ...bullets, backend]`) reads 0 before and after if backend already covers those terms. If the seller shipped the already-well-formed AI-recommended bullets (the common case), the bullet deductions were already near-zero.

The rounding floor then absorbs the tiny delta into **zero**: `weightedPoints` rounds each section independently, so an internal bullet improvement of 23→24 yields `round(23/25·18)=17` → `round(24/25·18)=17` = **+0 overall**; even a full 21→25 cohesion fix is only 15→18 = +3. On B0GQXSNQ6R — already dominated by the missing 16-point A+ block and a keyword score bullets can't touch — the ring visibly does nothing.

Amazon-apply lag (a) is ruled out: the write-through makes the re-score read the just-pushed bytes immediately; lag only affects a later verify reconciliation. Client refetch gap (c) is ruled out per the anchors above. **The honest fix is a UI clarification of "what moves this number," not a re-score, refetch, or (worst) re-coupling bullets to keyword coverage** — the latter would violate Invariant 3 and recreate the cured "regenerate to fix what regen can't fix" loop.

**Architecture.** Treat this as a UI-honesty surface, not a scoring change. The data needed is already in the `score` state (all six sub-scores + `issues`). Two additive UI affordances plus one optional, separately-gated scorer nicety. Do not add coupling between bullet prose and keyword coverage.

**Code plan.**
- `src/app/fba/listing/[asin]/page.tsx:210-224` (`ScoreRing`) and the sub-score cards near `:2045` — add a "What moves this number" explainer keyed to the pushed field, shown when the post-push `overall_score` delta is 0 (or below the section's rounding step). For bullets: "Bullets are graded on format and readability (18/100). Keyword ranking lives in Backend Keywords (20/100) and A+ (16/100); this listing has no A+, so that 16 pts is your biggest lever." Deep-link to the A+ CREATE card, not a bullets re-push.
- `src/app/fba/listing/[asin]/page.tsx:1508` (after `setScore(found)`) — capture the pre-push `score` snapshot before the refetch, diff the pushed section's sub-score, and render a per-card "+0 / +1 Bullets" delta so "the bullet card improved but the ring rounded flat" is self-evident.
- Optional, separate decision — `src/lib/sync/syncListingContent.ts:1291-1297` + `scoreWeights.ts:21`: round the overall sum once instead of each section, so sub-1-point honest deltas register. This re-baselines all historical scores — gate it, do not bundle with the UI fix, and note it does not change the core truth that bullets can't move keyword coverage.

**Open questions.**
- Do we want the per-section delta chip on every push, or only on a 0-delta push? (Recommend always — it teaches the model continuously.)
- Is the one-time-round-the-sum change worth the history re-baseline? (Recommend deferring; it is cosmetic relative to the A+/keyword levers.)

**Effort/risk.** UI explainer + per-section delta chip: **S**, low risk (read-only from existing state). Scorer round-once change: **M** and higher risk (re-baselines every score) — keep it out of scope unless separately approved.

## E) Backend keywords land at ~200 chars, not the full budget

**Current state.** All anchors in `src/lib/fba/listingPipeline.ts`. The backend string is designed to climb through stages to ~244–250 bytes: (1) a core whole-phrase loop that **deliberately stops at 200 bytes** (`runBackendAgent`, `if (getByteLength(corePhrases.join(' ')) >= 200) break` at line **3252**, with the comment at 3249–3252 stating it leaves ~33 bytes for the token pass); (2) a gap-closing token pass capped at 233 (lines **3283–3305**); (3) an LLM theme fill (gpt-4.1-mini) that fires only `if (… < 220)` (line **3314**) and stops at 233 (**3348**); (4) `truncateToBytes(…, 233)` + a per-color tail up to 250 (`buildString` 3431–3444); and (5) `fillBackendToBudget` at the call sites (451–561) targeting 244 (**522**, **558**) capped at 250.

The pool is pre-narrowed twice before the core loop: `dropJunkAndTrademarks` (3939–3955, including `isOffNicheKeyword` at 3953) and `banBackendTok` (6475–6486). Stages 2 and 5 iterate the **same** opportunity pool the core loop already drained, re-filtering every candidate against `coreWordSet`/`excludeWords`/`banTok` (3294–3297) and `have`/`scorerHave`/`alreadyIndexed` (511–513). `topVolumeBackendPhrases` (505–518) seeds from the top-8 of that same drained pool; the generic loop (536–559) re-walks the drained pool plus canonical-title bigrams that `alreadyIndexed` strips as live-title echo.

For a single low-traffic graphic tee (exactly B0GQXSNQ6R — A+ 0/16, thin listing), the clean pool is small. Once the core loop drains it to the 200-byte stop, **stages 2/4/5 have no novel bytes left**, and the only genuinely additive source — the stage-3 theme fill — is gated too tightly (`< 220`), capped too low (`>= 233`), and wrapped in a `try/catch` that **silently swallows** any error (`3351 catch { /* fill is best-effort */ }`), unlike the color-tail call two blocks down which retries twice (**3387**). On a colorless/single-color family `tailColors` is empty (3365), so stage 4 adds 0 bytes. Net: the string ships at ~200.

It ships **silently** because `backendOutputProblems` (567–598) only flags `minBytes < 190` (line **580**); the inline comment (575–579) explicitly classifies ~200 as "a thin catalog… clears ~200" and refuses to raise the floor. So ~200 passes the degrade gate with no `[BACKEND]` stream-error event and no banner, and never self-heals.

**Root cause / recommendation — the fill gap.** This is **(a) a starved pool after the 200-byte phrase-stop, compounded by (c) the 190-byte floor letting the thin string ship silently**. It is not a wrong cap (b) and not locked/manual keywords (d). The `~200` figure is the hard-coded waypoint at line 3252 becoming a terminal floor because the three downstream top-up passes all draw from the same drained pool. The cure is **not** raising `minBytes` (the comment correctly notes that false-fails genuinely thin catalogs and keyword-only regens throw). The cure is to make the theme fill — the only byte source independent of the drained pool — actually fill the 200→244 band, and turn the silent pass into a self-heal.

**Architecture.** Keep the core-stop at 200 as a waypoint. Widen and harden the single independent byte source (stage 3), and add a soft self-heal band (not a hard-fail) below budget so the underfill is detected and re-run rather than shipped. Do not touch `alreadyIndexed`/echo aggressiveness or lower `banBackendTok` — those are PO-approved and correct; the deficit is a missing independent source on thin pools.

**Code plan (file-by-file, `listingPipeline.ts`).**
- **3314** — change the theme-fill trigger `< 220` → `< 244` (listings sitting at 205–232 currently never invoke it).
- **3348** — change the internal stop `>= 233` → `>= 244` (currently stops 11 bytes short of budget). Let `fillBackendToBudget`'s 244 target at 522/558 do the final settle; keep truncate at 3356 budget-aware.
- **3351** — replace the single best-effort call with the same 2-attempt retry loop the color-tail uses at 3387 (model `gpt-4.1-mini`, `max_tokens: 300`); on double-miss log a `[BACKEND] theme-fill returned nothing` warning (mirror 3405) so a transient hiccup doesn't silently leave the field at 200.
- **3343** — relax the `coreWordSet` half of the collision skip so distinct co-tokens of an accepted themed phrase survive; keep the `excludeWords` half (that is correct echo suppression). Today the fill contributes only its 1–2 net-new tokens because it re-drops against `coreWordSet`.
- **580** — keep the 190 hard-fail; add a **soft** signal for the 190 ≤ minBytes < 228 band that triggers a top-up re-run of the theme fill (self-heal) rather than an abort — matches the standing self-healing directive (detect → fill → re-verify). Do **not** raise the 190 floor.
- **3252** (`>= 200`) can stay unchanged — with stage 3 widened, 200 becomes a waypoint again rather than a terminal floor.

**Open questions.**
- Should the soft self-heal band re-run be inline (blocking the pipeline one extra LLM call) or a deferred background top-up? (Inline is simpler and the call is ~300 tokens; recommend inline with the 2-attempt cap.)
- Confirm the exact upper edge of the soft band (228 chosen as "clearly under budget but above the thin-catalog floor") — is there a listing class that legitimately tops out at ~210 where a re-run would just burn a call?

**Effort/risk.** Constant/threshold changes (3314/3348) + retry wrap (3351) + collision relax (3343): **S**, low risk. Soft self-heal band with re-run (580): **M**, low-to-moderate risk — the hard 190 fail is preserved so the wipe class is still caught; the new path only adds bytes, never removes.

## F) A+ content "Scan now" (in the score tile + the A+ module card)

**Current state.** A+ status is fetched by exactly one function, `fetchAplusStatus()` at `src/lib/sync/syncListingContent.ts:233-279` (module-private, not exported), which GETs the A+ Content Management API `searchContentPublishRecords` (`{ENDPOINT}/aplus/2020-11-01/contentPublishRecords?marketplaceId=…&asin=…`, lines 240-247). `hasAplus = publishRecordList.length > 0` (256-278); EBC → module/headline, EMC → brand story. Results land on `listing_content` columns `has_aplus`, `aplus_module_count`, `aplus_has_brand_story`, `aplus_has_headline`, `aplus_images_missing_alt` (written at 1541-1547 and 1662-1667). The call targets a representative **child** ASIN with a parent fallback (`:1528-1547`, `:1645-1667`), because A+ is child-associated.

The "A+ 0% · 0/16" tile is a pure function of the stored `has_aplus` boolean: `aplusScore` starts at 25 (`:713`), and `!hasAplus` → `aplusScore = 0` + critical issue (`:1158-1160`), read via `hasAplusEarly = representativeContent.has_aplus` (`:968-969`, reused at `:1152`). Weight 16 (`src/lib/fba/scoreWeights.ts:15`), persisted as `aplus_score`, rendered at `src/app/fba/listing/[asin]/page.tsx:1977` (`weightedPoints(score.aplus_score, SECTION_WEIGHTS.aplus)`).

**The 0/16 is structurally stale.** `has_aplus` is written only by a full content sync, of which there are two producers, both heavy: the bulk `syncListingContent(topN=50)` (`:1569`, top-50-by-30d-sales only — a low-traffic parent like B0GQXSNQ6R is never re-touched), and the on-demand `syncSingleAsinContent()` (`:1467`, reachable only via `?pull=` / search-miss at `route.ts:349-364`, `:457`). Nothing on the listing page re-runs either for A+. So if the seller creates/publishes A+ in Amazon after the last sync, the optimizer shows 0/16 forever. There is no A+-specific re-check anywhere — confirmed: the only callers of `fetchAplusStatus` are the two sync functions.

**Root cause / recommendation — the design.** Two distinct staleness sources must both be surfaced: (1) our cache is never refreshed for low-traffic parents; (2) `searchContentPublishRecords` returns only APPROVED+PUBLISHED records, so A+ that is **submitted but under Amazon review** reads `hasAplus=false` even on a fresh scan. So "Scan now" must distinguish *not created* from *submitted, pending Amazon review* to actually answer the user's question. Phase 1 ships with publish-records only plus a "pending" caveat in copy; phase 2 adds `getContentDocument.status` (`DRAFT|SUBMITTED|APPROVED|PUBLISHED|REJECTED`) via `searchContentDocuments` / `listContentDocumentAsinRelations` for a true `pending` verdict. `getListingsItem` summaries do not carry A+ — keep A+ as its own API.

**Architecture.** A narrow, A+-only self-heal: one API call → UPDATE only the A+ columns → re-score → client refetch. This satisfies the self-healing directive (detect → inherit valid value → re-verify → surface) and keeps the blast radius small (a full `syncSingleAsinContent` would re-fetch/re-score title+bullets+keywords and could stomp freshly-pushed-but-not-yet-live content under the 15min–6hr Amazon lag).

**Code plan.**
- **New exported fn in `syncListingContent.ts`** (co-located so it can call the private `fetchAplusStatus`): `export async function rescanAplusForAsin(supabase, asin): Promise<{ has_aplus; aplus_module_count; aplus_has_brand_story; aplus_status: 'live'|'pending'|'none'; aplus_score; overall_score } | null>`. Steps: `getAccessToken()` + resolve the family via the existing `listing_health` `.or(parent_asin.eq/asin.eq)` query (`:1478-1494`, incl. `discoverSkusForAsin` fallback); call `fetchAplusStatus(token, firstChildAsin)` with the parent fallback of `:1531-1537`; **UPDATE only the A+ columns** on the family's `listing_content` rows; call the already-exported `ensureListingScored(supabase, parentAsin)` (imported at `route.ts:21`) to recompute `aplus_score` + `overall_score` and re-derive the card (ship-truth pattern); return the new numbers.
- **New endpoint** `POST /api/fba/aplus-scan` (or fold into the optimizer route as `?aplusScan=<asin>`, parallel to the `?pull=` branch at `route.ts:349-364`). Body `{ asin }`; returns the `rescanAplusForAsin` object or `{ scanned:false, reason }`. Behind the same `/api/fba` auth gate.
- **UI — score tile.** In the `bars` render (`page.tsx:1969-1978`, A+ bar at `:1977`), add a "Scan now" affordance on the A+ card. On click: POST the endpoint with a spinner ("Re-checking Amazon for A+…"), then call the existing `refreshScore()` (`page.tsx:904-912`) so the tile, ring (`:2045`), and child table (`:3624`) all re-read `score`. Toast: "A+ found — N modules (X/16)" / "Submitted, pending Amazon review" / "Still no A+ detected."
- **UI — APLUS MODULES card.** The card renders from `item.aplus_modules` at `page.tsx:3272-3288` (type `AplusModuleAction` at `ai-recommendations/route.ts:163-179`). Add the same "Scan now" button in the card header, same handler → same `refreshScore()`. Because the "does not exist" verdict is derived by the AI audit from `has_aplus`, when a scan flips `has_aplus=true` chain into `generateAiRecs()` (`page.tsx:1116`) so the card self-updates CREATE→EDIT without a second click (aligns with the don't-gate directive).

**Open questions.**
- Ship phase-1 (publish-records only, "pending" as a caveat) now, or wait for phase-2 `getContentDocument` status so the `pending` verdict is real? (Recommend phase-1 now; the honest copy still resolves most confusion.)
- Should the scan auto-chain the AI-recs regenerate on a `has_aplus` flip, or leave it a second explicit click? (Recommend auto-chain per don't-gate.)

**Effort/risk.** `rescanAplusForAsin` + endpoint: **M** (one API call, narrow UPDATE, reuse of `ensureListingScored`/`refreshScore` — low risk because it touches only A+ columns). UI on both surfaces: **S**. Phase-2 `getContentDocument` pending-detection: **M**, additive, deferrable.

## G) The A+ "Create" link is broken

**Current state.** There is **no clickable CREATE link on the aplus_modules card at all.** The word "CREATE" renders only as an inert verdict badge — a plain `<span className="…text-slate-400">{item.verdict}</span>` at `src/app/fba/listing/[asin]/page.tsx:3058`, with no `href` and no `onClick`. The card flows through the generic Edit-Once (Parent Level) map at `page.tsx:3027`; `aplus_modules` survives the `filter(a => a.element !== 'backend_keywords')` at `:2526` and renders as a read-only card: the instruction row (`:3080-3085`) is plain text; `seller_central_path` (`:3087-3092`) is rendered as an unclickable `<p className="…text-slate-400">`; there is no `replacement_content` box; and the Ship button explicitly returns `null` for anything that isn't title/description/bullets:

```
const shipField: PushField | null =
    item.element === 'title' ? 'title'
  : item.element === 'description' ? 'description'
  : /^bullet/.test(item.element) ? 'bullets'
  : null
if (!shipField || item.verdict === 'SKIP') return null
```
(`page.tsx:3230-3238`). The A+ module briefs at `:3273-3288` (the "#1 ADD Standard Image & Text" line) are inert `<div>` text with no link or handler. So the card is entirely read-only — the "CREATE link we added yesterday" was never wired as an anchor.

The only working A+ anchor is the page-header button at `page.tsx:2057-2061`, which points at the **edit** endpoint: `https://sellercentral.amazon.com/enhanced-content/edit?asin=${asin}`. For a listing with no A+, that lands on an empty "nothing to edit" state (reads as broken), and it is detached from the CREATE card in the header, so it doesn't feel like "the CREATE link on the card." The codebase already uses the correct create destination everywhere else — `src/app/fba/page.tsx:3475` and `src/lib/sync/syncListingContent.ts:1160,1168` all use `https://sellercentral.amazon.com/enhanced-content/content-manager`.

**Root cause / recommendation — the actual bug.** The CREATE verdict text is a `<span>`, never an `<a>`; the natural link home (`seller_central_path`) is a dead `<p>`; the Ship button returns `null` for `aplus_modules`. A+ creation is not push-automatable here (`auto_fixable: false` on the A+ issues, `syncListingContent.ts:1160/1168`; the SP-API A+ Content API is not wired for writes in this app), so CREATE must be a **hand-off deep link** into A+ Content Manager, carrying the computed module brief — not an API push. Use `/enhanced-content/content-manager` (the create/list surface), not `/enhanced-content/edit?asin=` (edit-existing, requires a project to exist), so all A+ links agree on one destination.

**Architecture.** One destination for all A+ links (coherence). Render a real `<a>` CTA on the CREATE card body, branch the header link on `has_aplus`, and optionally add a "copy module brief" for the hand-off. Apply the same treatment to the `brand_story` CREATE card, which the server sets identically (`listingPipeline.ts:6823-6828`).

**Code plan (`src/app/fba/listing/[asin]/page.tsx`).**
- **Primary — real link on the card.** In the aplus_modules card body (best in Row 4 at `:3087-3092`, or a dedicated CTA just above the module list at `:3273`), render, when `item.element === 'aplus_modules' && item.verdict !== 'SKIP'` (and for `brand_story` CREATE too), an `<a href="https://sellercentral.amazon.com/enhanced-content/content-manager" target="_blank" rel="noopener noreferrer">Create A+ in Content Manager →</a>` styled as a blue button (`Icon.External`). Match the endpoint already used at `fba/page.tsx:3475`.
- **Secondary — header link.** At `:2057`, branch on `score.has_aplus` (the score object carries `has_aplus`/`aplus_module_count`/`aplus_score`, interface at `page.tsx:27-34`): `edit?asin=${asin}` when true, `content-manager` when false; switch the label between "Edit A+ Content" and "Create A+ Content".
- **Optional — copy brief.** Add a "Copy module brief" button next to the CREATE link that copies `item.aplus_modules[]` (position / module_type / content_brief), mirroring the copy pattern at `:3199-3209`, so the seller pastes the plan into Content Manager.

**Open questions (real, verify-before-done per shipping-from-fact).**
- Does `https://sellercentral.amazon.com/enhanced-content/content-manager` open the create wizard (or the A+ list where "Create" is one click) for an authenticated session? Must be confirmed live.
- Does `/enhanced-content/edit?asin=<asin>` actually honor the ASIN query param at all? If not, use `content-manager` in **both** header branches rather than a possibly-dead `edit?asin=` URL.

**Effort/risk.** Card `<a>` CTA + header branch + brand_story parity: **S**, low code risk. The only real risk is the deep-link destinations themselves — both URLs must be validated in a live Seller Central session before calling this fixed; a wrong endpoint is exactly the "link doesn't work" symptom being reported.

---

*PO label mapping: A→D, B→E, C→F, D→G; all four concern listing B0GQXSNQ6R.*
