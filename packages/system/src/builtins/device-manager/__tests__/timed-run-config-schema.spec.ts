import { describe, expect, it } from 'vitest'
import {
  deriveFormContribution,
  parseDerivedFormSettingsPatch,
} from '../device-config-contribution.js'
import { parseTimedRunFormPatch, TIMED_RUN_QUICK_RUN_KEY } from '../timed-run-config-schema.js'

const OPTIONS = { unit: 'min', maxDuration: 180, defaultDuration: 30 } as const
const STATUS = {
  activeUntil: null,
  requestedBy: null,
  quickRun: { duration: 45, unit: 'min' },
  lastFetchedAt: 1,
} as const

describe('timed-run derived form', () => {
  it('derives one number field bounded by the type maximum, valued by the stored run', () => {
    const shape = deriveFormContribution('timed-run', OPTIONS, STATUS)
    const field = shape?.sections[0]?.fields[0]
    expect(shape?.sections[0]?.tab).toBe('general')
    expect(field).toMatchObject({
      type: 'number',
      key: TIMED_RUN_QUICK_RUN_KEY,
      unit: 'min',
      min: 1,
      max: 180,
      default: 45,
    })
  })

  it('falls back to the type default before the first status', () => {
    const field = deriveFormContribution('timed-run', OPTIONS, null)?.sections[0]?.fields[0]
    expect(field).toMatchObject({ default: 30 })
  })

  it('routes the flat patch to setSettings, and ignores a field that did not change', () => {
    expect(parseDerivedFormSettingsPatch('timed-run', { [TIMED_RUN_QUICK_RUN_KEY]: '20' })).toEqual(
      {
        quickRunDuration: 20,
      },
    )
    expect(parseTimedRunFormPatch({})).toEqual({})
  })

  it('a cleared field resets to the default', () => {
    expect(parseTimedRunFormPatch({ [TIMED_RUN_QUICK_RUN_KEY]: '' })).toEqual({
      quickRunDuration: null,
    })
    expect(parseTimedRunFormPatch({ [TIMED_RUN_QUICK_RUN_KEY]: null })).toEqual({
      quickRunDuration: null,
    })
  })

  it('refuses a value that is not a positive number, by name', () => {
    for (const bad of [0, -5, 'abc', Number.NaN]) {
      expect(() => parseTimedRunFormPatch({ [TIMED_RUN_QUICK_RUN_KEY]: bad })).toThrow(
        /positive number/,
      )
    }
  })
})
