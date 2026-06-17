## The full Ship → Verify lifecycle for Item Highlights — tested live, and Amazon's wall found

Ran the complete chain on B0F86LPSHZ (PO-authorized):

| Stage | Result |
|---|---|
| Generate (post-#169) | ✅ deterministic, comma-separated keyword phrases, 118 chars: `mini small sticky notes 1.5x2, sticky notes assorted sizes, assorted post it notes, assorted sticky notes, post it set` — mapped to `title_differentiation`, pushable |
| Preview (GET) | ✅ HTTP 200, proposed value correct, changed=10 |
| **Push (POST, confirm)** | ❌ **Amazon refused all 10 SKUs at VALIDATION_PREVIEW**: *"This attribute 'Item Highlight' is currently unsupported."* |
| Verify (live read-back) | ✅ behaved correctly: 0 matched, live empty, nothing corrupted |

**Conclusion:** staged rollout on Amazon's side — the attribute is in the product-type schema **and** the Seller Central form, but **Listings-API writes stay closed until the July 27, 2026 launch**. Our rails (map → preview → validate-first push → verify) did exactly their job.

## What this PR fixes

1. **No Features dock for a gap the seller cannot close** — `isWriteBlockedPreLaunch()` excludes a pre-launch empty Item Highlight from `productDetailsGaps` at **both** count sites (sync scorer + regen-time override, keeping regen score == next-sync score). From July 27 the helper returns false and the field counts — and pushes — like any other, **zero code change on launch day**.
2. **Plain-English push error** — Amazon's *"currently unsupported… refer to the tool tip"* now carries: *"Amazon hasn't opened API writes for this attribute yet (full launch July 27, 2026). The value is generated and saved; push it again once Amazon enables the field."*

The row stays visible in the panel and in the Auto Push list with its generated value — the moment Amazon opens writes, the same button ships it.

`tsc` exit 0. Self-adversarial: bounded date-gate risk documented (early opening → pushes work, dock just stays off till 7/27; delay → dock on but the message explains); the LIVE-patch path can surface the same Amazon string post-preview — accepted minor.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
