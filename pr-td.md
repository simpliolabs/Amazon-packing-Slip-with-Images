## Two things: G3 (Title Density) + a critical save

### ⚠️ The save — Re-research would have wiped your imported keywords
`storeAnalysis` deleted **every** keyword row for the ASIN before writing a fresh native sync. Click the new **Re-research** button (#177) once → your 44 imported keywords (#176) gone. Caught during adversarial planning before anyone pressed it. Now the delete **excludes `data_source='import'`**, and the write is an **upsert** — on a keyword collision the fresh native row wins (live presence flags + real metrics), which naturally "graduates" an imported keyword to native once our sources start seeing it.

### G3 — Title Density, end to end
The H10 metric we were parsing and discarding: **how many page-1 competitors have the exact phrase in their TITLE**. TD 0–2 with real volume = an open lane your 75-char title can own ("college essentials", 33k/mo, had **TD 0** in your Cerebro run).

- **Migration 025** (1 line): `keyword_analysis.title_density integer` — run before the next import.
- Import captures + persists it (blank/"-" tolerated; friendly "run migration 025" error if missing).
- **Title generator tiebreak**: among near-equal opportunity, candidates with TD ≤ 2 and volume ≥ 500 win the spot — same conservative ties-only contract as the outcome-loop tiebreak, no-op for native keywords (they don't carry TD).
- **Intelligence tab**: violet **`TD 0 · title win`** chip on qualifying keywords, tooltip explaining the play.
- Defensive: native syncs retry-without-column if 025 isn't applied yet — the new column can never break keyword sync.

`tsc` exit 0.

### Requires
```sql
ALTER TABLE keyword_analysis ADD COLUMN IF NOT EXISTS title_density integer;
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
