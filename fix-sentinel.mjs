import { readFileSync, writeFileSync } from 'node:fs'
const path = 'src/lib/fba/pushExecutor.ts'
const NUL = String.fromCharCode(0)
let s = readFileSync(path, 'utf8')
const before = s.split(NUL).length - 1
// The only stray bytes are NULs inside the calibration sentinel (NUL + "__CALIBRATION_FAILED__",
// in both the setter and the comparison — self-consistent, which is why it compiled). Removing
// every NUL turns both into the identical clean string '__CALIBRATION_FAILED__' and clears the
// git binary classification. Nothing else in the file contains a NUL (verified by the byte scan).
s = s.split(NUL).join('')
writeFileSync(path, s, 'utf8')
console.log(`removed ${before} NUL byte(s)`)
