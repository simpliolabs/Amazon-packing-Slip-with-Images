// PR #214 — changedDetailFields (the idempotency core), mirrored line-for-line from pushExecutor.
function changedDetailFields(currents, desired, eligibleFields) {
  return eligibleFields.filter((f) => {
    const want = (desired[f] ?? '').trim()
    if (!want) return false
    return (currents[f] ?? '').trim() !== want
  })
}
let pass = 0, fail = 0
const eq = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log('  ok ', n) } else { fail++; console.log('  FAIL', n, 'got', JSON.stringify(g), 'want', JSON.stringify(w)) } }

const keys = ['neck', 'sleeve', 'fit_type', 'material', 'department', 'theme', 'occasion']
const desired = { neck: 'Crew Neck', sleeve: 'short_sleeve', fit_type: 'Relaxed', material: 'Cotton', department: 'Unisex', theme: 'Funny', occasion: 'Everyday Wear' }

// fresh SKU, nothing set → all 7 changed (first push)
eq('all changed on empty SKU', changedDetailFields({}, desired, keys).length, 7)

// SKU already fully correct → ZERO changed (idempotent re-run skips it entirely)
eq('fully-correct SKU → none', changedDetailFields({ ...desired }, desired, keys), [])

// partial: 3 already correct, 4 differ → only the 4 differ (re-run after partial failure)
const partial = { neck: 'Crew Neck', sleeve: 'short_sleeve', fit_type: 'Relaxed' }   // material/department/theme/occasion missing
eq('partial → only the 4 still-wrong', changedDetailFields(partial, desired, keys), ['material', 'department', 'theme', 'occasion'])

// trim: trailing whitespace on the live value still counts as equal
eq('trim equal', changedDetailFields({ neck: ' Crew Neck ' }, { neck: 'Crew Neck' }, ['neck']), [])

// unknown current (read failure → undefined) → CHANGED (push, preview guards)
eq('unknown current → changed', changedDetailFields({}, { neck: 'Crew Neck' }, ['neck']), ['neck'])

// empty desired (a field with no value) → never pushed
eq('empty desired → skipped', changedDetailFields({}, { neck: '' }, ['neck']), [])

// a field NOT in eligible list is never returned even if it differs
eq('non-eligible ignored', changedDetailFields({ color: 'Red' }, { color: 'Blue', neck: 'Crew Neck' }, ['neck']), ['neck'])

// case sensitivity: Amazon values are case-exact, so different case = changed
eq('case-different → changed', changedDetailFields({ neck: 'crew neck' }, { neck: 'Crew Neck' }, ['neck']), ['neck'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
