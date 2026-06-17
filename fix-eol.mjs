import { readFileSync, writeFileSync } from 'node:fs'
const path = 'src/lib/fba/pushExecutor.ts'
const s = readFileSync(path, 'utf8')          // correct content (mojibake already reversed)
const crlf = s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')   // normalize → CRLF to match the repo
writeFileSync(path, crlf, 'utf8')             // utf8, no BOM
console.log(`normalized ${path} to CRLF (${crlf.length} chars)`)
