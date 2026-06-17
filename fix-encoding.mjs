import { readFileSync, writeFileSync } from 'node:fs'
const path = 'src/lib/fba/pushExecutor.ts'
// The PS round-trip (Get-Content default=cp1252 → Set-Content utf8+BOM) turned each original
// UTF-8 char into its cp1252-decoded chars, then re-encoded UTF-8. Reverse: read UTF-8 → the
// mojibake string → cp1252-ENCODE it back to the original UTF-8 bytes.
const CP1252 = { 0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F }
let s = readFileSync(path).toString('utf8')
if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1)   // drop the BOM PS added
const bytes = []
let bad = 0
for (const ch of s) {
  const cp = ch.codePointAt(0)
  if (cp <= 0xFF) bytes.push(cp)
  else if (CP1252[cp] != null) bytes.push(CP1252[cp])
  else { bad++; bytes.push(0x3F) }   // '?' — should not happen
}
writeFileSync(path, Buffer.from(bytes))
console.log(`rewrote ${path}: ${bytes.length} bytes, ${bad} unmapped chars`)
