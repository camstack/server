/**
 * `debug.tape.promote` refuses free text the settings store would hand back
 * decoded (follow-up 102, fix round 1, review M2): a `scenario` or `note` that
 * is WHOLE valid JSON starting with `[` or `{` comes back from the SQLite
 * backend as an array or object (`decodeColumnValue` decodes by content). It
 * is refused by name at the input, instead of becoming a row the index cannot
 * read.
 *
 * Disarm: drop the refinement from `PromoteInputSchema`: this test goes RED.
 */
import { describe, expect, it } from 'vitest'
import { PromoteInputSchema } from '../tape-actions.js'

const BASE = { deviceId: 102, fromMs: 1, toMs: 2, scenario: 'parked-cars' }

describe('debug.tape.promote input', () => {
  it('accepts ordinary text, and text that only looks like JSON', () => {
    for (const scenario of ['parked-cars', '[102] parked', '{not json', ' []'])
      expect([scenario, PromoteInputSchema.safeParse({ ...BASE, scenario }).success]).toEqual([
        scenario,
        true,
      ])
  })

  it('refuses a scenario or note that is whole JSON array/object text, by name', () => {
    const scenario = PromoteInputSchema.safeParse({ ...BASE, scenario: '[]' })
    const note = PromoteInputSchema.safeParse({ ...BASE, note: '{"why":"parked"}' })
    expect([scenario.success, note.success]).toEqual([false, false])
    expect(scenario.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['scenario', expect.stringContaining('JSON')],
    ])
    expect(note.error?.issues.map((i) => i.path.join('.'))).toEqual(['note'])
  })
})
