## #79 — Per-section regenerate: refresh ONE section in ~1 min instead of re-running the whole 3–4 min audit

Each Apply-tab card (TITLE, BULLET 1, DESCRIPTION, BACKEND KEYWORDS) now has a small **↻ Regenerate** button that re-runs **only that section's agent**:

- **Anchored on what you approved**: bullets regenerate against the *stored* recommended title (not a fresh one), description/backend against the stored title + bullets — a section refresh can never drift the rest of the listing.
- **Only that section is written back**: the stored recommendation row keeps every other field untouched; the section's action-plan card flips to REPLACE with the new copy.
- **What's skipped**: the audit pass, the other agents, enum validation, noise-persist, live re-score (live content didn't change — the scores still describe it).
- **Cost/time honestly**: title/bullets keep their full quality councils (proposers → adversary → judge), so those partials run ~1–2 min; description/backend ~30–60s. Either way a fraction of the full chain, and the OpenAI spend drops proportionally (your LEAN ask).
- **Quality unchanged**: the agents, prompts, validators, and backstops (capacity, color, motif, role-leak, gift bullet, design anchor, ≤75 cap) are the same code paths as the full run — the partial just doesn't run the *other* agents.
- **Safe fallback**: no stored recommendation to anchor on → it quietly runs a full audit instead, so the button never strands you.

The full **Run/Regenerate AI Audit** button is untouched for whole-listing refreshes (and is what re-runs the audit/action-plan reasoning).

`tsc` exit 0. No migration. (This is the per-section half of task #79; the 7-day cooling-lock refinement remains separate.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
