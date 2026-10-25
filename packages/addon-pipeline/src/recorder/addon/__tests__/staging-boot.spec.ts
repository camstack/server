import { describe, expect, it } from 'vitest'
import { runStagingBoot } from '../staging-boot.js'

describe('runStagingBoot — a quiet tree before recovery (D667)', () => {
  it('reaps before any staging mutation or writer start, then recovers after the start', async () => {
    const events: string[] = []

    await runStagingBoot({
      reapPredecessorWriters: async () => {
        events.push('reap')
        return true
      },
      sweepUnassignedStaging: async () => {
        events.push('sweep-unassigned')
      },
      now: () => {
        events.push('stamp')
        return 1234
      },
      startWritePath: async () => {
        events.push('start')
      },
      recoverStagedOrphans: async (bootMs) => {
        events.push(`recover:${bootMs}`)
      },
    })
    await Promise.resolve()

    expect(events).toEqual(['reap', 'stamp', 'start', 'recover:1234', 'sweep-unassigned'])
  })

  it('starts recording but touches no staging tree while a known predecessor remains', async () => {
    const events: string[] = []

    await runStagingBoot({
      reapPredecessorWriters: async () => {
        events.push('reap-refused')
        return false
      },
      sweepUnassignedStaging: async () => {
        events.push('sweep-unassigned')
      },
      now: () => 5678,
      startWritePath: async () => {
        events.push('start')
      },
      recoverStagedOrphans: async () => {
        events.push('recover')
      },
    })
    await Promise.resolve()

    expect(events).toEqual(['reap-refused', 'start'])
  })
})
