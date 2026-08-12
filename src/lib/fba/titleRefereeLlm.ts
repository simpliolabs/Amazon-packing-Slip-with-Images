/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TITLE REFEREE — LLM half, plus the LEAVE-ONE-OUT GO/NO-GO GATE.
 *
 * THIS IS THE STEP THAT MAKES THIS ATTEMPT DIFFERENT FROM THE PREVIOUS FIVE. Every earlier round
 * shipped a rule and discovered it was wrong when the seller rejected the next title. This one is
 * measured BEFORE anything is wired: hold out each of the nine golds in turn, retrieve the nearest
 * of the remaining eight as the anchor, and require the referee to pick the held-out gold out of a
 * lineup of adversarial twins built from it. SHIP ONLY AT >= 8/9. If it fails we have spent a day,
 * not a sixth rejected title.
 *
 * DESIGN CHOICES, EACH WITH A REASON (handoff/TITLE_ARCHITECTURE.md §4):
 *
 * POINTWISE, NOT PAIRWISE. Pairwise preferences flip ~35% of the time vs ~9% for absolute scores and
 * are measurably MORE vulnerable to distractor features that let a generator inflate a weaker output
 * (arXiv:2504.14716). A stuffed title IS a distractor-dense candidate, so pairwise is the single
 * protocol most likely to be fooled by this system's exact failure mode.
 *
 * BINARY ITEMS WITH AN EVIDENCE QUOTE, AND CODE DOES THE ARITHMETIC. The model never returns a
 * score. It answers yes/no per item and quotes the span that decided it, so every verdict is
 * auditable against the string. Summing in code removes a whole class of judge arithmetic error.
 *
 * PERMUTATION ENSEMBLING. Rubric-based pointwise judging shows top-1 ranking reversal in 16-39% of
 * prompts under criterion reordering (arXiv:2602.02219); permutation ensembling is that paper's own
 * recommended mitigation. We rotate BOTH the item order and the candidate order, and take the
 * majority — permuting only one axis leaves the other biased.
 *
 * REFERENCE-ANCHORED. The retrieved golds go in the prompt as the standard. This is MT-Bench's
 * documented mitigation for judge failure modes (Zheng et al., NeurIPS 2023, arXiv:2306.05685).
 *
 * POSITIVE ATTESTATION, NEVER A SWALLOWED ERROR. `titleCouncilAsk`'s `catch { return '' }` makes an
 * HTTP 400 indistinguishable from an empty verdict — the same shape as the three `json_object` sites
 * this repo had dead since birth because the prompt never contained the literal word "json". This
 * module throws on failure and the caller reports it. A referee that fails silently is worse than no
 * referee, because it degrades into the deterministic ladder that is today's exact defect.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
import { getLlmClient, isGpt5Class } from './llmGateway'
import { SEED_GOLD_TITLES } from './poGoldCorpus'
import { moneyNovelty, resolveSegments, nearestGolds, goldSituation, type GoldSituation } from './titleReferee'

export interface Candidate { id: string; title: string; label?: string }

export interface RefereeItem { key: string; question: string }

/* THE RUBRIC. Derived from the seller's OWN rulings, not from a style guide:
 *   - 2026-08-12 rule 1: every character must buy a search term
 *   - 2026-08-12 rule 2: the identity must name a specific subject, not its category
 *   - 2026-08-10:        "why did we need the filler CREW NECK there?"
 * Each item must fire ZERO times across the nine golds — an item that docks a gold is a rule the
 * seller never made, and the acceptance spec rejects it. */
export const REFEREE_ITEMS: readonly RefereeItem[] = [
  { key: 'specificSubject', question: 'Does the part BEFORE the separator name a SPECIFIC subject the design is about (a named thing, phrase or event), rather than only the general category it belongs to?' },
  { key: 'oneThingSaid', question: 'Does that same part read as ONE thing a person would actually say, rather than as separate keyword chunks bolted together?' },
  { key: 'tailEarnsSpace', question: 'Does EVERY word after the separator earn its space — i.e. is it a phrase a shopper would really type, AND does it add something the earlier part did not already say?' },
  { key: 'noInventedFiller', question: 'Is the title free of invented filler — words added to fill space that no shopper searches for (e.g. "Fan Tournament", "Gift Idea", "Crew Neck" on a graphic tee)?' },
  { key: 'aboutThisDesign', question: 'Is the title unmistakably about THIS design, so a shopper seeing it would know what is printed on the shirt?' },
  { key: 'sellerVoice', question: 'Reading the seller examples above as the standard, would the SELLER have written this title?' },
]

export interface CandidateVerdict {
  id: string
  items: Record<string, boolean>
  quotes: Record<string, string>
  tell: string
  passed: number
}

export interface RefereeResult {
  winnerId: string
  verdicts: CandidateVerdict[]
  /** How many of the permutation runs agreed on the winner (out of `runs`). */
  agreement: number
  runs: number
  model: string
}

const rotate = <T,>(arr: readonly T[], by: number): T[] => [...arr.slice(by), ...arr.slice(0, by)]

function refereePrompt(candidates: Candidate[], anchors: GoldSituation[], designPhrase: string, items: readonly RefereeItem[]) {
  const anchorBlock = anchors.map((a, i) => `${i + 1}. ${a.title}`).join('\n')
  const itemBlock = items.map((it, i) => `${String.fromCharCode(97 + i)}) key="${it.key}" — ${it.question}`).join('\n')
  const candBlock = candidates.map((c) => {
    const seg = resolveSegments(c.title)
    const nov = moneyNovelty(c.title)
    // The novelty measurement is given as a FACT the referee may use, never as a rule it must obey.
    // Code owns "which words repeat" (decidable); the referee owns "does this earn the space".
    return `id=${c.id}\n  title: ${c.title}\n  before separator: ${seg.identity}\n  after separator: ${seg.money || '(none)'}\n  words after the separator already used before it: ${nov.echoed.length ? nov.echoed.join(', ') : 'none'}`
  }).join('\n\n')

  const system =
    'You are the seller\'s own editor for Amazon apparel titles. You do not write titles; you decide which one the seller would keep. ' +
    'You answer only the yes/no questions asked, and you quote the exact words that decided each answer. You never invent a score and you never rank by length. ' +
    'Return ONLY json.'

  const user =
`THE SELLER'S OWN TITLES — this is the standard, nothing else is:
${anchorBlock}

THE DESIGN BEING TITLED: ${designPhrase}

THE SELLER'S TWO RULES, in their words:
1. EVERY CHARACTER MUST BUY A SEARCH TERM. A word that repeats something already said, or that no shopper would type, is wasted space.
2. THE IDENTITY MUST NAME A SPECIFIC SUBJECT, NOT ITS CATEGORY. "Espana Championship" names a thing; "World Soccer Cup" alone is the category it sits in.

QUESTIONS — answer each one true/false for EVERY candidate, and quote the words that decided it:
${itemBlock}

CANDIDATES:
${candBlock}

Return ONLY this json shape, one entry per candidate id, no prose outside it:
{"verdicts":[{"id":"<id>","items":{${items.map((i) => `"${i.key}":true|false`).join(',')}},"quotes":{"<key>":"<the exact words that decided it>"},"tell":"<one short sentence naming the single biggest problem, or 'none'>"}]}`

  return { system, user }
}

/** ONE batched, reference-anchored referee pass. Throws on any failure — see the header. */
async function refereePass(
  candidates: Candidate[],
  anchors: GoldSituation[],
  designPhrase: string,
  items: readonly RefereeItem[],
  model: string,
): Promise<CandidateVerdict[]> {
  const client = getLlmClient()
  if (!client) throw new Error('referee: OPENAI_API_KEY unset — refusing to degrade silently')
  const { system, user } = refereePrompt(candidates, anchors, designPhrase, items)

  const req: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
  }
  // gpt-5-class models reject an explicit temperature; everything else gets 0 for reproducibility.
  if (!isGpt5Class(model)) req.temperature = 0

  const res = await client.chat.completions.create(req as never)
  const raw = (res as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
  if (!raw.trim()) throw new Error('referee: empty completion — attestation failed')

  let parsed: { verdicts?: unknown }
  try { parsed = JSON.parse(raw) } catch { throw new Error(`referee: unparseable json (${raw.slice(0, 120)})`) }
  const list = Array.isArray(parsed.verdicts) ? parsed.verdicts : []
  if (list.length === 0) throw new Error('referee: no verdicts returned')

  return list.map((v) => {
    const r = v as { id?: string; items?: Record<string, boolean>; quotes?: Record<string, string>; tell?: string }
    const flags = r.items ?? {}
    // CODE sums. The model never returns a number.
    const passed = items.reduce((n, it) => n + (flags[it.key] === true ? 1 : 0), 0)
    return { id: String(r.id ?? ''), items: flags, quotes: r.quotes ?? {}, tell: String(r.tell ?? ''), passed }
  }).filter((v) => v.id)
}

/**
 * Run the referee under PERMUTED item AND candidate orders and take the majority winner.
 * Ties break on measured money novelty (a code fact), then on ballot index — deliberately NOT on
 * length, which is the discriminator the adversarial pass killed: the unpiped keyword soup at 74
 * chars sits closer to the corpus median than the seller's own gold.
 */
export async function runReferee(
  candidates: Candidate[],
  anchors: GoldSituation[],
  designPhrase: string,
  opts?: { runs?: number; model?: string },
): Promise<RefereeResult> {
  const runs = opts?.runs ?? 3
  const model = opts?.model || process.env.TITLE_REFEREE_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
  const wins = new Map<string, number>()
  let last: CandidateVerdict[] = []

  for (let r = 0; r < runs; r++) {
    const verdicts = await refereePass(rotate(candidates, r), anchors, designPhrase, rotate(REFEREE_ITEMS, r), model)
    last = verdicts
    const best = [...verdicts].sort((a, b) =>
      (b.passed - a.passed) ||
      (novOf(byId(candidates, b.id)) - novOf(byId(candidates, a.id))) ||
      (candidates.findIndex((c) => c.id === a.id) - candidates.findIndex((c) => c.id === b.id)),
    )[0]
    if (best) wins.set(best.id, (wins.get(best.id) ?? 0) + 1)
  }

  const ranked = [...wins.entries()].sort((a, b) => b[1] - a[1])
  const [winnerId, agreement] = ranked[0] ?? ['', 0]
  return { winnerId, verdicts: last, agreement, runs, model }
}

const byId = (cands: Candidate[], id: string): string => cands.find((c) => c.id === id)?.title ?? ''
/** Tie-break fact, not a rule: how much of the money position is NOT a restatement (titleReferee.ts). */
const novOf = (t: string): number => moneyNovelty(t).novelty

/* ── ADVERSARIAL TWINS ─────────────────────────────────────────────────────────────────────────────
 * Built DETERMINISTICALLY from each gold so the lineup is the seller's own title against the exact
 * ways this pipeline has actually gone wrong. Every twin is a REALLOCATION or a SUBSTITUTION of the
 * same design — never a different product — so the referee cannot win by topic-matching alone.
 */
export const TWIN_CAP = 75   // Amazon's item_name limit — the same number the ballot's hard filter uses

/** Drop trailing words until the string fits the cap. Twins MUST be cap-compliant: the gold always
 *  is, so an over-cap twin would let the referee win by picking the only legal candidate — a
 *  measurement artifact that would inflate the gate and teach us nothing. In production the cap is a
 *  strike-only predicate applied BEFORE the referee, so an over-cap candidate never reaches it. */
function fitCap(title: string, cap = TWIN_CAP): string {
  let t = title.replace(/\s+/g, ' ').trim()
  while (t.length > cap && t.includes(' ')) t = t.slice(0, t.lastIndexOf(' ')).replace(/[|,]\s*$/, '').trim()
  return t
}

export function attackTwins(gold: string): Candidate[] {
  const { identity, money } = resolveSegments(gold)
  const idWords = identity.split(/\s+/)
  const moneyWords = money.split(/\s+/).filter(Boolean)
  const design = idWords.slice(2).join(' ')            // drop the two brand words
  const out: Candidate[] = []
  const push = (label: string, title: string) => {
    const t = fitCap(title)
    // Reject a twin that trimming collapsed into the gold, into a duplicate, or into something too
    // short to be a plausible candidate — a degenerate lineup entry is a free win, not a test.
    if (!t || t === gold || t.length < 40 || out.some((c) => c.title === t)) return
    out.push({ id: `twin-${label}`, label, title: t })
  }

  // 1. ALLOCATION TWIN — the exact defect class: same words, wrong split. Pull the first two money
  //    words into the identity. This is the anagram case no token rule can separate.
  if (moneyWords.length >= 3) {
    push('allocation', `${identity} ${moneyWords.slice(0, 2).join(' ')} | ${moneyWords.slice(2).join(' ')}`)
  }
  // 2. ECHO TWIN — the LIVE 2026-08-12 defect: the money position restates the identity.
  if (idWords.length >= 5) {
    push('echo', `${identity} | ${idWords.slice(2, 5).join(' ')} Tshirt`)
  }
  // 3. INVENTED-FILLER TWIN — what the humanizer produced when the floor demanded length.
  push('filler', `${identity} | Fan Tournament Gift Idea Tee`)
  // 4. SPEC TWIN — "why did we need the filler CREW NECK there?"
  push('spec', `${identity} | Short Sleeve Crew Neck Classic Fit Tee`)
  // 5. CATEGORY TWIN — rule 2 inverted: the specific subject replaced by its category.
  if (design) push('category', gold.replace(design, 'Graphic Novelty'))
  // 6. STUTTER TWIN — the design phrase printed until the space is gone.
  if (design) push('stutter', `${identity} | ${design} ${design} Tshirt`)

  return out
}

/* ── THE LEAVE-ONE-OUT GATE ────────────────────────────────────────────────────────────────────── */

export interface LooCase {
  goldIndex: number
  gold: string
  anchors: string[]
  lineup: { id: string; label: string; title: string }[]
  winnerId: string
  winnerTitle: string
  correct: boolean
  agreement: number
  runs: number
  goldPassed: number | null
  tells: Record<string, string>
  error?: string
}

export interface LooReport {
  model: string
  cases: LooCase[]
  correct: number
  total: number
  /** SHIP GATE: >= 8/9 correct AND every gold clears every checklist item AND agreement >= 85%. */
  passesGate: boolean
  goldFalseFires: { gold: string; failedItems: string[] }[]
  meanAgreement: number
}

/**
 * Hold out each gold, retrieve the nearest of the REMAINING eight (never itself — that would be
 * leakage and would make the number meaningless), and require the referee to pick it out of a
 * lineup of its own adversarial twins.
 */
export async function leaveOneOut(
  golds: readonly string[] = SEED_GOLD_TITLES,
  opts?: { runs?: number; model?: string },
): Promise<LooReport> {
  const cases: LooCase[] = []
  const goldFalseFires: { gold: string; failedItems: string[] }[] = []
  let model = opts?.model || process.env.TITLE_REFEREE_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'

  for (let i = 0; i < golds.length; i++) {
    const gold = golds[i]
    const rest = golds.filter((_, j) => j !== i)                       // NO LEAKAGE
    const sit = goldSituation(gold)
    const anchors = nearestGolds(
      { isEvent: sit.isEvent, isStatement: sit.isStatement, hasProperSubject: sit.hasProperSubject, audience: sit.audience, garment: sit.garment },
      rest,
      3,
    )
    const twins = attackTwins(gold)
    // The gold sits at a rotating position so a positional bias cannot manufacture the score.
    const lineup: Candidate[] = [...twins]
    lineup.splice(i % (twins.length + 1), 0, { id: 'gold', label: 'gold', title: gold })

    try {
      const res = await runReferee(lineup, anchors, sit.identity.split(/\s+/).slice(2).join(' '), opts)
      const goldVerdict = res.verdicts.find((v) => v.id === 'gold')
      const failed = goldVerdict ? REFEREE_ITEMS.filter((it) => goldVerdict.items[it.key] !== true).map((it) => it.key) : []
      if (failed.length) goldFalseFires.push({ gold, failedItems: failed })
      model = res.model
      cases.push({
        goldIndex: i, gold,
        anchors: anchors.map((a) => a.title),
        lineup: lineup.map((c) => ({ id: c.id, label: c.label ?? '', title: c.title })),
        winnerId: res.winnerId,
        winnerTitle: lineup.find((c) => c.id === res.winnerId)?.title ?? '',
        correct: res.winnerId === 'gold',
        agreement: res.agreement, runs: res.runs,
        goldPassed: goldVerdict?.passed ?? null,
        tells: Object.fromEntries(res.verdicts.map((v) => [v.id, v.tell])),
      })
    } catch (e) {
      cases.push({
        goldIndex: i, gold, anchors: anchors.map((a) => a.title),
        lineup: lineup.map((c) => ({ id: c.id, label: c.label ?? '', title: c.title })),
        winnerId: '', winnerTitle: '', correct: false, agreement: 0, runs: opts?.runs ?? 3,
        goldPassed: null, tells: {}, error: String(e),
      })
    }
  }

  const correct = cases.filter((c) => c.correct).length
  const meanAgreement = cases.length ? cases.reduce((s, c) => s + (c.runs ? c.agreement / c.runs : 0), 0) / cases.length : 0
  return {
    model, cases, correct, total: golds.length,
    goldFalseFires, meanAgreement,
    passesGate: correct >= 8 && goldFalseFires.length === 0 && meanAgreement >= 0.85,
  }
}
