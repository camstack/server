/**
 * `node-removal-hook` implementer (#265): forgetting a node removes the LLM
 * profiles that only mean something on it — the Mac agent's
 * `mac-local-qwen25-1_5b` stayed behind with `providerConfig.nodeId` of a node
 * that no longer exists.
 */
import { describe, expect, it } from 'vitest'
import { ProfileStore } from '../profile-store.js'
import { createNodeRemovalHook } from '../node-removal.js'
import { makeAiRecords } from './support/fake-records.js'
import { makeTestLogger } from './support/logger.js'
import { makeProfile } from './support/profile.js'

async function setup() {
  const world = await makeAiRecords()
  const store = ProfileStore.of(world.records)
  return { store, hook: createNodeRemovalHook({ store, logger: makeTestLogger() }) }
}

describe('addon-ai node-removal-hook', () => {
  it('removes the managed-local and apple profiles bound to the forgotten node only', async () => {
    const { store, hook } = await setup()
    await store.upsert(
      makeProfile({
        id: 'mac-local',
        kind: 'managed-local',
        providerConfig: { nodeId: 'mac.local' },
      }),
    )
    await store.upsert(
      makeProfile({ id: 'mac-apple', kind: 'apple-foundation', providerConfig: { nodeId: 'mac.local' } }),
    )
    await store.upsert(
      makeProfile({
        id: 'other-local',
        kind: 'managed-local',
        providerConfig: { nodeId: 'agent-2' },
      }),
    )
    await store.upsert(makeProfile({ id: 'cloud' }))

    const result = await hook.onNodeRemoved({ nodeId: 'mac.local', removedAt: 1 })

    expect(result.counts).toEqual({ 'llm-profiles': 2 })
    expect((await store.list()).map((p) => p.id).sort()).toEqual(['cloud', 'other-local'])
  })

  it('is idempotent: a second call finds nothing and answers zero', async () => {
    const { store, hook } = await setup()
    await store.upsert(
      makeProfile({ id: 'mac-local', kind: 'managed-local', providerConfig: { nodeId: 'mac.local' } }),
    )
    await hook.onNodeRemoved({ nodeId: 'mac.local', removedAt: 1 })
    const again = await hook.onNodeRemoved({ nodeId: 'mac.local', removedAt: 1 })
    expect(again.counts).toEqual({ 'llm-profiles': 0 })
  })
})
