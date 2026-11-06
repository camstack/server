import { describe, expect, it } from 'vitest'
import { recordBootHealth } from '../boot-health-snapshot.js'

describe('recordBootHealth', () => {
  it('records a success for an initialized addon and a failure for one that did not initialize', () => {
    const calls: string[] = []
    recordBootHealth({
      entries: [
        ['ok', { packageName: '@camstack/addon-ok', initialized: true }],
        ['broken', { packageName: '@camstack/addon-broken', initialized: false }],
      ],
      monitor: {
        recordSuccess: (_p, id) => calls.push(`success:${id}`),
        recordFailure: (_p, _e, id) => calls.push(`failure:${id}`),
      },
    })
    expect(calls).toEqual(['success:ok', 'failure:broken'])
  })
})
