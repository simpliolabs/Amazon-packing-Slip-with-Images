# "Keep current" — Per-Field Reject/Lock Design Spec

## 1. Summary

"Keep current" generalizes the existing single-field **title lock** (`title_source='manual'`, migration 044) into a per-field REJECT control on every pushable card — title, bullets, description, and per-child backend keywords. The seller workflow it enables: **Generate an AI audit and SHIP** → live content equals the recommendation → the card derives **GREEN**; **Regenerate** (a whole audit or one field) → the new suggestion differs from live → the card derives **RED**; **click "Keep current"** → the recommendation for that field is set to the field's **current LIVE value** (the last shipped version) plus a per-field lock → the card derives **GREEN** again. The core insight is the one the title lock already proves: card verdict is a **pure function of recommended-vs-live** computed at serve time by `deriveActionPlan` (`src/lib/fba/pushFields.ts:293-423`), so writing `recommended := live` makes `expected === cached` for every child → `allMatch` → verdict `DONE` → green, **with no Amazon push** because the value is already live. Storage is **one additive `field_locks` JSONB column** (not eight columns); the lock is preserved through whole-audit regens and cleared by a field's own regen, exactly mirroring the title precedent — generalized, never duplicated. (Title keeps its **existing** `title_source='manual'` lock unchanged; the new `field_locks` column covers **bullets, description, and per-child backend** — see §4.)

---

## 2. User workflow

Three steps, per pushable field card:

1. **Generate + Ship (baseline green).** Seller runs the AI audit, ships the recommendation to Amazon. `listing_content` (live cache) now equals `recommended_<field>`. `deriveActionPlan` yields `DONE` → the card renders green (`page.tsx:2450-2458`). This is an **Optimized green**.

2. **Regenerate (red).** Seller re-runs the whole audit or clicks the field's own Regenerate. A fresh AI suggestion overwrites `recommended_<field>` ≠ live → `deriveActionPlan` yields `REPLACE` → the card renders red. A **Ship** button and a **Keep current** button are both offered.

3. **Keep current (accepted green).** Seller clicks **Keep current**. The endpoint writes `recommended_<field> := the current live value` (per-child for backend / multi-design) and sets `field_locks[field]`. No Amazon push. On the streamed result and the next GET (heal-on-read, `route.ts:1471-1487`) the card derives `DONE` → green — now carrying a **"Kept" badge** that distinguishes it from an Optimized green. Where the field is locked, the card shows **Unlock** instead of Ship + Keep.

State cheat-sheet:

| State | Card color | Badge | Buttons offered |
|---|---|---|---|
| Fresh suggestion ≠ live | RED | — | Ship, **Keep current** |
| Shipped, live == rec | GREEN | Optimized (none) | Ship (re-verify) |
| Kept (locked), rec == live | GREEN | **Kept** | **Unlock** |
| Unshipped (no live value) | RED | — | Ship only; **Keep current disabled** |

---

## 3. Behavior spec — lock lifecycle state machine

Per field ∈ `{title, bullets, description, keywords}` (keywords = backend, tracked **per child SKU**).

```
        ┌────────────────────────── unlocked (field_locks[f] absent) ──────────────────────────┐
        │                                                                                       │
        │  Keep current click        Field's OWN Regenerate (regenerate_section === f)          │
        ▼  (write rec:=live,          clears the lock                                            │
   ┌──────────┐  set lock)      ┌──────────────────────────────────────────────┐               │
   │ unlocked │ ───────────────▶│ kept-locked  (field_locks[f] set, rec==live)  │               │
   └──────────┘                 └──────────────────────────────────────────────┘               │
        ▲                             │              │                     │                     │
        │ Unlock click                │ Whole-audit  │ Other-field regen   │ Field's OWN regen   │
        │ (remove lock,               │ PRESERVES    │ PRESERVES           │ CLEARS lock ────────┘
        │  rec stays==live,           │ (rec held,   │ (rec held,          │ (new suggestion
        │  green until next regen)    │  stays green)│  stays green)       │  replaces rec → RED)
        └─────────────────────────────┴──────────────┴─────────────────────┘
```

**Preserves the lock** (rec held at the kept value, badge survives, card stays green):
- A **whole-audit** regen (`regenerate_section === 'all'`).
- A regen of a **different** field (`regenerate_section !== f`).

**Clears the lock** (rec replaced by the fresh AI value, card goes red):
- The field's **own** Regenerate (`regenerate_section === f`).

**Unlock** (explicit button): removes `field_locks[f]` and the badge only. `recommended_<field>` is left untouched (still == live), so the card stays green until the next regen produces a new suggestion. Unlock does **not** restore any prior AI suggestion — there is no history.

---

## 4. Data model

### Column

One additive, idempotent JSONB column on `listing_seo_recommendations`, mirroring migration 044's `ADD COLUMN IF NOT EXISTS ... DEFAULT` + `NOTIFY pgrst` pattern (`044_manual_title_lock_and_push_counts.sql:10-11`).

**Title authority decision (converged):** Title **keeps its existing `title_source='manual'` path** unchanged. `field_locks` holds locks for `bullets`, `description`, and `keywords` only. The badge/derive/preserve logic reads **both** sources; no path double-writes title. This avoids rewriting the shipped title guard and keeps the migration purely additive.

### Shape

Keyed by the `regenerate_section` namespace verbatim (`route.ts:390`). Broadcast fields are booleans; **backend is per-SKU** (PO requirement: re-accept EACH child's own live backend, never one broadcast flag):

```jsonc
{
  "bullets":     true,
  "description": true,
  "keywords":    { "<SKU-A>": true, "<SKU-B>": true }   // per child, dedup twins by ASIN (prefer -FBA)
}
```

Absent/null column **always** coalesces to `{}` (no field locked) — a null/absent value **never** means "locked" and reading it must never throw:

```ts
const locks = (row?.field_locks as Record<string, unknown> | null) ?? {};
```

### Backward-compat / lagging-migration safety pattern (load-bearing — mirror `title_source`)

- **Reads** of `field_locks` (and the stored per-field snapshots needed for preserve) go in a **separate** supabase `select` wrapped in its **own** try/catch — **never** appended to the shipped title-lock select at `route.ts:1170-1174`. An explicit column select of a missing column errors in PostgREST; if `field_locks` rode on the title select, a lagging migration would throw that whole select (caught at `route.ts:1185`) and **silently disable the working title lock**. Keep the reads independent so a missing `field_locks` column degrades only the new preserve.
- On GET, read `field_locks` tolerantly (separate try/catch, or a `select('*')` that simply omits absent columns) and coalesce → `{}`. The page must render with zero locks, never 500, when the migration lags.
- **Writes:** `field_locks` is **OMITTED** from the full-path `dbPayload` upsert (`route.ts:1230-1247`) **and** from the minimal-retry payload (`route.ts:1261-1272`), exactly as `title_source` is omitted (`route.ts:1226-1229`). It is written **only** by (a) the keep endpoint and (b) the partial-path clear, each via a separate `.update()`. Putting it in the upsert would trip the loud "FULL UPSERT FAILED" retry on every audit wherever the migration lags, and would let a whole-audit transition the lock.

### Migration SQL (copy-pasteable)

```sql
-- NNN_field_locks_keep_current.sql
-- "Keep current" per-field reject/lock. Additive, idempotent. Mirrors 044.
ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS field_locks jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill is automatic via DEFAULT; existing rows become '{}'.
-- Code must STILL treat an ABSENT column (migration lag) as {} — absence != null.

NOTIFY pgrst, 'reload schema';
```

---

## 5. API — the "Keep current" (keep-field) endpoint

Generalize `src/app/api/fba/listing-optimizer/lock-title/route.ts:30-92` into a per-field keep endpoint (new sibling route, e.g. `keep-field/route.ts`, or an extended generic route).

**Request body:**
```jsonc
{ "parent_asin": "B0...", "field": "bullets" | "description" | "keywords" | "title",
  "action": "keep" | "unlock",
  "sku": "<SKU>"   // required only for backend/keywords per-child keep
}
```

**On `action:'keep'`:**
1. Read the field's **current LIVE value** from `listing_content` — the **same** deduped source `deriveActionPlan` compares against (`dedupByAsin`, prefer `-FBA`, `pushFields.ts:219-226`). Use `currentValue(field, row)` (`pushFields.ts:178-188`) as the normalizer.
2. Write the recommendation := that live value:
   - **title/bullets/description:** set `recommended_<field>` **and** `per_child_<field>` (each child's own live value) — because `resolveProposed` **prefers** `per_child_<field>` (`pushFields.ts:152-171`); a stale per-child override would otherwise still ship. For bullets write the whole `recommended_bullets` array := live `bullet_1..5`.
   - **keywords (backend):** rebuild the `recommended_keywords` TEXT-JSON so **each** child entry `.keywords := that child's own live `backend_keywords`` (keyed per ASIN, twins deduped). Never a single broadcast string.
3. Merge the lock: `field_locks[field]=true` (broadcast) or `field_locks.keywords[sku]=true` (per child) — **server-side atomic merge** (see §9 concurrency), not a whole-object read-modify-write from the client.
4. **NO Amazon push** — value is already live. This is the explicit no-push analog of the implicit lock-on-push (`pushExecutor.ts:3111-3130`); do not route through a push.
5. **Fail LOUDLY** if the `field_locks` column is missing (mirror `lock-title/route.ts:67-72`); never silent-fallback.
6. **Audit log:** insert `listing_change_log` with `action:'edit'`, `field:'<field> (kept)'`, before/after = live value. `'keep'`/`'lock'` are **not** in the migration-037 CHECK set (`edit/ai_generate/ai_regenerate/push/claim/release/takeover`); an `action:'keep'` insert is silently swallowed. Encode state in the field label exactly as `lock-title/route.ts:77-84` does.

**On `action:'unlock'`:** remove the lock key (`field_locks - 'field'` or drop the per-SKU entry) via atomic merge; log `field:'<field> (unlocked)'`. Leave `recommended_<field>` untouched.

---

## 6. UI

### "Keep current" button — placement per card
Generalize `saveTitleLock` (`page.tsx:1034-1052`) into `keepCurrent(field)`. Add the button inside the per-field card loop (`page.tsx:2995-3259`) as a **sibling to Ship in Row 5c** (`page.tsx:3198-3233`), which already computes `shipField` (title/bullets/description) and the DONE-aware visibility. `onClick` POSTs to the keep endpoint, then optimistically patches `aiRecs.field_locks[field]` + `recommended_<field>` (mirroring the title handler's optimistic patch of `aiRecs.title_source`).

The live value the button writes is read client-side from the already-computed `variants`/`perChildRows` (`page.tsx:2469, 2515-2521`) — `c.title / c.bullet_1..5 / c.description / c.backend_keywords` per child. Backend re-accepts **each** child's own `c.backend_keywords`.

### "Kept" badge — accepted-green vs optimized-green
Both states derive verdict `DONE` and are byte-identical at the verdict layer — `deriveActionPlan` cannot tell them apart. Drive the badge off `aiRecs.field_locks?.[field]` (mirror the title badge read at `page.tsx:2188/2205-2217, 4546`). Render it in the Row 1 header next to the verdict pill (`page.tsx:3026`) / verdict dot (`page.tsx:3001`) as a **visually distinct chip** (slate/violet "Kept — accepted current"), **not** the green "Optimized" treatment. The badge is advisory, layered on the derived verdict — it must **never** live in `action_plan.verdict` (overwritten every serve, `route.ts:1471-1487`). `field_locks` must be **selected in the GET payload** and **carried onto `rec`** on both POST paths (mirror `rec.title_source = titleSourceOut` at `route.ts:1186`) so the badge survives a whole-audit and a reload.

### Disabled when unshipped
Disable **Keep current** when there is no live value to keep — mirror the title Lock button's `disabled={!titleLockInput.trim()}` (`page.tsx:2201`). Source the check from live `listing_content`/`perChildRows` presence, not from a possibly-empty recommendation. Rationale: `deriveActionPlan` treats an empty cache as **NOT COMPARED** (`pushFields.ts:381`); keeping with no live value across all children leaves `compared==0` → verdict stays `REPLACE` (never green) → the button would appear to do nothing.

### Kept + green → offer Unlock, not Ship + Keep
Once a field is locked+green, **replace** Keep current (and hide Ship's redundant re-offer for that field) with an **Unlock** button (mirror the title Unlock at `page.tsx:2205-2211`), so the card never simultaneously offers Ship and Keep on an already-kept field.

---

## 7. Coherence & semantics

- **Green card ≠ moved score.** Card verdict (`item.verdict`, derived) and the coverage/SEO score (`score.overall_score`, `page.tsx:2013`, computed independently from live `listing_content`) are architecturally separate. "Keep current" leaves the live value unchanged, so the score **correctly does not move**. Add **no** code path that nudges `overall_score` on accept.
- **The badge is the guardrail against "green above a flat score reads as a bug."** A kept-green card must read **"Kept — accepted current, no score change"** with a tooltip: *"This value was kept as-is; it did not change your keyword coverage score."* This pre-empts the inverse of "shipped but still red" — "accepted but score flat" — so the flat score reads as expected, not broken.
- **Coverage-delta disclosure (backend especially).** Before/at Keep current on backend, surface what indexing is being forgone using the **same live `isCovered`/coverage-core count** the Intelligence "Present In" tab uses (`page.tsx:3797`): e.g. *"The recommended backend indexes N more keywords — keeping current leaves them unindexed."* Provide the discoverable **Unlock** affordance so a frozen low-coverage value is reversible.
- **No three-screen disagreement.** The score ring, RANK TOP panel, and Intelligence "Present In" tab all still read the one live haystack via `isCovered` and stay mutually coherent — this feature touches only recommendations, not the live haystack. The only new divergence is *card-vs-score*, resolved by the badge copy above.

---

## 8. Per-child / multi-design

Recommendations live in one row per parent: broadcast columns + per-child overrides (`per_child_titles`/`_bullets`/`_descriptions` JSONB, migrations 017/033) + backend as per-child JSON-TEXT in `recommended_keywords`. `resolveProposed` (`pushFields.ts:132-175`) is the single seam: keywords strictly per-SKU; title/bullets/description **prefer** the matching `per_child_*` entry then fall back to broadcast.

- **Backend keywords — re-accept each child's own live value.** Read every child's live `backend_keywords` from `listing_content` via the deduped `-FBA`-preferred set (`loadListingRowsForPresence`, `loadListingContent.ts:22-35`; `dedupByAsin`, `pushFields.ts:219-226`), rebuild `per_child_keywords` **entry-by-entry**, re-serialize into the `recommended_keywords` TEXT-JSON, and key `field_locks.keywords` **per SKU**. Keywords are per-**ASIN** — dedup twins so a stale FBM twin's backend is not read. A single broadcast string would leave divergent children RED forever or corrupt the per-child structure.
- **Multi-design bullets/description/capacity titles.** Snapshot each child's live value into `per_child_<field>` (or clear `per_child_<field>` so the broadcast wins) — writing only broadcast `recommended_<field>` is insufficient because `resolveProposed` prefers the (possibly stale) per-child entry. Mirror how the title guard keeps `per_child_titles` (`route.ts:1180-1181`).

---

## 9. Edge cases

| # | Case | Required behavior |
|---|---|---|
| 1 | **Concurrent keeps on different fields (JSONB lost update).** `field_locks` is a map needing read-modify-write; two tabs each write the whole object → second clobbers first. | **Never** do client/route-side whole-object RMW. Merge server-side atomically via RPC: keep = `field_locks = coalesce(field_locks,'{}'::jsonb) \|\| jsonb_build_object($field,$val)`; clear = `field_locks - $field` (or drop a nested key). Regression test: two interleaved keeps, both survive. |
| 2 | **Live moves after a lock → "Kept + RED".** A content re-sync / out-of-band push / channel edit changes `listing_content`; frozen `rec` ≠ new live → card derives RED while showing the Kept badge. | **Lock semantics = "track live" (self-healing).** On GET heal-on-read (`route.ts:1471-1487`), if `field_locks[field]` is set, **re-snapshot `recommended_<field> := current live`** before/within derive so it stays green and the badge stays truthful. Do **not** ship a frozen-stamp that can contradict itself. |
| 3 | **Reject after already shipping the new version.** With "previous = current live, no history", once the new suggestion is shipped, live == new value; Keep current now snapshots the just-shipped value (a no-op green), not the pre-ship value the label implies. | **Label is honest:** "Keep current" = "keep whatever is live right now." After a ship that is the shipped value; there is **no revert to a pre-ship value** (that would require the per-field history explicitly deconverged away — §10). When live already == the new suggestion, the button is a no-op → **disable/relabel** (nothing to keep). |
| 4 | **Own-regen clear skipped when stored row absent / falls back to FULL path.** The title clear lives only on the partial early-return path on the premise a locked row always routes partial; a generalized field whose regen falls back to FULL (`route.ts:578-585`) would leak the lock. | Guarantee per field: the FULL-path preserve condition is `locks[field] && regenerate_section !== field`, so a field's **own** regen on the full path is **also** covered (it does not preserve the field being regenerated). Implement the clear on the partial path **and** rely on the full-path condition skipping `regenerate_section===field` — both, so own-regen clears regardless of route. Test both routes. |
| 5 | **Stale `per_child_<field>` defeats a broadcast-only keep.** `resolveProposed` prefers per-child → stale per-child value still resolves → card stays RED after keep. | Keep handler and preserve must write **both** `recommended_<field>` and `per_child_<field>` (or clear per-child) from the live value. Cover a multi-design family in tests. |
| 6 | **Scrubbed-vs-unscrubbed re-divergence** (open Task #56). Recs are trademark-scrubbed on serve (`route.ts:1460-1463`); live cache may hold the unscrubbed value → a kept value stored scrubbed compares unequal → heals back to RED. | Snapshot the kept value in **exactly the form `deriveActionPlan` compares** (match the cache side), or route through the same `squashEquals`/`kwCompare` normalization (`pushFields.ts:257-261, 318-321`). Test: keep a field with a scrubbed token, assert DONE on the next GET. |
| 7 | **Empty-cache no-op / false green.** Keeping a field with no live content leaves `compared==0` → never DONE. | **Button disabled when unshipped** (§6). Hard rule. |
| 8 | **Byte-different-but-squash-equal live value.** Already derives DONE. | Keep is a harmless no-op; optionally short-circuit client-side using `squashEquals`/`kwCompare` parity so the button reflects "already matches." |
| 9 | **Audit-log CHECK swallow.** `action:'keep'` violates migration-037 CHECK → silently dropped. | Log `action:'edit'` with `'<field> (kept)'` / `'(unlocked)'`. Best-effort, non-blocking. |
| 10 | **Unlock semantics.** After unlock, `rec` still == live → card green minus badge, indistinguishable from optimized-green. | Specify: unlock removes only lock+badge, leaves `rec` (green) untouched; next Regenerate produces a fresh suggestion. Button copy states unlock does **not** restore a prior AI suggestion (no history). |

**Dual-write-path invariant (applies across #4/#5/#10):** PRESERVE lives on the FULL path (generalize `route.ts:1160-1186` into a loop over `field_locks`, restoring `recommended_<field>` + `per_child_<field>` before `deriveActionPlan` at `route.ts:1216` and before `dbPayload`, carrying `rec.field_locks` for the badge). CLEAR lives on the PARTIAL early-return path (generalize `route.ts:782-785` so `sec ∈ {title,bullets,description,keywords}` deletes `field_locks[sec]` via a separate best-effort update). Both must be implemented — the partial path returns early (`~813`) and never reaches the full path; a bullets-only regen must **preserve** a description lock **and** clear a bullets lock.

---

## 10. Non-goals (YAGNI)

- **No per-field version history.** "Previous" is defined as the current LIVE value (last shipped) only. There is no stored trail of prior recommendations or prior live values, and no "revert to the version before the last ship."
- **No re-push on Keep current.** The value is already live; the endpoint never calls Amazon. (The card greens purely by derivation.)
- **No score movement on accept.** Accepting never nudges `overall_score`.
- **No new `field_locks` for title.** Title stays on `title_source`; do not migrate it or double-write.
- **No eight per-field columns.** One `field_locks` JSONB column, one migration.
- **No new `listing_change_log` action value.** Reuse `action:'edit'`; do not widen the CHECK constraint.
- **No client-stamped verdict.** Green must come from a real `recommended:=live` write; never stamp a client verdict (it heals back to RED).

---

## 11. Testing

**Unit — `deriveActionPlan` parity:**
- Keeping a field sets `recommended==live` → `DONE`/green (prose via `squashEquals`, backend via `kwCompare`).
- Empty-cache field → `compared==0` → stays `REPLACE`; button-disable gate honored.
- Multi-design family: keep writes `per_child_<field>`; a stale broadcast-only write would still ship the per-child value (assert it does not).
- Backend: each child's own live `backend_keywords` re-accepted per SKU; a divergent child does not get a sibling's keywords; twins deduped by ASIN.

**Unit — lock lifecycle (both write paths):**
- Whole-audit regen with a bullets lock set → bullets `recommended` restored from stored/live, lock + badge survive, `field_locks` NOT in `dbPayload`.
- **Bullets-only regen preserves a description lock AND clears a bullets lock** (the dual-path assertion).
- Field's own regen on the FULL fallback path also clears its own lock (`regenerate_section===field` not preserved).
- Concurrent keeps on two different fields → both locks survive (atomic merge).

**Migration-lag / safety:**
- Column absent → GET renders with `locks={}`, no 500; title lock still preserves (independent select).
- Column absent → full-audit upsert still succeeds (`field_locks` omitted from `dbPayload` and minimal-retry payload).
- Keep endpoint fails loudly when column missing.

**Semantics / re-sync:**
- Live changes after a lock (edge #2) → heal-on-read re-snapshots `rec:=live` → stays green, badge truthful.
- Scrubbed-token field (edge #6) kept → derives DONE on the subsequent GET.
- Audit-log row written as `action:'edit'` with `'<field> (kept)'` and not swallowed.

**Live end-to-end (required):** on a real parent ASIN — Ship → card green → Regenerate (whole audit) → card red → **Keep current** → card **green with the Kept badge**, then run a **whole audit again** and confirm the kept field **stays green + Kept** (preserve guard) while other fields re-audit normally; finally the field's **own Regenerate** clears the lock → card red with a fresh suggestion. Verify LIVE via `buildCommit` in `health.status` (Manus deploy→Publish two-step) before testing on the deployed portal.

---

## 12. Open questions (for the PO)

1. **Backend coverage-delta copy.** Confirm the exact wording/threshold for the forgone-indexing disclosure on backend keep (§7). Is the `isCovered` count from the Intelligence "Present In" tab the number you want shown, and do you want a soft confirm dialog or just an inline note?
2. **Re-sync semantics (edge #2).** Confirmed default is **"track live" (self-heal to stay green)**. Do you ever want the alternative — an explicit "live changed since you kept this" alert instead of silent re-snapshot — for any field (e.g. backend), or is track-live acceptable everywhere?
3. **Unlock button copy.** Preferred label/tooltip confirming unlock does **not** restore the prior AI suggestion (there is no history) — e.g. "Unlock (does not restore the AI version; Regenerate for a new one)."