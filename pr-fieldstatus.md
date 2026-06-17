## Per-field "Verify live" on every field + audit/ship dates (PO transparency asks #1 & #2)

### 1. "Verify on Amazon / recheck live" on ALL fields — including up-to-date/closed ones
The Verify path only existed inside the Ship modal, and the Ship button only appeared when a field needed updating — so a field showing "up to date" had **no way to confirm Amazon actually applied it** or re-push stragglers.
- Every Variant-Cohesion row (Title, Bullets, Description, Backend) now has an always-present **"Verify live"** button. It opens the existing modal, which reads the LIVE value on every SKU, shows matched/stale, and offers **"Push just the stale"** — exactly the "did it apply? if not, reapply" loop you asked for. (The modal already supported verify when nothing differs; it just had no entry point on settled rows.)
- The row header was restructured from one big toggle button into a flex row so the Verify button isn't illegally nested inside the toggle.
- Product Detail rows already had Verify/Re-push — unchanged.

### 2. Dates — when audited, when each field shipped
- **AI audit date**: "AI audit generated 2h ago" now shows under the Regenerate AI Audit button (from the stored `generated_at`; hover for the exact timestamp).
- **Per-field ship date**: each shippable row (Title/Bullets/Description/Backend + each Product Detail attribute) shows "shipped 3h ago" when it was last accepted by Amazon — sourced from the last `accepted` row in `keyword_push_log` per field. Hover gives the exact local time. Best-effort: if a field was never pushed (or the log table is unavailable), no date shows — never an error.

### Verification
`tsc` exit 0. Backend: one best-effort `keyword_push_log` aggregation added to the recommendations GET (`field_pushed_at` map, keyed `title`/`bullets`/`description`/`keywords`/`details:<spApiKey>` — matching exactly what the push logger writes). Client: relative-date helper + the buttons/labels. No migration. UI-additive; no existing behavior changed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
