# GOAL / PLAN / ADVERSARY — model bake-off: which model for which contract

approved: true   <!-- PO 2026-09-05: "A: go, The AI key is stored in the Platform Secrects" / "B: Approved"; 2026-09-06: "And BAKE off is Still on hold? Clear the Way please with the person holding it ASAP!" -->

## 1. GOAL

**What we are achieving:** an evidence-based model assignment per ROLE, replacing a policy nobody
measured.

**The finding that motivates it.** `gpt-4.1-mini` runs **25 of 26** LLM call sites in this pipeline —
the title writer, every council member, the mega-audit that decides Product Details, the description
agent, the theme rater. One `gpt-4.1` call. **There is no role differentiation at all.** The
"council" is not a council of different minds; it is one small model sampled repeatedly, so its
diversity is temperature noise rather than different reasoning.

**Why this is the right question now.** The PO has spent a week rejecting titles that pass every
truth net, the band, the floor and a deterministic judge. **A gate can only REJECT; it can never
IMPROVE.** Every mechanism built this week polices the writer's output — none of it can add quality
the writer never produced. If the writer is the constraint, all further gate work has a low ceiling.

**PO's own prior bake-off (different project) is the method and the prior:** five models, 4 runs
each, graded by the app's own deterministic gate, no model opinion. It found (a) bigger was worse for
judging, (b) roles split by CONTRACT not prestige — free-form work went to the model with imagination,
gated rewrites to the model with obedience.

### FINAL PRODUCT — observable

A table, per role, of: model · accepted N/4 · median judge score · latency · **the rejection reason**.
Plus a recommended assignment per role, and — if the data says so — the finding that model choice
does NOT matter, which redirects effort to the keyword pool instead.

**The hypothesis to falsify:** a stronger writer produces titles the EXISTING gates accept at a
higher rate. **If accepted-rate is flat across models, the writer is not the constraint** — that is a
valuable negative result and must be reported as loudly as a positive one.

## 2. PLAN — per karpathy-dev-principles

**Think before coding.** This is measurement, not a feature. Nothing in the product changes as a
result of this task; the output is a table and a recommendation. Resist building a model-router.

**Simplicity first.** Do NOT add an abstraction layer, a provider registry, or a config schema. A
throwaway script that calls N models on a fixed prompt and pipes the output through EXISTING graders.

**Surgical.** No changes to `listingPipeline.ts`, `titleBand.ts`, or any shipped path. The bake-off
script is scaffolding and is labelled as such.

### Roles, in priority order (PO-directed)

1. **Title writer / council** — highest priority. Sets the ceiling every gate polices.
2. **Theme rater** — assigns `theme_fit` per keyword per design; drives CORE slot selection, which
   feeds titles AND Item Highlights. A bad rating poisons selection upstream of every gate.
3. **Bullets / description** — free-form, least gated, where imagination shows. The PO has never
   complained about these, which is itself a data point.

### Graders — all pure functions already in the repo, no model opinion

| Gate | Grades |
|---|---|
| `verdictForAssembledTitle` | truth + assembly, binary accept/reject |
| `titleQualityJudge` (`listingPipeline.ts:1719`) | score vs the PO's gold corpus; pure, synchronous |
| band + `TITLE_SHIP_FLOOR()` | length, deterministic |
| `scoreDescription` (85 threshold) | description quality |
| `ihRepeatViolations` | repeat violations |

### Steps

1. **Clear the credential blocker.** `XAI_API_KEY` IS set locally (84 chars). `OPENAI_API_KEY` is
   NOT — so the incumbent cannot be called locally and no comparison is possible. **The PO must make
   the OpenAI key reachable to the run, or the bake-off cannot start.** Do not proceed without it;
   a Grok-only run measures nothing.
2. **Fix the task, vary only the model.** 3 real designs on B0DSCDZC6K (unisex, women's-skewed pool)
   + 1 on the kids family. 4 runs per model per design. Same prompt, same ctx, same temperature.
3. **Grade with the gates above.** Record accepted N/4, median score, latency, and the REJECTION
   REASON — the PO's own bake-off found the signal in the reason, not the count.
4. **Report the table.** Include the negative result if that is what the data says.

## 3. ADVERSARY

- **Model identity is CONFOUNDED with prompt.** Our prompts were tuned against `gpt-4.1-mini` over
  months. A stronger model may score WORSE because the prompt over-constrains it. Mitigation: hold
  the prompt fixed (that is the honest comparison for a drop-in swap) and **state this limitation in
  the report rather than pretending it is not there.** A "model X is worse" result may mean "our
  prompt is shaped around mini."
- **The judge is scored against the PO's 10-gold corpus, which mini's output helped shape.** Some
  golds are PO-written, but `title_source='manual'` rows enter the corpus — so the yardstick is
  partly downstream of the incumbent. Flag any result where the incumbent wins narrowly.
- **This spends real API tokens** on a paid product with no revenue attached. PO approved the spend;
  keep the run bounded (4 runs × 4 designs × N models) and report actual cost.
- **A bake-off that finds a winner invites a rewrite of 25 call sites.** That is NOT in scope here
  and must not be smuggled in. The output is a recommendation the PO rules on separately.
- **Latency matters in production** — the pipeline already risks Cloud Run timeouts. A model that
  wins on quality and loses badly on latency may be unusable. Record both; do not recommend on
  quality alone.
- **Grok has NO integration in this repo** (verified: zero references). Adding it to the bake-off
  script is throwaway scaffolding; adding it to the pipeline would be real work and is out of scope.

## 4. APPROVAL

PO signs off, then `approved: true`, then run. Blocked additionally on the OpenAI key (step 1).
