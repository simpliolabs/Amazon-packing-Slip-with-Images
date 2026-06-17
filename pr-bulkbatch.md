## Auto Push: batch all attributes PER SKU (one PATCH/SKU) — ~7× fewer Amazon calls, with full failure isolation

PO asked (correctly): pushing N fields field-at-a-time repeats every SKU N times. This rebuilds *Auto Push* to push **all changed attributes for one SKU in a single PATCH**. Single-field Ship is unchanged.

### Efficiency
For a 150-SKU × 7-field family: field-at-a-time ≈ **7 × 150 × 2 ≈ 2,100** Amazon PATCH calls. Per-SKU batch ≈ **150 × 2 ≈ 300** + a few calibration probes. ~7× fewer calls, ~7× faster, far less throttle/deploy-restart exposure, and **one** re-score instead of seven.

### How it stays safe (the karpathy risk pass you asked for)
Amazon validates a submission **atomically** — one bad attribute fails the whole SKU. So the batch is **preview-gated with per-field fallback**, and the whole run is **idempotent**:

| Scenario | Handling | Recovery |
|---|---|---|
| Field unmapped / not pushable | pre-flight `loadDetailContext` → excluded with reason; others proceed | — |
| Enum-invalid value | excluded → "set via single Ship picker" | single Ship |
| Attr absent from this product type | `attributeExistsInSchema` drops it, per-field note | — |
| Composite calibration fails (all forms rejected) | that field excluded, **others proceed** | fix value, re-run |
| productType blip | strict resolve; all-excluded → clean error | re-run |
| **Batch preview INVALID** (1 bad of N) | **per-field fallback for that SKU** — good land, only the bad one fails | re-run bad field |
| Batch live fails after valid preview | per-field fallback for that SKU | re-run |
| Rate-limit | one 250ms gap per SKU (not per field); far fewer calls | re-run failed |
| 502 / deploy mid-run | accepted SKUs stay; client shows idempotent re-run note | **re-run — only still-wrong SKUs touched** |
| Stop pressed | checked between SKUs; accepted stay; partial fields never marked falsely done | re-run remaining |
| SKU read fails | treated as "changed" → pushed, preview guards correctness | — |

**Idempotency is the backbone:** each SKU is read first (one GET, all attributes) and only the fields that *differ* are batched (`changedDetailFields`). So any partial failure is fixed by simply re-running Auto Push — already-correct SKUs are skipped. This is what makes every row in the table above recoverable.

### Implementation
- `executeBulkDetailsPush` (new): pre-flight per field → resolve SKU set once (`expandDetailSkuSet`, extracted from `loadDetailDiff` so both paths share one tested impl) → read each SKU once (`fetchSkuDetails`) → per-SKU batch via `patchSkuMulti` → `pushPerFieldFallback` on batch-invalid → write-through + one re-score. Calibration (#210/#211) reused per composite, cached.
- Route: `field: 'details_bulk'` + `detail_fields[]` → the new executor. Cancel (#209) works between SKUs.
- Client: `runBulkPush` is now ONE streamed call; maps the per-field tally back to the modal rows; a **Stop** button; gateway-class halt with the idempotent re-run message.

### Verification
8/8 unit tests on `changedDetailFields` (the idempotency core): empty SKU → all changed; fully-correct → none; partial → only the still-wrong; trim/case/unknown-current/empty-desired edge cases. `tsc` exit 0. No migration. Per-field logging keys (`details:<spApiKey>`) unchanged, so #212's ship-dates + Verify-live keep working.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
