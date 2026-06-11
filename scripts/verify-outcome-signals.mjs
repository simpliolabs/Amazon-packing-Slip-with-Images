// Runtime proof of the outcome-loop signal (#89) + the honest share-movement strings. The per-keyword
// algorithm is copied VERBATIM from src/lib/keyword-engine/outcomeSignals.ts and the string author from
// rankAnalysis.buildFreeCore; the over-promise validator is the same BANNED regex as rankAnalysis. This
// guarantees: (a) no actionable signal until ≥2 distinct monthly snapshots, (b) low-volume noise is
// suppressed, (c) "flat despite a change" → non-content bottleneck, (d) every rendered string is honest
// (correlation, never causation; never "rank #1"). Run: node scripts/verify-outcome-signals.mjs

const FLAT_BAND_PCT = 2.0
const MIN_VOLUME = 100

// ── signal core (verbatim from outcomeSignals.ts, per-keyword) ──
function signalFor(keyword, snaps /* newest-first */) {
  const distinct = []; const seen = new Set()
  for (const s of snaps) { if (!seen.has(s.snapshot_date)) { seen.add(s.snapshot_date); distinct.push(s) } }
  if (distinct.length < 2) return { keyword, direction: 'insufficient_data', shareBefore: null, shareAfter: distinct[0]?.impression_share ?? null, contentChangedBetween: false, nonContentBottleneck: false }
  const after = distinct[0], before = distinct[1]
  const aShare = after.impression_share, bShare = before.impression_share
  if (aShare == null || bShare == null || (after.search_volume ?? 0) < MIN_VOLUME || (before.search_volume ?? 0) < MIN_VOLUME)
    return { keyword, direction: 'insufficient_data', shareBefore: bShare, shareAfter: aShare, contentChangedBetween: false, nonContentBottleneck: false }
  const delta = aShare - bShare
  const direction = delta > FLAT_BAND_PCT ? 'rose' : delta < -FLAT_BAND_PCT ? 'fell' : 'flat'
  const contentChangedBetween = !!before.content_fingerprint && !!after.content_fingerprint && before.content_fingerprint !== after.content_fingerprint
  const nonContentBottleneck = contentChangedBetween && (direction === 'flat' || direction === 'fell')
  return { keyword, direction, shareBefore: bShare, shareAfter: aShare, contentChangedBetween, nonContentBottleneck }
}

// ── honest string author (verbatim from rankAnalysis.buildFreeCore) ──
function shareText(sig) {
  if (!sig || sig.direction === 'insufficient_data' || sig.shareAfter == null) return null
  const pct = Math.round(sig.shareAfter)
  if (sig.direction === 'rose') return sig.contentChangedBetween ? `Share rose to ${pct}% after your last content change.` : `Share rose to ${pct}% (no content change in this window).`
  if (sig.nonContentBottleneck) return `Share ${sig.direction === 'fell' ? 'fell to' : 'flat at'} ${pct}% despite your last content change — rank now likely depends on reviews, price, and velocity, not more copy.`
  return `Share ${sig.direction === 'fell' ? 'fell to' : 'flat at'} ${pct}% (no content change in this window).`
}

// ── over-promise validator (verbatim BANNED family from rankAnalysis.ts / verify-rank-honesty.mjs) ──
const BANNED = new RegExp([
  '\\brank\\w*\\b[^.]{0,20}\\b(?:#?1|number\\s*one|top|first)\\b',
  '\\b(?:#?1|number\\s*one|top|first)\\b[^.]{0,20}\\brank\\w*\\b',
  '\\boutrank\\w*\\b', '\\bbeat\\b[^.]{0,20}\\bcompetitor', '\\bdominat\\w*\\b',
  '\\btop\\s+of\\s+amazon\\b', '\\b(?:page|pg)\\s*(?:one|1)\\b', '\\bfirst\\s+page\\b', '\\bbest[\\s-]?seller\\b',
  '\\bguarantee\\w*\\b[^.]{0,25}\\b(?:rank|#?1|top|first|page|sell)',
  '\\b(?:top|first)\\s+(?:spot\\s+|position\\s+)?(?:of|on|in)\\s+(?:the\\s+)?(?:search|results|amazon|page)',
].join('|'), 'i')
const isOverPromise = (s) => BANNED.test(s)

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL:', name) } }
const snap = (date, share, vol, fp) => ({ snapshot_date: date, impression_share: share, search_volume: vol, content_fingerprint: fp })

// 1. Cold start (1 snapshot) → insufficient_data, no string.
const s1 = signalFor('later gator shirt', [snap('2026-05-31', 20, 500, 'a')])
ok('cold-start → insufficient_data', s1.direction === 'insufficient_data')
ok('cold-start → no string', shareText(s1) === null)

// 2. Two snapshots, SAME fingerprint, +5pts → rose, no content change.
const s2 = signalFor('kids gator', [snap('2026-05-31', 20, 500, 'a'), snap('2026-04-30', 15, 500, 'a')])
ok('same-fp +5 → rose', s2.direction === 'rose' && s2.contentChangedBetween === false)
ok('same-fp rose string honest', /no content change/.test(shareText(s2)) && !isOverPromise(shareText(s2)))

// 3. Two snapshots, fingerprint CHANGED, +5pts → rose + "after your last content change".
const s3 = signalFor('alligator tee', [snap('2026-05-31', 22, 800, 'b'), snap('2026-04-30', 17, 800, 'a')])
ok('changed-fp +5 → rose + contentChanged', s3.direction === 'rose' && s3.contentChangedBetween === true)
ok('changed-fp rose string honest', /after your last content change/.test(shareText(s3)) && !isOverPromise(shareText(s3)))

// 4. Fingerprint CHANGED, within FLAT band (+0.5) → flat + nonContentBottleneck.
const s4 = signalFor('see you later alligator', [snap('2026-05-31', 15.5, 1200, 'b'), snap('2026-04-30', 15, 1200, 'a')])
ok('changed-fp +0.5 → flat + bottleneck', s4.direction === 'flat' && s4.nonContentBottleneck === true)
ok('bottleneck string honest (reviews/price/velocity)', /reviews, price, and velocity/.test(shareText(s4)) && !isOverPromise(shareText(s4)))

// 5. Low-volume keyword (vol 40) with a big delta → insufficient_data (noise guard wins).
const s5 = signalFor('niche gator', [snap('2026-05-31', 30, 40, 'b'), snap('2026-04-30', 5, 40, 'a')])
ok('low-volume → insufficient_data', s5.direction === 'insufficient_data')

// 6. Fingerprint CHANGED, big DROP (-10) → fell + nonContentBottleneck.
const s6 = signalFor('gator gift', [snap('2026-05-31', 10, 600, 'b'), snap('2026-04-30', 20, 600, 'a')])
ok('changed-fp -10 → fell + bottleneck', s6.direction === 'fell' && s6.nonContentBottleneck === true)

// 7. Same fp, no real change (+1, within band) → flat, NOT a bottleneck (content didn't change).
const s7 = signalFor('reptile shirt', [snap('2026-05-31', 16, 700, 'a'), snap('2026-04-30', 15, 700, 'a')])
ok('same-fp flat → NOT bottleneck', s7.direction === 'flat' && s7.nonContentBottleneck === false)

// 8. Honesty fuzz: every produced string is clean; a causation/over-promise variant is caught (neg control).
const allStrings = [s2, s3, s4, s6, s7].map(shareText).filter(Boolean)
ok('all rendered strings pass isOverPromise=false', allStrings.every((t) => !isOverPromise(t)))
ok('negative control caught', isOverPromise('This will rank you #1 after your change.') === true)

if (fail === 0) console.log(`PASS — ${pass}/${pass} outcome-signal assertions held (insufficient-data guard, volume guard, rose/flat/fell, non-content bottleneck, honesty).`)
else console.log(`FAIL — ${fail} failed, ${pass} passed.`)
process.exit(fail === 0 ? 0 : 1)
