## The 82 "invalid value for 'neck'" failures: a transient blip resolved the product type as generic PRODUCT, and every patch validated against the wrong schema. + a Stop button.

### What actually happened (it was never trying to ship the word "neck")
The value was "Crew Neck" the whole time. `getProductType` falls back to the generic **'PRODUCT'** type on ANY transient SP-API failure — and you pushed minutes after a deploy restart (cold caches, the classic blip window). With `productType: PRODUCT` on the patch body:
- Amazon validated `neck` against the wrong type → **"The provided value for 'neck' is invalid" × 82** (your second screenshot), and
- the schema guard produced the false **"Neck is not a valid attribute for this product type (PRODUCT)… It shouldn't have been recommended"** (your first screenshot) — blaming a perfectly correct recommendation.

Nothing was written to Amazon (validation rejected = no write), so there's nothing to undo — but all three composite pushes (Neck/Closure/Sleeve) failed today for this reason and need a re-push after this deploys.

### Fix 1 — strict product type for detail pushes
- New `tryGetProductType`: returns the REAL type or null (with one internal retry) — never the 'PRODUCT' fallback.
- `loadDetailContext` resolves it ONCE, strictly, and carries it on the context — so the schema check, the enum coercion, the value shape, and the per-SKU patches all use the SAME type (previously the preview and the push resolved independently and could disagree).
- If Amazon won't return the type right now, the push **refuses cleanly**: "Amazon didn't return this listing's product type just now (usually a transient hiccup right after a deploy). Nothing was pushed — try again in a minute." No more 82-row failure cascades off one blip.
- The generic fallback remains only for the universal fields (title/bullets/description/keywords) where it has always been safe.

### Fix 2 — "NO way to cancel when it starts"
A **■ Stop push** button during any streaming push. It stops the server loop between SKUs: *"Stopped by you — N accepted before the stop stay pushed; M SKUs untouched."* Already-accepted SKUs stay (Amazon has them — that's physics, not policy). A stopped push correctly does NOT mark the action card DONE and does NOT overwrite the stored recommendation (a cancelled title push must not adopt the override).

`tsc` exit 0. Three files, no migration. Queued background jobs are unaffected (they don't stream; cancel-before-start by not queueing — job-level cancel can come later if you want it).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
