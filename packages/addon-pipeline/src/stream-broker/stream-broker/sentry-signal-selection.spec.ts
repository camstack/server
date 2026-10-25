import { describe, expect, it } from 'vitest'
import { nextEnabledSignals } from './sentry-signal-selection.js'

const DECLARED = ['motion', 'detection'] as const

describe('nextEnabledSignals', () => {
  it('the FIRST write materialises the complete list, not a diff', () => {
    // Absent means "every declared signal". Switching one off must store the
    // full remaining answer, so a driver that later declares a third signal
    // cannot silently enable it on a camera the operator had already narrowed.
    expect(
      nextEnabledSignals({
        declared: [...DECLARED],
        stored: undefined,
        code: 'detection',
        enabled: false,
      }),
    ).toEqual(['motion'])
  })

  it('switching one ON adds it to an existing list', () => {
    expect(
      nextEnabledSignals({
        declared: [...DECLARED],
        stored: ['motion'],
        code: 'detection',
        enabled: true,
      }),
    ).toEqual(['motion', 'detection'])
  })

  it('is idempotent — the same switch twice says the same thing', () => {
    const once = nextEnabledSignals({
      declared: [...DECLARED],
      stored: ['motion'],
      code: 'motion',
      enabled: true,
    })
    expect(once).toEqual(['motion'])
  })

  it('switching the LAST one off stores an empty list, not absent', () => {
    // Empty is a deliberate "none" and must survive: absent would be read as
    // "all of them", which is the opposite of what the operator just asked.
    expect(
      nextEnabledSignals({
        declared: [...DECLARED],
        stored: ['motion'],
        code: 'motion',
        enabled: false,
      }),
    ).toEqual([])
  })

  it('keeps a stored code the camera no longer declares', () => {
    // A driver that stops offering a signal is not permission to forget the
    // operator's choice about it — if it comes back, their answer is still
    // there.
    expect(
      nextEnabledSignals({
        declared: [...DECLARED],
        stored: ['motion', 'tamper'],
        code: 'detection',
        enabled: true,
      }),
    ).toEqual(['motion', 'detection', 'tamper'])
  })

  it('orders by the DECLARED order, so the store reads like the form', () => {
    expect(
      nextEnabledSignals({
        declared: [...DECLARED],
        stored: ['detection', 'motion'],
        code: 'motion',
        enabled: true,
      }),
    ).toEqual(['motion', 'detection'])
  })
})
