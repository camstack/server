/**
 * `node-removal-hook` implementer (#265): a forgotten node's model files are
 * gone with it, so "On nodes" must stop listing it.
 */
import { describe, expect, it } from 'vitest'
import { createDurableState, type IScopedLogger } from '@camstack/types'
import { ModelAvailabilityMapSchema } from '../model-studio-actions.js'
import { createNodeRemovalHook } from '../node-removal.js'

const FORMATS = { formats: { onnx: { sha256: 'abc', bytes: 1, at: 1 } } }

function handle(initial: Record<string, unknown>) {
  let blob: Record<string, unknown> = { availability: initial }
  const state = createDurableState({
    key: 'availability',
    schema: ModelAvailabilityMapSchema,
    fallback: {},
    read: async () => blob,
    write: async (patch) => {
      blob = { ...blob, ...patch }
    },
  })
  const log: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    withTags: () => log,
  }
  return { state, hook: createNodeRemovalHook({ availability: () => state, logger: log }) }
}

describe('model-studio node-removal-hook', () => {
  it('drops the forgotten node and prunes a model left with no node', async () => {
    const { state, hook } = handle({
      'yolo-a': { 'agent-1': FORMATS },
      'yolo-b': { 'agent-1': FORMATS, hub: FORMATS },
      'yolo-c': { hub: FORMATS },
    })
    const r = await hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })
    expect(r.counts).toEqual({ 'model-availability': 2 })
    expect(Object.keys(await state.get()).toSorted()).toEqual(['yolo-b', 'yolo-c'])
    expect(Object.keys((await state.get())['yolo-b']!)).toEqual(['hub'])
  })

  it('is idempotent', async () => {
    const { hook } = handle({ 'yolo-a': { 'agent-1': FORMATS } })
    await hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })
    const again = await hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })
    expect(again.counts).toEqual({ 'model-availability': 0 })
  })
})
