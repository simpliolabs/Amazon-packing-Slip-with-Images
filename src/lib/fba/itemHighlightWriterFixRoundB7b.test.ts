/**
 * itemHighlightWriterFixRoundB7b.test.ts — fix round B7b (controller RULING on the B6 panel's WIRE
 * half, `.superpowers/sdd/2026-09-10-ih-writer/phase-b7-rulings.md`, W1-W5). W1 (the enumeration
 * class at the module boundary) lives in `itemHighlightWriterEnumeration.test.ts` alongside the
 * scanners it pins; this file carries W3 (the per-design wall-time pin must be able to fail) and W5
 * (the deadline-skipped-call accounting fix). Every "lie" line below is a hand-built pool row, never
 * model output; the W3 tests are the ONE place a REAL `openai` SDK client is constructed, pointed at
 * a LOCAL 127.0.0.1 server (dead / slow) — never a live model call, no `.env` file is read anywhere
 * in this file.
 */
import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import OpenAI from 'openai'
import {
  runWriterForDesign, buildAdmittedUnits, type AdmittedUnit,
} from './itemHighlightWriter'
import { buildItemHighlights, buildItemHighlightsPerDesign, produceItemHighlights, produceItemHighlightsPerDesign } from './listingPipeline'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const GILDAN = DEFAULT_BLANK_SPECS[1]
// The per-design builder rates EACH design's own card (`themeFitByDesign`, keyed by design KEY, NOT
// design name — `unratedDesignKeys`/`designFitOf` in `themeFitByDesign.ts`) and HOLDS a design with
// 'designs-unrated' — 0 writer calls, ~0ms wall — when its key is missing there. A flat `kw()` helper
// with no `themeFitByDesign` (the shape every OTHER Q10 pool in this file, including the EXISTING
// per-design one in `itemHighlightWriterFixRoundB6.test.ts`, already uses) holds EVERY per-design
// group this way — which is why that existing pin, and a first draft of the two below, measured 0
// calls and ~15-20ms wall regardless of server behaviour: the writer was never reached at all, a
// DIFFERENT and prior instance of the same "pin cannot fail" class this round exists to close. Both
// keys rated here (100% share, over the 30% DESIGN_RATED_MIN_SHARE floor) is what makes the writer
// actually run for both design groups (verified below by asserting `writerLog`/`calls` are non-zero
// BEFORE the wall-time assertion, not only checking wall/value afterward).
const kwFor = (keyword: string, searchVolume: number): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit: 3, themeFitByDesign: { A: { fit: 3 }, B: { fit: 3 } } } as unknown as AnalyzedKeyword)
// Plain flat-`themeFit` keyword, for the SINGLE-design (W5) test below, which never reads
// `themeFitByDesign` at all.
const kw = (keyword: string, searchVolume: number): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit: 3 } as unknown as AnalyzedKeyword)

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const server = http.createServer(handler)
    const sockets = new Set<import('node:net').Socket>()
    server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)) })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolveStart({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((resolveClose) => {
          for (const sock of sockets) sock.destroy()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}
const OPENAI_ENVELOPE = (content: string) => JSON.stringify({
  id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4.1',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// W3 (wire Important): the per-design wall-time pin (Q10/W7) could not fail — its own scenario (a
// SLOW-but-instantly-invalid 500ms server, 2 designs) finished in ~1.6s against a 22_500ms bound with
// NO deadline at all (review B6/wire §3, [Q10P]): a regression confined to
// `produceItemHighlightsPerDesign` dropping `deadlineAt` entirely would leave that scenario green.
// These two NEW cases are chosen so the bound is genuinely tight against the UN-deadlined behaviour:
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING W3 (fix round B7b, wire Important): the per-design wall-time pin can fail', () => {
  const pool: AnalyzedKeyword[] = [
    kwFor('funny graphic novelty tee', 450), kwFor('cute cartoon animal print', 900), kwFor('retro vintage style clothing', 300),
    kwFor('cozy everyday casual wear', 250), kwFor('trendy modern weekend outfit', 5000),
  ]

  it('per-design path: a DEAD server (>= 2 designs, hangs, never responds) bounds wall <= deadline + 20000, shipped === composer for every design', async () => {
    const { url, close } = await startServer(() => { /* never respond */ })
    const deadlineMs = 1200
    process.env.IH_WRITER = 'on'
    process.env.IH_WRITER_DEADLINE_MS = String(deadlineMs)
    try {
      const groups = [
        { key: 'A', designName: 'Sunny Beach Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Sunny Beach Vibes Tee'] },
        { key: 'B', designName: 'Cozy Fall Layer', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Cozy Fall Layer Tee'] },
      ]
      const input = { groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
      const composer = buildItemHighlightsPerDesign(input)
      const client = new OpenAI({ apiKey: 'sk-test-local', baseURL: url, maxRetries: 0 })
      const t0 = Date.now()
      const result = await produceItemHighlightsPerDesign(input, { openai: client })
      const wall = Date.now() - t0
      // Prove the writer actually ran for BOTH designs (never 'designs-unrated', never 0 calls) —
      // otherwise a bound assertion below would pass VACUOUSLY, the exact "test-proves-the-mock"
      // class this round's discipline forbids.
      expect(result.writerLog?.length, JSON.stringify(result.writerLog)).toBe(2)
      for (const row of result.writerLog ?? []) expect(row.calls, JSON.stringify(row)).toBeGreaterThan(0)
      // RULING W3 mutation proof (paste both runs in the report): with `deadlineAt` removed from
      // `listingPipeline.ts`'s call into `runWriterForDesign`, THIS scenario (dead server, no
      // per-call cutoff shrinking with elapsed time) runs the full 1+2 retries per design at the
      // per-call cap (20_000ms) each — 2 designs x 3 calls x 20_000ms, far past this bound.
      expect(wall, `wall=${wall}ms`).toBeLessThanOrEqual(deadlineMs + 20_000)
      for (const d of result.perDesign) {
        const builtD = composer.perDesign.find((x) => x.designKey === d.designKey)!
        expect(d.value).toBe(builtD.value)
        expect(d.hold).toBe(builtD.hold)
      }
    } finally {
      delete process.env.IH_WRITER
      delete process.env.IH_WRITER_DEADLINE_MS
      await close()
    }
  }, 40_000)

  it('per-design path: a server slow enough (14.9s replies) that the UN-deadlined case would breach, but a small deadline keeps it bounded, for every design', async () => {
    const slowMs = 14_900
    const { url, close } = await startServer((_req, res) => {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(OPENAI_ENVELOPE('{}')) }, slowMs)
    })
    const deadlineMs = 2500
    process.env.IH_WRITER = 'on'
    process.env.IH_WRITER_DEADLINE_MS = String(deadlineMs)
    try {
      const groups = [
        { key: 'A', designName: 'Sunny Beach Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Sunny Beach Vibes Tee'] },
        { key: 'B', designName: 'Cozy Fall Layer', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Cozy Fall Layer Tee'] },
      ]
      const input = { groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
      const composer = buildItemHighlightsPerDesign(input)
      const client = new OpenAI({ apiKey: 'sk-test-local', baseURL: url, maxRetries: 0 })
      const t0 = Date.now()
      const result = await produceItemHighlightsPerDesign(input, { openai: client })
      const wall = Date.now() - t0
      // Same non-vacuous proof as the dead-server test above.
      expect(result.writerLog?.length, JSON.stringify(result.writerLog)).toBe(2)
      for (const row of result.writerLog ?? []) expect(row.calls, JSON.stringify(row)).toBeGreaterThan(0)
      // RULING W3: this is the discriminating case — the review's own external probe (dl9.mts,
      // `IH_WRITER_DEADLINE_MS=100000000`) measured this EXACT scenario (2 designs, 14.9s replies)
      // at wall=89_400ms against a 22_500ms bound when the deadline is removed (3 retries x 14.9s x
      // 2 designs, since the per-call cap of 20_000ms never shrinks without a real `deadlineAt`) —
      // see the round's report for the pasted mutation-proof run.
      expect(wall, `wall=${wall}ms`).toBeLessThanOrEqual(deadlineMs + 20_000)
      for (const d of result.perDesign) {
        const builtD = composer.perDesign.find((x) => x.designKey === d.designKey)!
        expect(d.value).toBe(builtD.value)
        expect(d.hold).toBe(builtD.hold)
      }
    } finally {
      delete process.env.IH_WRITER
      delete process.env.IH_WRITER_DEADLINE_MS
      await close()
    }
  }, 40_000)
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// W5 (wire minors, item 2): a deadline-skipped `askWriter` (its OWN internal deadline check fires,
// racing the retry loop's check just before it) must not increment `callsMade` — no network round
// trip happened. Deterministic reproduction of the race via a sequenced `Date.now` spy (real wall
// clock timing at millisecond precision is not reliable enough to force this window on demand).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING W5 (fix round B7b, wire minor 2): a deadline-skipped askWriter call is not billed', () => {
  it('the loop-level check passes, but askWriter\'s OWN deadline check fires immediately after — calls stays 0, the client is never invoked', async () => {
    const title = 'THE CEO Deadline Race Shirt'
    const input = {
      finalTitle: title,
      pool: [kw('funny graphic novelty tee', 450), kw('cute cartoon animal print', 900), kw('retro vintage style clothing', 300), kw('cozy everyday casual wear', 250)],
      apparelProduct: true, blankBrand: GILDAN, netTitles: [title], designTokens: ['Deadline Race'], capacityFamily: false, brandName: 'THE CEO',
    }
    const built = buildItemHighlights(input)
    const units: readonly AdmittedUnit[] = buildAdmittedUnits(built.composed!, { designName: 'Deadline Race', truthCtx: built.truthCtx! })
    const runTail = () => ({ value: 'stub', hold: null as string | null })
    const neverCalled = vi.fn(() => { throw new Error('askWriter must never reach the client after its own deadline check fires') })
    const stubClient = { chat: { completions: { create: neverCalled } } } as unknown as OpenAI

    const deadlineAt = 1_000_000_000_000 // arbitrary fixed reference epoch-ms, real value irrelevant
    const dateSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(deadlineAt - 10) // 1st read: the RETRY LOOP's own check — still before the deadline, proceeds to call askWriter
      .mockReturnValueOnce(deadlineAt + 5) // 2nd read: askWriter's OWN `remainingMs` calc — now past the deadline
    try {
      const result = await runWriterForDesign({
        composed: built.composed!, fallbackHold: null, designName: 'Deadline Race',
        truthCtx: built.truthCtx!, runTail, deps: { openai: stubClient }, deadlineAt,
      })
      expect(result.calls).toBe(0)
      expect(result.accepted).toBe(false)
      expect(result.reasons.some((r) => r.includes('deadline exceeded mid-call'))).toBe(true)
      expect(neverCalled).not.toHaveBeenCalled()
    } finally {
      dateSpy.mockRestore()
    }
  })
})
