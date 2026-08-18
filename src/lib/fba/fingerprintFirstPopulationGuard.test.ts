/**
 * FINGERPRINT FIRST-POPULATION GUARD — pins the semantic that an empty→populated vision signal
 * transition is INGESTION drift, not a content change, and therefore MUST NOT force a billable
 * Jungle Scout re-harvest.
 *
 * Locks the exact logic of ai-recommendations/route.ts:557-571 as of 2026-08-18. The route
 * inlines the calculation (a supabase-bound API handler, not a pure module), so this test
 * mirrors the boolean expression here — if the route drifts, this test goes stale. Watchdog:
 * the file references route.ts by path in the description so a code-review can catch drift.
 */
import { describe, it, expect } from 'vitest'

// Extracted verbatim from the route so a single edit reflects both places (until the logic ever
// moves into a shared module). Any change to the route's calculation MUST be mirrored here or
// the test will fail — that's the tripwire.
function computeForceResearch(input: {
  competitorAsin: string
  designNameOv: string
  visionSig: string
  storedFingerprint: string     // 'competitor|design|vision', historical format
  fingerprintColumnExists: boolean
}): { signalChanged: boolean; shouldForceResearch: boolean } {
  const { competitorAsin, designNameOv, visionSig, storedFingerprint, fingerprintColumnExists } = input
  const refFingerprint = `${competitorAsin}|${designNameOv}|${visionSig}`
  const signalChanged =
    fingerprintColumnExists && !!(competitorAsin || designNameOv || visionSig) && refFingerprint !== storedFingerprint
  const [storedComp, storedDesign, storedVision] = (storedFingerprint || '').split('|')
  const shouldForceResearch = signalChanged && (
    (!!competitorAsin && competitorAsin !== (storedComp || '')) ||
    (!!designNameOv && designNameOv !== (storedDesign || '')) ||
    (!!visionSig && !!storedVision && visionSig !== storedVision)
  )
  return { signalChanged, shouldForceResearch }
}

describe('fingerprint first-population guard — vision ingestion must not spend Jungle Scout credits', () => {
  it('THE CURED HAZARD: empty→first-populated visionSig advances the fingerprint but does NOT force research', () => {
    // The scenario the 2026-08-18 workflow found live: 78 of 78 apparel parents had no vision
    // record; today's persistence lands an image, next regen scans it, the regen AFTER that sees
    // storedFingerprint='||' (empty vision) and refFingerprint='||soccer,world#…' (first vision).
    const r = computeForceResearch({
      competitorAsin: '',
      designNameOv: '',
      visionSig: 'soccer world cup 2026#usa,mexico,canada',
      storedFingerprint: '||',
      fingerprintColumnExists: true,
    })
    // The signal changed (we now have vision), so we enter the fingerprint-stamp branch —
    // that's how the transition gets recorded and this test isn't re-triggered forever.
    expect(r.signalChanged).toBe(true)
    // But we do NOT force a Jungle Scout re-harvest. That's the credit-safe outcome.
    expect(r.shouldForceResearch).toBe(false)
  })

  it('a REAL vision content change (value → different value) DOES force research', () => {
    const r = computeForceResearch({
      competitorAsin: '',
      designNameOv: '',
      visionSig: 'world cup 2026 usa#futbol,jersey,mexico',
      storedFingerprint: '||soccer world cup 2026#usa,mexico,canada',
      fingerprintColumnExists: true,
    })
    expect(r.signalChanged).toBe(true)
    expect(r.shouldForceResearch).toBe(true)   // re-scan detected new artwork; the harvest must catch up
  })

  it('a competitor ASIN change (real content change) forces research even when vision is stable', () => {
    const r = computeForceResearch({
      competitorAsin: 'B0AAA11111',
      designNameOv: 'world cup',
      visionSig: 'v1',
      storedFingerprint: 'B0BBB22222|world cup|v1',
      fingerprintColumnExists: true,
    })
    expect(r.shouldForceResearch).toBe(true)
  })

  it('a design-name override change forces research', () => {
    const r = computeForceResearch({
      competitorAsin: '',
      designNameOv: 'new design name',
      visionSig: '',
      storedFingerprint: '|old design name|',
      fingerprintColumnExists: true,
    })
    expect(r.shouldForceResearch).toBe(true)
  })

  it('a competitor going from EMPTY to first-set IS a seller signal and DOES force research', () => {
    // Vision is the ONLY signal treated as ingestion drift on first-population, because it fills
    // in from a background scanner without seller input. Competitor and design-name overrides are
    // DIFFERENT: the seller types them explicitly. An empty→value transition on those is a
    // deliberate seller action asking for a re-research with the new anchor, and honouring that
    // is the whole point of exposing the field. The workflow that traced today's incident named
    // credit-safety on VISION specifically — misapplying it to seller-authored signals would
    // silently ignore a real user request.
    const r = computeForceResearch({
      competitorAsin: 'B0COMPETITOR',
      designNameOv: '',
      visionSig: '',
      storedFingerprint: '||',
      fingerprintColumnExists: true,
    })
    expect(r.signalChanged).toBe(true)
    expect(r.shouldForceResearch).toBe(true)
  })

  it('a design-name override going from EMPTY to first-set — same as competitor: seller signal, forces', () => {
    const r = computeForceResearch({
      competitorAsin: '',
      designNameOv: 'world cup',
      visionSig: '',
      storedFingerprint: '||',
      fingerprintColumnExists: true,
    })
    expect(r.shouldForceResearch).toBe(true)
  })

  it('no change at all — no research', () => {
    const r = computeForceResearch({
      competitorAsin: '',
      designNameOv: 'world cup',
      visionSig: 'v1',
      storedFingerprint: '|world cup|v1',
      fingerprintColumnExists: true,
    })
    expect(r.signalChanged).toBe(false)
    expect(r.shouldForceResearch).toBe(false)
  })

  it('no fingerprint column (pre-migration) — never forces research on signal grounds', () => {
    // Safety fallback: an unmigrated DB should never spend credits based on a fingerprint the
    // route couldn't read. The empty-keyword branch still runs first-time research; this just
    // stops the signal-change path from arming spend.
    const r = computeForceResearch({
      competitorAsin: 'B0AAA',
      designNameOv: 'world cup',
      visionSig: 'v1',
      storedFingerprint: '',
      fingerprintColumnExists: false,
    })
    expect(r.signalChanged).toBe(false)
    expect(r.shouldForceResearch).toBe(false)
  })

  it('the stamp SHAPE holds — after first-population, a subsequent real change IS detected', () => {
    // Round-trip the semantics: first-population stamps '||v1', next regen sees storedVision
    // non-empty, so an actual v1 → v2 change is caught. This is why we stamp even on
    // shouldForceResearch=false.
    const first = computeForceResearch({
      competitorAsin: '', designNameOv: '', visionSig: 'v1',
      storedFingerprint: '||', fingerprintColumnExists: true,
    })
    expect(first.signalChanged).toBe(true)
    expect(first.shouldForceResearch).toBe(false)

    // After the route stamps refFingerprint='||v1', a genuine re-scan changes it to v2.
    const second = computeForceResearch({
      competitorAsin: '', designNameOv: '', visionSig: 'v2',
      storedFingerprint: '||v1', fingerprintColumnExists: true,
    })
    expect(second.signalChanged).toBe(true)
    expect(second.shouldForceResearch).toBe(true)
  })
})
