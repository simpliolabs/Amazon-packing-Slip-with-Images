/**
 * ONE ITEM-HIGHLIGHT REPEAT RULE — the generator and the push boundary must answer the same
 * question the same way.
 *
 * Until 2026-08-18 they did not. Three axes disagreed at once:
 *
 *                        threshold        tokenizer          stopwords
 *   generator validator  c > 1 (ONCE)     highlightTokens    HIGHLIGHT_STOPWORDS
 *   push boundary        > 2   (TWICE)    local split        IH_TRIVIAL
 *
 * Amazon's rule is TWICE — the push-boundary docstring records a real SKU rejection that also
 * blocked an unrelated TITLE push, because Amazon re-validates the whole item on any PATCH.
 *
 * So the GENERATOR was stricter than the marketplace: it rejected values the door would have
 * shipped untouched. The corrective-retry loop spent turns chasing a constraint that does not
 * exist, and the deterministic fallback dropped descriptive phrases it never needed to drop.
 *
 * It also blocked the seller's 2026-08-18 request to source more descriptive terms from the keyword
 * bank — their example "Graphic Tee for Women" folds `tee` to `shirt`.
 */
import { describe, it, expect } from 'vitest'
import {
  ihRepeatViolations,
  ihFoldWord,
  IH_MAX_WORD_REPEATS,
  IH_INSIGNIFICANT,
  capItemHighlightRepeats,
  IH_GARMENT_HEAD_FOLDED,
  ihRepeatBudget,
  classifyStoredIhLine,
} from './productDetailAttrs'
import { GARMENT_HEAD_WORDS } from './garmentNoun'

describe('the canonical rule matches Amazon, not a stricter invention', () => {
  it('Amazon allows a word TWICE — that is the shipped threshold', () => {
    expect(IH_MAX_WORD_REPEATS).toBe(2)
    expect(ihRepeatViolations('comfort colors shirt, graphic shirt')).toEqual([])
  })

  it('THREE occurrences is the violation — the case that got a real SKU rejected', () => {
    const v = ihRepeatViolations('comfort colors tshirt, comfort colors shirt, comfort colors tee')
    expect(v).toContain('comfort')
    expect(v).toContain('color')
  })

  it("THE SELLER'S CASE: 'Graphic Tee for Women' beside one garment mention is LEGAL", () => {
    // tee folds to shirt, so under the old c > 1 generator rule this was rejected while the push
    // boundary would have shipped it. That mismatch is what blocked keyword-bank sourcing.
    const value = '100% cotton shirt, graphic tee for women'
    expect(ihRepeatViolations(value)).toEqual([])
    // And the door agrees — it does not drop the phrase.
    expect(capItemHighlightRepeats(value)).toBe(value)
  })
})

describe('the fold is one implementation', () => {
  it('collapses the tshirt/shirt family and plurals to a single token', () => {
    for (const w of ['tshirt', 'tshirts', 'shirt', 'shirts', 'Shirts', 'T-Shirt']) {
      expect(ihFoldWord(w), w).toBe('shirt')
    }
  })

  it('strips punctuation so "colors," and "colors" are the same word', () => {
    expect(ihFoldWord('colors,')).toBe(ihFoldWord('colors'))
    expect(ihFoldWord('Comfort')).toBe('comfort')
  })
})

describe('the insignificant set is the UNION of the two historical sets', () => {
  it("keeps the push boundary's words", () => {
    for (const w of ['for', 'and', 'the', 'with', 'on', 'or', 'your']) {
      expect(IH_INSIGNIFICANT.has(w), w).toBe(true)
    }
  })

  it("keeps the generator's extra words too — union, not a pick", () => {
    // A word wrongly counted as SIGNIFICANT causes a false rejection, which costs the seller a
    // legal phrase. Union is the safe direction; picking one set would have dropped words.
    for (const w of ['great', 'her', 'his']) {
      expect(IH_INSIGNIFICANT.has(w), w).toBe(true)
    }
  })

  it('trivial words never trigger a violation however often they appear', () => {
    expect(ihRepeatViolations('for her and for him and for your dog and for the cat')).toEqual([])
  })
})

describe('the validator and the door cannot disagree', () => {
  it('anything the rule calls compliant is shipped UNCHANGED by the door', () => {
    const compliant = [
      '100% cotton fabric, relaxed unisex fit, soft breathable feel',
      'comfort colors shirt, graphic tee for women',
      'classic crew neck, ideal for casual everyday wear',
    ]
    for (const v of compliant) {
      expect(ihRepeatViolations(v), v).toEqual([])
      expect(capItemHighlightRepeats(v), v).toBe(v)
    }
  })

  it('and anything the door TRIMS was flagged by the rule first', () => {
    const offending = 'comfort colors shirt, comfort colors tshirt, comfort colors tee shirt'
    expect(ihRepeatViolations(offending).length).toBeGreaterThan(0)
    expect(capItemHighlightRepeats(offending)).not.toBe(offending)
  })

  it('is total — empty and whitespace input never throw', () => {
    expect(ihRepeatViolations('')).toEqual([])
    expect(ihRepeatViolations('   ')).toEqual([])
  })
})

/* ─── TASK 8 (2026-09-07, PO RULING verbatim "A: 2 - Sweatshirt/ crewneck/, Tee Shirt/t-Shirt/
 * tshirt/Shirt"): the garment head noun is the ONE exception to the absolute no-repeat rule — it
 * may appear up to Amazon's own cap (`IH_MAX_WORD_REPEATS`, 2); every other significant word stays
 * at budget 1. `ihRepeatBudget` is the ONE function every consumer (the composer's tier/admission,
 * `lineHasSignificantRepeat`/`classifyStoredIhLine`) reads — never a second list, never the literal
 * `2` written anywhere but here. */
describe('TASK 8: ihRepeatBudget — the ONE exemption, derived from GARMENT_HEAD_WORDS, never a second list', () => {
  it('DERIVATION PIN: IH_GARMENT_HEAD_FOLDED is exactly the fold of GARMENT_HEAD_WORDS — a local list would fail this', () => {
    const expected = new Set([...GARMENT_HEAD_WORDS].map(ihFoldWord))
    expect(new Set(IH_GARMENT_HEAD_FOLDED)).toEqual(expected)
  })

  it('ENUMERATION PIN: every one of the PO\'s six verbatim forms folds INTO the exempt set', () => {
    for (const form of ['Sweatshirt', 'crewneck', 'Tee Shirt', 't-Shirt', 'tshirt', 'Shirt']) {
      for (const word of form.split(/\s+/)) {
        expect(IH_GARMENT_HEAD_FOLDED.has(ihFoldWord(word)), `${form} -> ${word}`).toBe(true)
      }
    }
  })

  it('non-garment significant words are NOT in the exempt set', () => {
    for (const w of ['women', 'sleeve', 'graphic', 'funny']) {
      expect(IH_GARMENT_HEAD_FOLDED.has(ihFoldWord(w)), w).toBe(false)
    }
  })

  it('budget is 2 (Amazon\'s cap, IH_MAX_WORD_REPEATS) for a garment head noun, 1 for everything else', () => {
    for (const w of ['sweatshirt', 'crewneck', 'tee', 'shirt', 'hoodie', 'pullover']) {
      expect(ihRepeatBudget(ihFoldWord(w)), w).toBe(IH_MAX_WORD_REPEATS)
    }
    for (const w of ['women', 'sleeve', 'graphic', 'funny', 'cotton']) {
      expect(ihRepeatBudget(ihFoldWord(w)), w).toBe(1)
    }
  })
})

/* ─── TASK 8: `lineHasSignificantRepeat`/`classifyStoredIhLine` — the STORED-LINE half of the same
 * budget. A line stored before this ruling (or a manual DB edit) is judged by the SAME
 * `ihRepeatBudget`, never a second rule, so the seam (push) and the card (pre-flight) can never
 * disagree with the composer about what a "repeat" is. */
describe('TASK 8: classifyStoredIhLine honors the garment exemption', () => {
  it('tee x2 -> ok (was repeat-in-stored-line before this ruling)', () => {
    expect(classifyStoredIhLine('Graphic Novelty Tee for Men, Funny Tee Gift Idea Today, Ring-Spun Cotton, Classic Fit')).toBe('ok')
  })

  it('tee x3 -> repeat-in-stored-line — Amazon\'s own cap (2) still refuses a THIRD mention', () => {
    expect(classifyStoredIhLine('Graphic Novelty Tee for Men, Funny Tee Gift Idea Today, Classic Tee Style, Ring-Spun Cotton')).toBe('repeat-in-stored-line')
  })

  it('women x2 -> repeat-in-stored-line — a non-garment significant word never gets the exemption', () => {
    expect(classifyStoredIhLine('Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Classic Fit')).toBe('repeat-in-stored-line')
  })

  it('the LIVE stored falsehood\'s neighbour stays refused: "Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Graphic Crewneck, 50% Cotton / 50% Polyester, Classic Fit" (women twice)', () => {
    expect(classifyStoredIhLine('Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Graphic Crewneck, 50% Cotton / 50% Polyester, Classic Fit')).toBe('repeat-in-stored-line')
  })
})
