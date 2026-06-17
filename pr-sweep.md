## The four reports fixed + full adversarial sweep of the recent surface

### Your reports
1. **"Still using MAN/MEN in keywords, WHY?"** — backend search terms deliberately kept both genders under *lean*; under **hard Female/Male** that's now wrong by your definition, so hard selections strip the opposite gender's standalone tokens from every per-child backend string (verified on your exact string: `…darlin mens black men…` → `…darlin black…`; "businesswoman" survives the Male strip — word-boundary safe). Lean keeps both (cross-traffic is the point of lean).
2. **"3 dots instead of a 'regenerating' message"** — the per-section button now reads **"⏳ Regenerating… hold on"** while running.
3. **"The persistent PUSH disappeared… did not complete the TITLE push"** — two parts:
   - **From-fact: your title push DID complete server-side** — 161/162 SKUs carry `THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee, Rodeo Shirt for Women` live right now (1 straggler → Verify → push stale). The #185 server-survival design held.
   - The UI bug: opening a second Ship modal **resets all shared push state** (that's what ate the pill and the tracking). Now guarded: starting any Ship/Auto-Push while a push streams is blocked with a clear message pointing to **Queue in background** (which exists exactly for overlapping pushes — queued jobs run server-side, serialized). Ref-based guard so it can't go stale.
4. **"Push that corrected Style value"** — confirmed end-to-end in code: `Style` is a broadcast-pushable attribute, so the flag row gets the normal **Push** button. One nuance (stated honestly): the Features assembly runs in the **full** audit only — per-section title regen skips it by design. **Your next full "Regenerate AI Audit" produces the Style row.**

### Sweep results (checked systematically, beyond your reports)
- ✅ Gift-bullet recipients under hard Female: "dad/husband/grandpa" correctly survive (gift **recipients** ≠ wearer gender).
- ✅ Title fill vs audience tail ordering, per-section partials on capacity families, queue-path parity with streaming, keyword-plan designName fallbacks — all verified sound.
- ✅ Backend byte floors unaffected by the gender strip (strings shrink ~12 chars, stay >200).
- ⚠️ Known-accepted (documented, not fixed): one **queued** job + one **streaming** push CAN overlap (≈2× SP-API rate; Amazon may 429 individual SKUs — Verify→push-stale recovers). Say GO if you want the queue to auto-pause while a stream runs.
- ⚠️ **Data state on B0FKLGWZ4C right now**: bullets + description recommendations are still the broken-run copy, and the backend keywords you pushed mid-chaos were the broken-run strings (with `mens`). After this deploys: regenerate bullets/description/backend, then re-push backend.

`tsc` exit 0. No migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
