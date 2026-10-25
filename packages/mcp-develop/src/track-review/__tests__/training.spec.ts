import { describe, expect, it } from 'vitest'
import { inTrainingOf, loadTrainingMembership } from '../training.js'
import { FakeHub, frameFor } from './fixtures.js'

describe('loadTrainingMembership', () => {
  it('maps tracks to collection names in one corpus read, not one call per track', async () => {
    const hub = new FakeHub()
    hub.collections.push({
      id: 'c1',
      name: 'review-a',
      createdAt: 1,
      frameCount: 2,
    })
    hub.pageFrames.push(
      frameFor('t1', { collectionIds: ['c1'] }),
      frameFor('t2', { collectionIds: [] }),
    )
    const m = await loadTrainingMembership(hub)
    expect(inTrainingOf('t1', m)).toEqual({ collections: ['review-a'] })
    expect(inTrainingOf('t2', m)).toEqual({ collections: [] })
    expect(inTrainingOf('t3', m)).toBeNull()
    expect(hub.calls.filter((c) => c === 'listRetrainCorpusPage')).toHaveLength(1)
    expect(hub.calls).not.toContain('listRetrainFrames')
  })
})
