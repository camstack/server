import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMMAND_HOLD_MS,
  MAX_COMMAND_HOLD_MS,
  resolveCommandHold,
} from '../command-hold.js'

describe('resolveCommandHold (D1061)', () => {
  it('holds the vocabulary effects for the default limit', () => {
    expect(
      resolveCommandHold('switch', 'setState', { on: true }, { on: false }, undefined),
    ).toEqual({
      effects: [{ field: 'on', value: true }],
      holdMs: DEFAULT_COMMAND_HOLD_MS,
    })
  })

  it("holds nothing for hold: 'never' or a command that leads to no state", () => {
    expect(resolveCommandHold('switch', 'setState', { on: true }, {}, { hold: 'never' })).toBeNull()
    expect(resolveCommandHold('cover', 'stop', {}, {}, undefined)).toBeNull()
  })

  it('replaces or extends the effects, and clamps the limit', () => {
    const replaced = resolveCommandHold(
      'switch',
      'setState',
      { on: true },
      {},
      {
        effects: [{ field: 'state', value: 'starting' }],
        holdMs: 10 * MAX_COMMAND_HOLD_MS,
      },
    )
    expect(replaced).toEqual({
      effects: [{ field: 'state', value: 'starting' }],
      holdMs: MAX_COMMAND_HOLD_MS,
    })
    const extended = resolveCommandHold(
      'switch',
      'setState',
      { on: true },
      { mode: 'eco' },
      {
        extraEffects: [
          { field: 'mode', value: 'manual', when: { field: 'mode', in: ['eco'] } },
          { field: 'on', value: false },
        ],
        holdMs: 0,
      },
    )
    expect(extended).toEqual({
      effects: [
        { field: 'on', value: true },
        { field: 'mode', value: 'manual' },
      ],
      holdMs: 1,
    })
  })
})
