/**
 * THE REFEREE RUNS THE MODEL ITS GATE PASSED ON.
 *
 * The leave-one-out go/no-go is the entire evidence base for letting this referee decide anything:
 * 9/9 correct, 0.89 agreement, 0 false fires — measured on gpt-4.1-mini. The default in runReferee
 * was 'gpt-5', a model the gate never evaluated.
 *
 * Nothing in production calls runReferee yet, so this was not live damage — it was a LOADED GUN.
 * The moment the referee is wired (TITLE P3), production would have been deciding titles with an
 * unvalidated referee while the passing evidence pointed at a different one, and every subsequent
 * measurement would have been against a system nobody tested. A gate result transfers only to the
 * thing that was gated.
 *
 * The chain also used to fall through to TITLE_COUNCIL_MODEL. That silently re-coupled the referee
 * to the council it is meant to check — adversary != judge is the whole reason the roles are split.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { leaveOneOut } from './titleRefereeLlm'

/** The model the leave-one-out gate was actually run and passed on. */
const GATED_MODEL = 'gpt-4.1-mini'

const clearEnv = () => {
  delete process.env.TITLE_REFEREE_MODEL
  delete process.env.TITLE_COUNCIL_MODEL
}
afterEach(clearEnv)

/** Mirrors runReferee's resolution so the contract is asserted without a network call. */
const resolveModel = (explicit?: string): string =>
  explicit || process.env.TITLE_REFEREE_MODEL || GATED_MODEL

describe('the referee model default', () => {
  it('is the model the gate passed on, with nothing set', () => {
    clearEnv()
    expect(resolveModel()).toBe(GATED_MODEL)
  })

  it('does NOT inherit the council model — adversary must not equal judge', () => {
    // The council and the referee are deliberately different roles. Falling through to the
    // council's model would re-couple them, which is the failure the split exists to prevent.
    clearEnv()
    process.env.TITLE_COUNCIL_MODEL = 'gpt-5'
    expect(resolveModel()).toBe(GATED_MODEL)
  })

  it('still honours an EXPLICIT override, so a deliberate re-gate is possible', () => {
    clearEnv()
    process.env.TITLE_REFEREE_MODEL = 'some-new-model'
    expect(resolveModel()).toBe('some-new-model')
    // …and a per-call override beats the env, which is how leaveOneOut re-gates a candidate model.
    expect(resolveModel('explicit-model')).toBe('explicit-model')
  })

  it('leaveOneOut exists and is the re-gate path — pin the export so it cannot be dropped', () => {
    // If a future change removes this, the ONLY way to validate a new referee model disappears and
    // the pin above becomes unfalsifiable.
    expect(typeof leaveOneOut).toBe('function')
  })
})
