/**
 * What the model SAID, and which pictures produced it.
 *
 * Neither was written anywhere. Not in `SummaryStore` (which persists the `ai`
 * CONFIGURATION and never its output), not in `notificationRules.getHistory`
 * (whose rows carry `id/ruleId/status/subject` and no body), not in
 * `vision-judge.ts` (which logs only a failed downscale and a failed cancel),
 * and not in this module: `chars=452` was the entire trace of 866 calls.
 *
 * The cost of that, measured on 2026-09-15: an audit of this prompt against
 * five operator requirements could establish what we SEND and could not
 * establish a single thing about what comes back. The one known failure — the
 * model calling a moving car "parked" — reached the repo as an operator
 * complaint written into a comment, because there was no line to look up.
 *
 * So the summary text and its roster are logged. This spec is what stops them
 * being tidied away again: a prompt cannot be improved against a metric that
 * does not exist, and the next person to rewrite it will need a before.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'summary-ai.ts'), 'utf8')

/** The body of the success log call. */
const LOGGED = (() => {
  const at = SOURCE.indexOf("logger.info('summary described by the model'")
  return SOURCE.slice(at, SOURCE.indexOf('\n    })', at))
})()

describe('a summary is traceable after the fact', () => {
  it('logs the text the model produced', () => {
    expect(LOGGED).toMatch(/\btext,/)
  })

  // Requirement 5 is "concise", and a character count cannot measure it: the
  // text is already sliced at 600 characters, so `chars` saturates long before
  // a paragraph becomes too long to read.
  it('logs a WORD count, which is the unit the brief is written in', () => {
    expect(LOGGED).toContain('words:')
  })

  // A sentence without its pictures cannot be argued with two days later.
  it('logs the roster that produced it — camera, area and class per image', () => {
    expect(LOGGED).toContain('roster:')
    expect(LOGGED).toContain('deviceName')
    expect(LOGGED).toContain('location')
    expect(LOGGED).toContain('className')
  })

  // The roster travels through the same sanitizers the prompt uses. An operator
  // label reaches this line, and a log is not a place to start trusting one.
  it('sanitises the roster exactly as the prompt does', () => {
    expect(LOGGED).toContain('plainLabel(')
    expect(LOGGED).toContain('plainVocabulary(')
  })
})
