/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE LEAVE-ONE-OUT GO/NO-GO GATE, as an endpoint.
 *
 * WHY AN ENDPOINT AND NOT A SCRIPT. The referee needs a real model call and OPENAI_API_KEY lives on
 * the application, not in the dev sandbox (the same gap that makes ~15 tests env-skip locally). This
 * route runs the harness server-side so the gate can be measured before ANY of it is wired into the
 * pipeline. It is auth-gated by src/middleware.ts like every other /api/fba route.
 *
 * IT SPENDS NO JUNGLE SCOUT CREDITS. It never touches keyword research, the pool, or syncKeyword-
 * Intelligence — it reads the nine seed golds, builds adversarial twins from them in pure code, and
 * asks the referee to pick. The seller's standing order ("STOP, NEVER USE credits") is satisfied by
 * construction, not by a guard someone has to remember.
 *
 * ONE GOLD PER REQUEST BY DEFAULT — THIS IS LOAD-BEARING. The full 9-gold gate is 9 x `runs` model
 * calls; at gpt-5 latency that is minutes, and this repo has already had a same-night incident from
 * putting an unbounded in-band LLM job on a request path (PR #531 -> #532: a heal 502'd past 160s
 * and re-fired on every page load). So the caller asks for the indices it wants and stitches the
 * report together. `indices` is REQUIRED to be small; asking for everything at once is refused with
 * a reason rather than accepted and then timing out.
 *
 * NOTHING HERE IS WIRED INTO GENERATION. Reading this route cannot change a single shipped title.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
import { NextRequest, NextResponse } from 'next/server'
import { SEED_GOLD_TITLES } from '@/lib/fba/poGoldCorpus'
import { leaveOneOut, attackTwins, REFEREE_ITEMS } from '@/lib/fba/titleRefereeLlm'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/** Above this many golds per request the handler refuses rather than risking an edge timeout. */
const MAX_INDICES_PER_REQUEST = 3

export async function GET() {
  // Dry inspection: the lineup and rubric WITHOUT spending a single token, so the harness can be
  // reviewed before it is ever run.
  return NextResponse.json({
    golds: SEED_GOLD_TITLES,
    items: REFEREE_ITEMS,
    sampleLineup: SEED_GOLD_TITLES.map((g, i) => ({ i, gold: g, twins: attackTwins(g).map((t) => ({ label: t.label, title: t.title })) })),
    usage: 'POST { "indices": [0,1,2], "runs": 3 } — max 3 indices per request, no Jungle Scout credits, nothing wired into generation.',
  })
}

export async function POST(req: NextRequest) {
  let body: { indices?: unknown; runs?: unknown; model?: unknown } = {}
  try { body = await req.json() } catch { /* empty body is fine — defaults below */ }

  const raw = Array.isArray(body.indices) ? body.indices : [0]
  const indices = raw
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < SEED_GOLD_TITLES.length)
  if (indices.length === 0) {
    return NextResponse.json({ error: `indices must be integers in 0..${SEED_GOLD_TITLES.length - 1}` }, { status: 400 })
  }
  if (indices.length > MAX_INDICES_PER_REQUEST) {
    return NextResponse.json({
      error: `at most ${MAX_INDICES_PER_REQUEST} indices per request — the full gate is ${SEED_GOLD_TITLES.length} x runs model calls and would exceed the edge timeout. Call this repeatedly and stitch the cases.`,
    }, { status: 400 })
  }

  const runs = Number.isInteger(body.runs) ? Math.max(1, Math.min(5, Number(body.runs))) : 3
  const model = typeof body.model === 'string' && body.model ? body.model : undefined
  const started = Date.now()

  try {
    // leaveOneOut always excludes the held-out gold from its own anchor set, so running a SUBSET
    // gives exactly the same per-case result as running all nine — the cases are independent.
    const subset = indices.map((i) => SEED_GOLD_TITLES[i])
    const report = await leaveOneOut(subset, { runs, model })
    // Re-stamp the true corpus index so a stitched report is unambiguous.
    report.cases.forEach((c, k) => { c.goldIndex = indices[k] })
    console.log('[REFEREE_LOO]', JSON.stringify({
      indices, runs, model: report.model, correct: report.correct, total: report.total,
      meanAgreement: Number(report.meanAgreement.toFixed(3)),
      falseFires: report.goldFalseFires.length, ms: Date.now() - started,
    }))
    return NextResponse.json({ ...report, indices, elapsedMs: Date.now() - started })
  } catch (e) {
    // POSITIVE ATTESTATION: a referee failure is reported as a failure, never as an empty verdict.
    // The whole point of the gate is to find out BEFORE shipping, so a silent pass is the worst
    // possible outcome here.
    console.error('[REFEREE_LOO] failed', e)
    return NextResponse.json({ error: String(e), indices, elapsedMs: Date.now() - started }, { status: 500 })
  }
}
