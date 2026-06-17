// Mirror the new scaled length penalty so we can verify the curve against PO's intent.
function lengthPenalty(titleLen) {
  if (titleLen <= 75) return 0
  const overage = titleLen - 75
  return Math.min(20, 5 + Math.floor(overage / 10))
}

let pass = 0, fail = 0
const eq = (name, got, want) => { if (got === want) { pass++; console.log('  ok  ', name) } else { fail++; console.log('  FAIL', name, 'got', got, 'want', want) } }

eq('75 chars — no penalty', lengthPenalty(75), 0)
eq('76 chars — base -5', lengthPenalty(76), 5)
eq('85 chars — -6', lengthPenalty(85), 6)
eq('100 chars — -7', lengthPenalty(100), 7)
eq('150 chars — -12', lengthPenalty(150), 12)
eq('200 chars — -17', lengthPenalty(200), 17)
eq('230 chars — -20 (cap)', lengthPenalty(230), 20)
eq('400 chars — -20 (cap holds)', lengthPenalty(400), 20)

// PO case: 230-char title was scoring 18/22 (titleScore≈20/25 after only -5).
// New curve: titleScore = 25 - 20 = 5/25. Weighted to 22 → 4.4/22 ≈ 20%.
// That's a real "fix this" signal, not "82% good enough".
const oldScore = 25 - 5
const newScore = 25 - lengthPenalty(230)
console.log(`\nPO's 230-char title: OLD raw titleScore ${oldScore}/25 → NEW raw titleScore ${newScore}/25`)
console.log(`  (weighted to /22: OLD ${Math.round(oldScore / 25 * 22)}/22  →  NEW ${Math.round(newScore / 25 * 22)}/22)`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
