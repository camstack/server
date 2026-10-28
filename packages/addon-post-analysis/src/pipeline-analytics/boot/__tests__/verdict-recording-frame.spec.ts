import type { RetrainCollection } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  VERDICT_COLLECTION_NAME,
  addVerdictFrameFromRecording,
  type VerdictFrameApi,
} from '../verdict-recording-frame.js'

const col = (id: string, name: string): RetrainCollection => ({
  id,
  name,
  createdAt: 1,
  frameCount: 0,
})

function fakeApi(collections: RetrainCollection[]) {
  const added: { collectionId: string; deviceId: number; epochMs: number }[] = []
  const create = vi.fn(async (name: string) => {
    const collection = col('new-1', name)
    collections.push(collection)
    return { kind: 'created' as const, collection }
  })
  const api: VerdictFrameApi = {
    listRetrainCollections: async () => collections,
    createRetrainCollection: create,
    addRetrainFrameFromRecording: async (input) => {
      added.push(input)
      return { kind: 'added' as const }
    },
  }
  return { api, added, create }
}

describe('addVerdictFrameFromRecording', () => {
  it('creates the collection on first need and reuses it afterwards', async () => {
    const { api, added, create } = fakeApi([col('other', 'Porch')])
    const log = makeSilentLogger()
    expect(await addVerdictFrameFromRecording(api, log, { deviceId: 5, epochMs: 10 })).toEqual({
      ok: true,
    })
    await addVerdictFrameFromRecording(api, log, { deviceId: 5, epochMs: 20 })
    expect(create).toHaveBeenCalledTimes(1)
    expect(added.map((a) => a.collectionId)).toEqual(['new-1', 'new-1'])
  })

  it('adopts an existing collection by name, case-insensitively, without creating', async () => {
    const { api, added, create } = fakeApi([col('mine', VERDICT_COLLECTION_NAME.toUpperCase())])
    await addVerdictFrameFromRecording(api, makeSilentLogger(), { deviceId: 5, epochMs: 10 })
    expect(create).not.toHaveBeenCalled()
    expect(added[0]?.collectionId).toBe('mine')
  })

  it('names a recording refusal', async () => {
    const { api } = fakeApi([col('mine', VERDICT_COLLECTION_NAME)])
    const refusing: VerdictFrameApi = {
      ...api,
      addRetrainFrameFromRecording: async () => ({
        kind: 'refused',
        reason: 'still-unavailable',
        detail: 'gap',
      }),
    }
    expect(
      await addVerdictFrameFromRecording(refusing, makeSilentLogger(), {
        deviceId: 5,
        epochMs: 10,
      }),
    ).toEqual({ ok: false, reason: 'still-unavailable', detail: 'gap' })
  })
})
