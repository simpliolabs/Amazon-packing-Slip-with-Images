## The last wire: OUR rank → the councils

#179 stored our organic rank and showed it to the **seller** (Rank column + history). This PR makes the **machine** act on it — the honest "no" in the PO's question *"is it completely actionable to the council?"* becomes a yes.

- **Striking-distance tiebreak** in title-candidate selection: a keyword we rank **#11–30** for (page 2 / bottom of page 1) wins the title spot among near-equal opportunity — title placement moves those fastest; #1–10 is already won, #100+ needs more than a title spot. Ties-only, same conservative contract as the Title-Density and outcome-loop tiebreaks; no-op when rank is unmeasured. Final order: `opportunity > title-density > striking-distance > SQP-rise`.
- **Title council brief** now annotates every candidate with rank reality: *"we already rank #6 — defend"* / *"we rank #18 — STRIKING DISTANCE, title placement moves this fastest"* / *"we rank #142"*. The 3 proposers, adversary, and judge all debate with the rank in front of them.
- **Bullets council brief** gains a `CURRENT ORGANIC RANKS` context line — deliberately **separate** from the REQUIRED keyphrase strings, which are verbatim machine-checked by the coverage validator + deterministic backstop (annotating those would break validation).

Ranks populate from each Re-research (4 credits, #179). Until a family has been re-researched, every rank is null and this PR is a strict no-op — zero behavior change.

`tsc` exit 0. Single file.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
