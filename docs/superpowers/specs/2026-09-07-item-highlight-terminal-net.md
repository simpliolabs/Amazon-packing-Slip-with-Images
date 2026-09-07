# GOAL / PLAN / ADVERSARY — the Item Highlight has no terminal net on the bytes it ships

approved: true   <!-- PO 2026-09-07, verbatim "B: yesm go" — fix the Item Highlight terminal nets first, ahead of the writer. The writer ruling ("2+3", same day) is NOT in scope here; this spec is what that ruling turned out to require first. -->

## 0. WHY THIS EXISTS (the finding, not an opinion)

The PO ruled on 2026-09-07, verbatim *"2+3"*: add an LLM writer for this field **under the existing
deterministic nets**, and lower the 107-char floor. Research dispatched to design that writer
(`wf_99196807-8fc`) returned a verdict that changes the order of work, proven by EXECUTION rather
than by reading:

> **The nets a writer would sit under do not exist.** The last pure function before Amazon
> (`capItemHighlightRepeats`) returns a **218-character** line unchanged and a line repeating one
> word **four times** unchanged. `validateItemHighlights` — which already implements off-season,
> promo, capacity, third-party-brand and sentence-shape rules — is called from
> `check-item-highlight/route.ts` only, never from the production compose or push path.

So "add a writer under the nets" describes a system this repo does not have. There is no *add a
writer* change; there is a **rebuild the terminal nets, then consider a writer** project, and only
the second half had been scoped.

**Two further facts from the same research, both load-bearing and both refuting things this repo
currently asserts in writing:**

1. **The field is SHOPPER-VISIBLE.** Live DOM probe, 2026-09-07, on our own listings: it renders
   inside `#centerCol`, in `document.body.innerText`, ~366×60 px under the h1 — on `B0H9VDCBZJ`
   (124 chars) and `B0DMXMH266` (122 chars). This refutes `contentContract.ts:43-45` ("never
   anywhere a shopper looks") and `handoff/SELLER_PROFILE.md:248` ("renders ONLY in the HTML
   `<title>` … not conversion copy"). `contentContract.ts` already contradicts itself 70 lines
   later (`:115`, `:122`: "an INDEXED, **shopper-visible** field … Amazon moved Item Highlights to
   display BENEATH the item name"). **The doctrine is wrong and must be corrected in the same PR as
   the code**, or the next reader re-derives the wrong priority from it.
2. **A material claim ships today with no truth rule at all.** `B0DMXMH266`'s live, visible line
   begins "Polycotton". `PhraseTruthReason` has no material member; `contentTruth.ts:63` says
   material is not read; `enforceFabricTruth` is not wired to this field. Whether that instance is
   TRUE for its blank is unverified — the point is that **nothing checks**.

**Scope boundary, stated plainly.** This spec fixes the nets. It does NOT add a writer, does NOT
move the floor, and does NOT re-litigate "2+3". Both of those decisions get better evidence once
the nets exist and the live pool has been read (the pool query is with the PO).

## 1. GOAL

**What we are achieving:** every Item Highlight that reaches Amazon has passed ONE deterministic net
that judges the FINAL BYTES — on every path, whether the bytes came from the composer, a stale
stored row, a PO hand-edit, or (later) a writer.

### FINAL PRODUCT — observable

| Property | Requirement |
|---|---|
| One net | ONE function judges a finished line. Every producer and the push seam call it. No second rulebook. |
| On the shipped bytes | It runs on what is about to be written to Amazon, after every other stage — not on candidate phrases. |
| Total | It cannot fail open. A line it cannot make compliant is REFUSED, never truncated into a lie or shipped as-is. |
| Honest doctrine | `contentContract.ts` and `SELLER_PROFILE.md` state that the field is shopper-visible, with the probe as evidence. |

**Non-goals.** No LLM. No floor change. No new hold semantics. No change to which designs compose
today — Phase 1 and 2 must be **byte-identical on every existing fixture**, because every rule they
add is one that today's producer already satisfies.

## 2. PLAN — three phases, each independently shippable and revertible

### PHASE 1 — the outright bugs, and the floor at the seam (no new rules)
`capItemHighlightRepeats` (`productDetailAttrs.ts:612-650`) splits on `,` and then:
- **H10** the ≤2-per-word cap **fails open** when the line has no comma — every word is in one
  segment and the per-segment counter never trips;
- **H11** the 125-char cap **fails open** the same way: `if (next > max && capped.length >= 1) break`
  keeps the first phrase whole however long it is;
- **H12** a two-clause prose line is **silently amputated** — measured: 186 chars → 88 chars, second
  clause deleted, result now *below* the floor and nothing notices.
- **H13** `classifyStoredIhLine` (`:600-610`) never checks the floor, so an under-length stored line
  is classified `ok` and is pushable.

*Fix:* the cap operates on WORDS across the whole line, not per comma-segment; the length rule
refuses rather than truncates; `classifyStoredIhLine` gains an `under-floor` classification.
*Verify:* every existing composed-bytes fixture byte-identical; new pins for a comma-less 218-char
line, a 4×-repeat line, the 186-char two-clause line, and an 80-char stored line.

### PHASE 2 — wire the rules that are already written but unreachable
`validateItemHighlights` (`listingPipeline.ts:2262-2296`) already implements off-season terms,
promo/pricing, hardcoded capacity, generic third-party brands, and sentence shape. It is reachable
only from `check-item-highlight/route.ts`. Move it (or its predicate half) into the pure layer and
call it from the ONE net of Phase 1, so the compose path, the Regen route and the push seam all get
it. Trademark (`scrubTrademarks`) and celebrity (`celebrityGuard`) scrubs — today generation-time
only — must also run at the detail push path (`buildDetailPatchValue`).
*Verify:* byte-identical on every fixture (today's lines already pass these rules); a pin per rule
proving it now fires on the PUSH path, not only in the checker route.

### PHASE 3 — the genuine line-level truth net (the one a writer would need)
`applyTitleTruthNet` already takes a field-agnostic `PhraseTruthCtx`. Generalise it to segment a
comma-joined Item Highlight line and judge each segment with `phraseTruthVerdict`, plus a NEW
`material-lie` rule beside `weight-class-lie` grounded in `blank_specs.material`.
*Verify:* the live "Polycotton" string on `B0DMXMH266` is judged against its blank and the verdict
recorded; every existing fixture unchanged; the rule fires on a fabricated composition.

## 3. ADVERSARY

- **"Phase 1 changes shipped bytes."** It must not, and that is the acceptance test: every existing
  composed line is byte-identical, because today's producer emits comma-separated phrases that
  already satisfy every rule. If a fixture DOES change, the change is a real defect being corrected
  — report it, do not re-fixture. *(This is the discipline that caught three defects in #674/#675.)*
- **"Refusing instead of truncating will hold more designs."** Yes — and that is correct behaviour,
  not a regression. A truncated line is a line whose meaning nobody chose. The hold is visible on
  the card with its reason (built in #674/#675); silent amputation is not.
- **"This is a refactor with no feature."** It is the precondition the PO's own "2+3" ruling turned
  out to need, and H10-H12 are live bugs reachable today by a stale stored value or a hand-edit.
- **"Two rulebooks again."** The failure mode of this very spec. Phase 2 must MOVE the rules, not
  copy them: after it, `validateItemHighlights` either IS the net or calls it. A source-scan
  enumeration test (the pattern that closed the gender-lexicon class in #674) should fail if a
  second Item-Highlight rule list appears anywhere in `src/lib`.
- **"The doctrine correction is cosmetic."** It is not. Two rulings — "not conversion copy" and the
  107 floor — were made on the belief that no shopper sees this field. Leaving the false statement
  in the rulebook guarantees the next decision inherits it.

## 4. WHAT STAYS PO-GATED

Merge (go-live). The floor number. The writer. The Amazon push.
