import path from 'node:path'

// Minimal vitest config — mirrors tsconfig.json paths so tests can resolve @/ imports.
// Vitest is not run in CI (`.github/workflows/build.yml` only runs `next build`); tests here
// are local drift-tripwires + idempotence proofs. Kept dependency-free on purpose.
export default {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
}
