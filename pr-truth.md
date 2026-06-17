## "Super BAD keywords — how did the council approve this?" — honest answer: backend keywords never had one. Now they do (deterministic).

### What you caught
`…cropped pocket solid plain black for cotton oversized blank…` in every child's backend. #205's gate checked **bytes and differentiation** — not truth. The core is token-packing from Jungle Scout's top *category* phrases, and the "comfort colors" niche's biggest terms describe products you don't sell: "cropped comfort colors", "pocket tee", "blank tshirts", "plain black tshirt". The same junk was in the old pushed strings too ("plain t confort boxy rodeo pocket white cropped blank…") — this was never gated, by anyone.

### The fix — a token truth gate (the backend "council", deterministic)
Every word entering a backend string (core, LLM fill, byte-fill) now passes `banBackendTok`:
1. **Ungrounded style/cut claims** (`cropped, pocket, boxy, oversized, plain, blank, solid, slim, fitted, tall…`) and **garment types** (`tank, hoodie, sweatshirt…`) are banned unless the SELLER'S OWN text (canonical/rep title, design name, product type) corroborates them — the same trust rule as the garment (#196), color (#189), and motif (#194) gates. A family whose canonical says "Oversized Boxy Tee" keeps those words. "blank"/"plain" also attract wholesale blank-shirt buyers — the wrong customer for a printed graphic tee.
2. **Sibling variants' colors** (`black`, `white`) banned from the shared core on multi-color families — each child's own color still arrives via its per-color tail ("scarlet red vibrant" stays).
3. **Hard-lean opposite-gender keywords filtered from the pool BEFORE placement** (#203 symmetry: the scorer no longer demands them; the generator no longer places them). This also kills the interior orphaned "for" at its source — "black t shirts for men" never enters, so there's nothing to strip mid-string.
4. **Stray single letters** from "t-shirt" tokenization (`t`, `s`) banned.

The design-name anchor and the per-color tails are exempt (identity and per-child color are supposed to be there).

### Verification
33/33 unit tests: every token from your report is banned under the Darlin' setup; `graphic, tee, cotton, cowgirl, country, western, rodeo, womens, darlin, vintage, gift` all survive; grounding flips correctly (canonical "Oversized Boxy" keeps both; a tank family keeps "tank"); male-lean mirror. `tsc` exit 0. No migration.

After deploy: ↻ Regenerate backend once more — expect ~244-250 bytes of clean, true terms + per-color tails. The #205 quality gate still enforces bytes/differentiation underneath.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
