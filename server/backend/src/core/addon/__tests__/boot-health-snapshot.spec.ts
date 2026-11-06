import { describe, expect, it } from 'vitest'
import { recordBootHealth } from '../boot-health-snapshot.js'

describe('recordBootHealth', () => {
  it('records no failure for a held-back addon, logs it once, and still fails a genuine init failure', () => {
    const failures: string[] = []
    const successes: string[] = []
    const logged: Array<[string, string]> = []
    recordBootHealth({
      entries: [
        ['ok', { packageName: '@camstack/addon-ok', initialized: true }],
        ['held', { packageName: '@camstack/addon-held', initialized: false }],
        ['broken', { packageName: '@camstack/addon-broken', initialized: false }],
      ],
      heldBack: new Map([['held', 'requires @camstack/addon-held >= 0.1.41, installed 0.1.40']]),
      monitor: {
        recordSuccess: (_pkg, id) => successes.push(id),
        recordFailure: (_pkg, _err, id) => failures.push(id),
      },
      logHeldBack: (id, reason) => logged.push([id, reason]),
    })
    expect(successes).toEqual(['ok'])
    expect(failures).toEqual(['broken'])
    expect(logged).toEqual([['held', 'requires @camstack/addon-held >= 0.1.41, installed 0.1.40']])
  })
})
