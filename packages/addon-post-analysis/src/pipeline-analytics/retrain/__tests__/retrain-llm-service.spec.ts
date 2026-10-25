/**
 * The AI-vision assist over a fake `llm` cap: the profile gates (vision,
 * enabled, cloud needs the operator's confirmation), the request carries the
 * copy's pixels, and the answer becomes `source: 'llm'` drafts and reviews —
 * or a named refusal. No real model is ever called.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'
import {
  type LlmProfileView,
  type LlmVisionRequest,
  type LlmVisionResult,
  RetrainLlmAssistService,
} from '../retrain-llm-service.js'
import { jpegOf, memoryBlobs } from './retrain-fixtures.js'

const AT = 1_700_000_000_000

const LOCAL: LlmProfileView = {
  id: 'mac-qwen',
  name: 'Mac Qwen3-VL',
  model: 'qwen/qwen3-vl-8b',
  kind: 'openai-compatible',
  baseUrl: 'http://192.168.1.40:1234/v1',
  enabled: true,
  supportsVision: true,
}
const CLOUD: LlmProfileView = {
  id: 'claude',
  name: 'Cloud vision',
  model: 'vision-model',
  kind: 'anthropic',
  enabled: true,
  supportsVision: true,
}
const TEXT_ONLY: LlmProfileView = { ...LOCAL, id: 'text', supportsVision: false }

interface Harness {
  readonly service: RetrainLlmAssistService
  readonly requests: LlmVisionRequest[]
  readonly frameId: string
  answer(result: LlmVisionResult): void
}

async function harness(): Promise<Harness> {
  const { ledgers } = await makeAnalyticsWorld()
  const frames = new RetrainFrameStore({
    frameLedger: ledgers.retrainFrames,
    storage: memoryBlobs(),
    logger: makeSilentLogger(),
    now: () => AT,
    readSource: async () => null,
  })
  const stored = await frames.storeRecordingStill({
    deviceId: 101,
    epochMs: AT,
    bytes: jpegOf(1920, 1080),
  })
  if (stored.kind !== 'copied') throw new Error('expected a copy')
  const requests: LlmVisionRequest[] = []
  let next: LlmVisionResult = {
    ok: true,
    model: 'qwen/qwen3-vl-8b',
    text: JSON.stringify({
      objects: [
        { class: 'person', box: [0.1, 0.2, 0.1, 0.3], confidence: 0.7, reason: 'by the gate' },
      ],
      reviews: [{ ref: 'b1', verdict: 'not-an-object', reason: 'this is a plant' }],
    }),
  }
  const service = new RetrainLlmAssistService({
    frames,
    llm: {
      listProfiles: async () => [LOCAL, CLOUD, TEXT_ONLY],
      generateVision: async (request) => {
        requests.push(request)
        return next
      },
    },
    logger: makeSilentLogger(),
  })
  return {
    service,
    requests,
    frameId: stored.frame.frameId,
    answer: (result) => {
      next = result
    },
  }
}

const BOX = { ref: 'b1', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.2 }, macroClass: 'person' as const }

describe('RetrainLlmAssistService', () => {
  let h: Harness

  beforeEach(async () => {
    h = await harness()
  })

  it('lists only enabled vision profiles, each saying whether the frame leaves the house', async () => {
    expect(await h.service.listProfiles()).toEqual([
      {
        id: 'mac-qwen',
        name: 'Mac Qwen3-VL',
        model: 'qwen/qwen3-vl-8b',
        kind: 'openai-compatible',
        leavesHouse: false,
      },
      {
        id: 'claude',
        name: 'Cloud vision',
        model: 'vision-model',
        kind: 'anthropic',
        leavesHouse: true,
      },
    ])
  })

  it('sends the copy and the boxes, and answers llm drafts plus reviews', async () => {
    const result = await h.service.propose({
      deviceId: 101,
      frameId: h.frameId,
      profileId: 'mac-qwen',
      classes: ['person', 'vehicle'],
      boxes: [BOX],
      allowCloud: false,
    })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.profileId).toBe('mac-qwen')
    expect(h.requests[0]?.image).toEqual(jpegOf(1920, 1080))
    expect(h.requests[0]?.prompt).toContain('"ref":"b1"')
    expect(result).toEqual({
      kind: 'proposed',
      profileId: 'mac-qwen',
      model: 'qwen/qwen3-vl-8b',
      leftHouse: false,
      proposals: [
        {
          bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.3 },
          macroClass: 'person',
          kind: 'subject',
          source: 'llm',
          assistModelId: 'qwen/qwen3-vl-8b',
          assistScore: 0.7,
          // The snapshot an accepted box keeps, so a review can tell it from an edit.
          origin: {
            source: 'llm',
            ref: 'llm:0',
            bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.3 },
            macroClass: 'person',
            score: 0.7,
            modelId: 'qwen/qwen3-vl-8b',
          },
          reason: 'by the gate',
        },
      ],
      reviews: [{ ref: 'b1', verdict: 'not-an-object', reason: 'this is a plant' }],
      rejected: 0,
    })
  })

  it('a cloud profile is refused unless the operator confirmed the frame may leave', async () => {
    const refused = await h.service.propose({
      deviceId: 101,
      frameId: h.frameId,
      profileId: 'claude',
      classes: ['person'],
      boxes: [],
      allowCloud: false,
    })
    expect(refused).toMatchObject({ kind: 'refused', reason: 'cloud-not-confirmed' })
    expect(h.requests).toHaveLength(0)

    const sent = await h.service.propose({
      deviceId: 101,
      frameId: h.frameId,
      profileId: 'claude',
      classes: ['person'],
      boxes: [],
      allowCloud: true,
    })
    expect(sent).toMatchObject({ kind: 'proposed', leftHouse: true })
  })

  it('names every other refusal', async () => {
    const base = {
      deviceId: 101,
      frameId: h.frameId,
      classes: ['person' as const],
      boxes: [],
      allowCloud: false,
    }
    expect(await h.service.propose({ ...base, profileId: 'nope' })).toMatchObject({
      reason: 'unknown-profile',
    })
    expect(await h.service.propose({ ...base, profileId: 'text' })).toMatchObject({
      reason: 'no-vision',
    })
    expect(
      await h.service.propose({ ...base, profileId: 'mac-qwen', deviceId: 102 }),
    ).toMatchObject({ reason: 'unknown-frame' })
    h.answer({ ok: false, code: 'timeout', message: 'no first token in 120 s' })
    expect(await h.service.propose({ ...base, profileId: 'mac-qwen' })).toEqual({
      kind: 'refused',
      reason: 'llm-error',
      detail: 'timeout: no first token in 120 s',
    })
    h.answer({ ok: true, model: 'm', text: 'I can see a person.' })
    expect(await h.service.propose({ ...base, profileId: 'mac-qwen' })).toMatchObject({
      kind: 'refused',
      reason: 'malformed-answer',
    })
  })
})
