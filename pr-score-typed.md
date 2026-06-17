## PO: "you are suggesting a new TITLE, but scoring it at 17/25" — reproduced + fixed

**The Check-score button was scoring the WRONG string.** `scoreListingContent` derives its title via `sellerBaseTitle` = longest-common-prefix of the **children's live titles** (built to strip Amazon's per-SKU " -Color-Size" suffixes). With 100+ identical live children, that consensus silently **replaced the typed draft** — the compliant 74-char suggestion was scored as the live 82-char title: −5 (>75 band) −3 (front-load miss on the live "TShirt" spelling) = **17/25**. Live-reproduced via `POST /score-title`: the returned issue literally said *"Title is 82 chars"* for a 74-char input.

**Fix:** the scoring copy overrides every child title with the typed one, so the consensus IS the typed title; bullets/keywords/A+ stay live. The number now answers exactly *"what's my score if I ship THIS title"* — the 74-char draft scores clean on length + front-load.

**Also (PO: "doesn't tell me HOW many characters"):** the Variant Cohesion "UPDATE ALL N VARIANTS TO" box now shows **X/75** (green ≤75 / amber over), and every current-value version row gets a compact `Nc` chip. The Ship-Title editor already counts X/75 since #167 — the "/200 · under 80" in the screenshot is a **stale browser bundle**; hard-refresh (Ctrl+F5) shows the new counter.

`tsc` exit 0. UI + one route, no scorer-formula changes needed — the formula was right, the input was wrong.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
