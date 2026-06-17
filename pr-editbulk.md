## Edit a Product Detail value before the bulk push

PO: *"What if a recommended detail value is wrong — how do I change it before Auto Push?"*

The **Auto Push — Product Details** modal is now editable per field:
- **Enum fields** (Department, Fit Type, Neck, Sleeve, Closure, Material…) → a **dropdown of Amazon's accepted values**. Wrong "Womens" Department? Pick "Unisex" before pushing.
- **Free-text fields** → an inline text input.
- Editing is disabled once the run starts (read-only during/after).

Each (possibly-edited) value is sent as a per-field `detail_overrides` entry. The server re-runs the SAME validation as a single push (`loadDetailContext` → enum coercion): a value that isn't an accepted Amazon member is **flagged and that field is skipped with a reason — never pushed**. Values show as human labels and coerce back to the API token server-side.

This complements the single-field Ship picker (#207) — now you can correct values inline in the bulk flow too, instead of one-at-a-time.

`tsc` exit 0. No migration. Server: `detail_overrides` plumbed through the `details_bulk` executor's pre-flight (the validation gate already existed).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
