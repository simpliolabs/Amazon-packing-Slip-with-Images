## 🚨 Fix the Female-regen disaster: catalog blank-boilerplate can no longer hijack the listing

> PO: Female selected → "THE CEO Darlin' **Men's** Heavyweight Crewneck **Sweatshirt** Cotton Blend **Pullover**" on a women's-leaning T-SHIRT family. Score crashed to 59.

### Root cause, from the persisted data
The keyword side worked perfectly (the plan is all female terms). The poison came from your **Amazon catalog attributes**: they carry the blank manufacturer's boilerplate — literally "Men's Heavyweight Crewneck Sweatshirt, Cotton Blend, Pullover" — and the pipeline treats attributes as **trusted product facts**. With the keyword pool re-weighted, the spec string won the title; the audit then echoed the same demographics into the detail rows (**Department: "Mens", Target Gender: "male"** — on a Female run!).

### Three deterministic guards (all verified against your exact broken strings)
1. **Garment-type truthfulness** — a garment word (sweatshirt, hoodie, pullover, fleece, tank…) may only appear if YOUR titles or the SP-API productType corroborate it. Contradicting attribute strings are **scrubbed before they reach any brief**, and a strip backstop covers title, bullets, and description. Your broken title → `THE CEO Darlin' Women's Heavyweight Crewneck Cotton Blend for Women`; a *real* sweatshirt family is untouched.
2. **Hard-audience enforcement** — selecting **Female** (or Male) outright now guarantees: no opposite-gender word survives anywhere in title/bullets/description (deterministic swap, "Men's crew" → "Women's crew"), and the title **must** end "for Women". Lean selections stay unisex-worded, as designed.
3. **Audit demographics obey the selector** — Department/Target Gender detail recommendations are forced to match your Audience selection (Womens/Female, Mens/Male, Unisex for leans); the enum coercion downstream snaps them to this product type's exact accepted values.

### After merge
On B0FKLGWZ4C: keep **Female** selected → **↻ Regenerate title** (or full audit). Expect a Darlin'-anchored, t-shirt-true, women's title ending "for Women". The current stored recommendation is the broken one — regenerating replaces it.

`tsc` exit 0. One file, no migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
