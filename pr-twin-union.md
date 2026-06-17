## Verification follow-up: presence flags now OR across FBA+FBM twin rows

Caught while **live-verifying #186's claims** (your "verify all claims" ask — the verification worked):

After #186 deployed, B0FK8NM9RT's flags were real but came from **one** of each ASIN's twin rows — and the row picker chose the FBM twin, which carries a **stale** title (`…Comfort Colors Shirt … Blue Spruce`). The FBA row's actual title (`THE CEO I Could Be Meaner Tshirt Comfort Colors Graphic Tee for Men & Women`) was shadowed, so `comfort colors tshirt women` (36,635/mo) still showed no **T** while `comfort colors blue spruce` did. A twin lottery, visible exactly when twins diverge — i.e. before you push.

**Fix:** presence is now checked against **every** twin row individually and the flags are OR'd (`checkPresenceAny`). Deliberately *not* a concatenated-text check — half a phrase in one row plus half in the other must not fake a match neither row has. Applied to the live recompute **and** the research engine; the title seed keeps using one representative row.

After this deploys, B0FK8NM9RT shows **T** for `comfort colors tshirt women`, `comfort colors tshirt men`, `comfort colors t-shirts`, etc. (verified locally with the exact predicate against both twin rows). Once you ship the broadcast title, the twins converge and OR-of-rows equals either row.

`tsc` exit 0. No migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
