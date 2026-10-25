/** The docs-language guard: Italian prose is red, English, code and glossed quotes are green. */
import { describe, expect, it } from 'vitest'
import { applyAllowlist, findItalianLines, isEnglishGloss } from '../check-docs-english.js'

const count = (src: string): number => findItalianLines(src, 'x.md').length

const Q = 'Il campanello non suona perché quando arriva viene scartato'
const ITALIAN =
  'Il sistema non parte perché la configurazione che viene letta è quella della vecchia versione.'

describe('what the guard refuses', () => {
  it('an unglossed Italian blockquote', () => {
    expect(count(`> ${ITALIAN}\n`)).toBe(1)
    expect(count(`> ${ITALIAN}\n> The system does not start.\n`)).toBe(1)
  })
  it('an Italian paragraph', () => {
    expect(
      count(`# Title\n\n${ITALIAN}\nQuesto è il comportamento che sono costretto a descrivere.\n`),
    ).toBe(2)
  })
  it('an Italian quote with no gloss', () => {
    expect(
      count('The operator said «Il campanello non suona perché quando arriva viene scartato».'),
    ).toBe(1)
    expect(
      count('The operator said "Il campanello non suona perché quando arriva viene scartato".'),
    ).toBe(1)
  })
  it('an empty gloss', () => {
    expect(count('He said «Il campanello non suona perché sono fermi» [ ].')).toBe(1)
  })
  it('Italian after a glossed quote on the same line', () => {
    expect(
      count(
        '«Non suona» [It does not ring] ma questo non è quello che sono andato a vedere perché era già rotto.',
      ),
    ).toBe(1)
  })
  it('a quote whose gloss sits after a blank line (a new paragraph)', () => {
    expect(count(`He said *"${Q}"*\n\n[The doorbell is silent]\n`)).toBe(1)
  })
  it('an unglossed Italian blockquote followed by an unrelated bracket paragraph', () => {
    expect(count(`> ${ITALIAN}\n>\n> English text, no gloss.\n`)).toBe(1)
  })
  it('a gloss that is a placeholder, not prose', () => {
    expect(count('He said «Il campanello non suona perché sono fermi» [x].')).toBe(1)
    expect(count('He said «Il campanello non suona perché sono fermi» [1].')).toBe(1)
  })
  it('a gloss that is itself Italian', () => {
    expect(count('He said «Il campanello non suona» [Il campanello non suona più].')).toBe(1)
    expect(count('He said "non va bene" [non va bene per niente].')).toBe(1)
    expect(
      count(`> ${ITALIAN}\n> [Il sistema non parte perché la configurazione è vecchia.]\n`),
    ).toBe(2)
  })
  it('an Italian heading, short or long', () => {
    expect(count('## Il problema della coda\n')).toBe(1)
    expect(count('### Cosa resta da fare\n')).toBe(1)
    expect(count('## Il campanello\n')).toBe(1)
    expect(count('## La causa vera\n')).toBe(1)
  })
  it('an Italian heading whose quote has no gloss', () => {
    expect(count('## The "il campanello non suona" case\n')).toBe(1)
  })
  it('a short unglossed Italian quote inside an English line', () => {
    expect(count('The operator said "non funziona più" and left.')).toBe(1)
    expect(count('He said "non va bene" twice.')).toBe(1)
    expect(count('She wrote «tutto a posto» in the log.')).toBe(1)
    expect(count('> The operator said "non funziona più" and left.\n')).toBe(1)
  })
  it('a product-copy marker on a different paragraph', () => {
    expect(count(`<!-- docs-english: product-copy -->\nName / Nome\n\n${ITALIAN}\n`)).toBe(1)
  })
})

describe('what the guard accepts', () => {
  it('a short Italian quote with an English gloss', () => {
    expect(count('The operator said "non funziona più" [it no longer works] and left.')).toBe(0)
    expect(count('## The "il campanello non suona" [the doorbell does not ring] case\n')).toBe(0)
  })
  it('English headings, hyphenated compounds and two-letter glosses', () => {
    expect(count('## Non-goals\n\n### Per-camera eligibility\n')).toBe(0)
    expect(count('The "per camera" and "non-blocking" labels, plus "in the hub".')).toBe(0)
    expect(isEnglishGloss('ok')).toBe(true)
    expect(isEnglishGloss('x')).toBe(false)
    expect(isEnglishGloss('1')).toBe(false)
    expect(isEnglishGloss('the doorbell does not ring')).toBe(true)
    expect(isEnglishGloss('Il campanello non suona')).toBe(false)
  })
  it('English prose', () => {
    expect(
      count('The doorbell did not ring because the event was dropped when the queue was full.\n'),
    ).toBe(0)
  })
  it('Italian inside a code fence and inline code', () => {
    expect(count(`\`\`\`\n${ITALIAN}\n\`\`\`\n\nUse \`${ITALIAN}\` verbatim.\n`)).toBe(0)
  })
  it('an English blockquote', () => {
    expect(count('> The doorbell does not ring because the event is dropped.\n')).toBe(0)
  })
  it('an Italian blockquote glossed on the next line', () => {
    expect(count(`> ${ITALIAN}\n> [The system does not start.]\n`)).toBe(0)
  })
  it('an Italian blockquote with an inline gloss', () => {
    expect(count(`> ${ITALIAN} [The system does not start.]\n`)).toBe(0)
  })
  it('a guillemet quote followed by a bracketed translation', () => {
    expect(
      count(
        'The operator said «Il campanello non suona perché quando arriva viene scartato» [The doorbell does not ring because it is dropped on arrival].',
      ),
    ).toBe(0)
  })
  it('a straight and a curly quote followed by a translation', () => {
    expect(
      count(
        'He said "Il campanello non suona perché sono fermi" [The doorbell is silent because they are stopped].',
      ),
    ).toBe(0)
    expect(
      count(
        'He said “Il campanello non suona perché sono fermi” [The doorbell is silent because they are stopped].',
      ),
    ).toBe(0)
  })
  it('a quote wrapping across lines of one paragraph', () => {
    expect(
      count(
        'He said «Il campanello non suona\nperché quando arriva viene scartato» [The doorbell is silent]\nand left.',
      ),
    ).toBe(0)
  })
  it('a quote wrapped in emphasis, with a gloss', () => {
    expect(count(`He said *"${Q}"* [The doorbell is silent].`)).toBe(0)
    expect(count(`He said _«${Q}»_ [The doorbell is silent].`)).toBe(0)
    expect(count(`He said **"${Q}"** [The doorbell is silent].`)).toBe(0)
  })
  it('punctuation and emphasis between the closing quote and the gloss', () => {
    expect(count(`He said *"${Q}"*, [The doorbell is silent].`)).toBe(0)
    expect(count(`He said «${Q}.»*: [The doorbell is silent].`)).toBe(0)
  })
  it('a short attribution after a dash before the gloss', () => {
    expect(count(`*"${Q}"* — the operator. [The doorbell is silent]`)).toBe(0)
  })
  it('a multi-line quote with the gloss on the next line of the paragraph', () => {
    expect(
      count(
        `Operator: *"Il campanello non\nsuona perché quando arriva\nviene scartato"*\n[The doorbell is silent]\n`,
      ),
    ).toBe(0)
  })
  it('a quote inside a blockquote with a gloss paragraph after a blank > line', () => {
    expect(count(`> *"${Q}"*\n>\n> [The doorbell is silent]\n`)).toBe(0)
    expect(count(`> ${ITALIAN}\n> ${ITALIAN}\n>\n> [The system does not start.]\n`)).toBe(0)
    expect(count(`> *"${Q}\n> e di nuovo che sono qui"* [Gloss here]\n`)).toBe(0)
  })
  it('a heading containing a glossed quote', () => {
    expect(count(`### The request: «${Q}» (not built)\n\n`)).toBe(1)
    expect(count(`### The request: «${Q}» [The doorbell is silent] (not built)\n`)).toBe(0)
  })
  it('an English possessive is not an Italian elision', () => {
    expect(
      count("The auth-catch-all's dual cookie support and ArchiveList's fetch idiom, c's value."),
    ).toBe(0)
  })
  it('a gloss paragraph covering a multi-paragraph blockquote', () => {
    expect(count(`> ${ITALIAN}\n>\n> - ${ITALIAN}\n>\n> [The system does not start.]\n`)).toBe(0)
  })
  it('a code span wrapped over two lines', () => {
    expect(
      count('See `ATTENZIONE: registrazione disponibile\nsolo per il N% della finestra` here.'),
    ).toBe(0)
  })
  it('a paragraph carrying the product-copy marker', () => {
    expect(
      count(
        `<!-- docs-english: product-copy -->\n| key | en | it |\n| a | ${ITALIAN} | ${ITALIAN} |\n`,
      ),
    ).toBe(0)
  })
})

describe('allowlist', () => {
  const findings = findItalianLines(`${ITALIAN}\n`, 'a.md')
  it('removes an exact file + text match', () => {
    const r = applyAllowlist(findings, [{ file: 'a.md', text: ITALIAN, why: 'verbatim log' }])
    expect(r.remaining).toHaveLength(0)
    expect(r.unused).toHaveLength(0)
  })
  it('reports an entry that matches nothing', () => {
    const r = applyAllowlist(findings, [{ file: 'b.md', text: ITALIAN, why: 'stale' }])
    expect(r.remaining).toHaveLength(1)
    expect(r.unused).toHaveLength(1)
  })
})
