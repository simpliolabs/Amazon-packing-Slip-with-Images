## 🚨 Fix the B0GCF11RKL crash + repair #184's corrupted strings — merge before using the queue

Two production repairs, verified from fact:

### 1. The crash ("Not loading: /fba/listing/B0GCF11RKL")
I fetched the stored recommendations from prod: the audit AI emitted **`Additional Features` as an array** — `["Water Proof","Shock Proof","Temperature Proof"]` — and every consumer assumes a string. The page's Auto-Push eligibility check called `.trim()` on it → `"(e.recommended_value ?? '').trim is not a function"` → the whole page died.

**Foundational fix** (the ghost-parent lesson — fix the boundary, not one call-site): a shared `detailValueToString()` normalizer (arrays → `"Water Proof, Shock Proof, Temperature Proof"`, numbers → strings) applied at **all four boundaries**:
- pipeline write (future regens persist clean values),
- **recommendations GET (heals ALL historical rows instantly — B0GCF11RKL loads again on deploy, no regen needed)**,
- the push path (`loadDetailContext` would have thrown server-side on Push too),
- Verify on Amazon.

### 2. #184's mojibake (self-caught while fixing #1)
The #184 file assembly used PowerShell `Get-Content`, which misread the UTF-8 source as ANSI — every non-ASCII character in `pushExecutor.ts` was corrupted, **including user-facing messages** (e.g. "Nothing to push â€" every SKU…" is live right now). Rebuilt the file from pristine git bytes via node with asserted replacement counts; all push-queue files now scan clean. Functionally identical to #184 — this is a byte-level repair plus the crash fix above.

`tsc` exit 0. No migration needed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
