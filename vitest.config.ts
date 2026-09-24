import path from 'node:path'

// Minimal vitest config — mirrors tsconfig.json paths so tests can resolve @/ imports.
//
// CI RUNS THIS SUITE. `.github/workflows/build.yml` runs `pnpm test` (= `vitest run`) as a BLOCKING
// step before the build; the previous comment here said vitest was not run in CI and was stale.
//
// `testTimeout` lives HERE, not on a command line. Every verification run in the Item Highlight
// programme was invoked as `npx vitest run --testTimeout=20000` while CI ran the 5000ms default —
// so sixteen rounds reported "whole repo green" under a laxer condition than the gate, and the
// divergence surfaced only when a 180-permutation sweep (6 designs x 5 pool sizes x 6 chooser-failure
// modes, itemHighlightWriterFixRoundQ1.test.ts) timed out in CI having passed locally. A flag that
// only some runs pass cannot be the contract: the config is the single source of truth, so a local
// `vitest run` and the CI gate agree by construction.
export default {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    testTimeout: 20000,
  },
}
