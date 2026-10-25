/**
 * The boot declares the same tables on every node, and exactly the three that
 * stay tables: any other declare recreated a shell the operator dropped offline
 * — on an agent, on the HUB (its settings store forwards there, D332).
 */
import { describe, expect, it } from 'vitest'
import { declarePipelineAnalyticsBootCollections } from '../pa-boot-declare.js'
import { makeFakeSettingsStore } from './test-helpers.js'

describe('pipeline-analytics boot declares (every role)', () => {
  it('declares only the tables that stay tables: tracks, media, object-events', async () => {
    const store = makeFakeSettingsStore()
    await declarePipelineAnalyticsBootCollections(store.client)
    expect([...store.declared].toSorted()).toEqual(
      [
        'pipeline-analytics:media',
        'pipeline-analytics:object-events',
        'pipeline-analytics:tracks',
      ].toSorted(),
    )
  })
})
