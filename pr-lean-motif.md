## No more "Heart" fabrications + your Audience selector (Male / Female / Lean / Unisex)

### 1. Where "Heart" came from — and the backwards trust that let it in
Verified from data: **zero** "heart" keywords in the set (0/100) and none in your old title — the motif came from the **vision image scan** (it read a heart into the Darlin' script font). Worse, the grounding system trusted vision but **never included your own canonical title** — so your real descriptors ("Country Western", "Vintage Rodeo") were dropped as "ungrounded" while the hallucinated "heart" sailed through. Fixed three ways:

- **Trust hierarchy righted**: your canonical + live titles now ground the keyword pools (your words about your own product are evidence).
- **Motif words get a stricter test**: a curated list of visual-claim nouns (heart, sunflower, skull, leopard…) must appear in **your own text** (title/design name) — vision alone is never sufficient for a claim about what's printed.
- **Deterministic backstop**: any un-corroborated motif is stripped from the final title and bullets. Tested against your exact case: `…Comfort Colors Heart Graphic Tee…` → `…Comfort Colors Graphic Tee…`, while a genuine "Sacred Heart" design (in the seller's title) survives untouched.

### 2. Audience selector — "the Darlin' shirt is more of a WOMEN design"
New **Audience** dropdown right next to Run/Regenerate AI Audit: `Auto / Unisex / Lean Female / Lean Male / Female / Male`. Saved per listing (migration 029); the next audit reads it and it influences the **entire listing**:

- **Keywords**: gendered keywords are re-weighted across *every* pool — title, bullets, description, backend. Lean Female boosts "womens…" keywords 1.2× and demotes "mens…" to 0.8× (hard Female demotes to 0.5×). Sorting only — nothing is deleted, backend still carries both.
- **Title tail**: Female → "for Women"; Male → "for Men"; Lean/Unisex keep "for Men and Women" (lean shifts the substance, not the label).
- **Auto** (default) = today's behavior, derived from your listing + keywords.

Set Darlin' to **Lean Female** (or Female) → Regenerate → the title leads with women's keywords while staying truthful.

### ⚠️ Migration 029 (Supabase SQL editor — skipping is safe, selector just errors politely until run):
```sql
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS audience_lean TEXT;
NOTIFY pgrst, 'reload schema';
```

`tsc` exit 0. Verified against the real Darlin' strings (strip + regex tests in repo).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
