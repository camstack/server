/**
 * A Gateway persisted but not restored yet is found by stableId, so adoption does not
 * create a second device for the same station.
 */
import { describe, expect, it } from 'vitest'
import { findExistingGateway } from '../ecowitt-integration-devices.js'

describe('findExistingGateway', () => {
  const stableId = 'ecowitt:x:device'

  it('finds a Gateway persisted but not restored, by stableId (live list is empty)', async () => {
    const found = await findExistingGateway({
      stableId,
      live: async () => [],
      saved: [
        { id: 7, stableId: 'other' },
        { id: 8, stableId },
      ],
    })
    expect(found).toBe(8)
  })

  it('prefers a live device and answers null when none holds the stableId', async () => {
    expect(
      await findExistingGateway({ stableId, live: async () => [{ id: 3, stableId }], saved: [] }),
    ).toBe(3)
    expect(await findExistingGateway({ stableId, live: async () => [], saved: [] })).toBeNull()
  })
})
