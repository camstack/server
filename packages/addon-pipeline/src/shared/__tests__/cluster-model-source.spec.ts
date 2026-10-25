/**
 * How the ONE cluster model row reaches the runner.
 *
 * The MODEL comes from the owner's three-way answer
 * (`pipelineOrchestrator.getClusterModelChoice`, D651): stored, absent (the
 * default BY ABSENCE), or no answer. A step is KNOWN only once the owner has
 * answered for it; before that it is refused by name, never defaulted (D658) —
 * a default run during the owner's boot window made that default the pool's
 * active variant for the runner's whole life. Once known, no answer keeps the
 * last known model. The step KNOBS still come from the hydrated global view.
 */
import { describe, expect, it, vi } from 'vitest'
import { type ClusterModelChoice, clusterStepSettingKey } from '@camstack/types'
import {
  CLUSTER_MODEL_OWNER_ADDON_ID,
  ClusterModelSource,
  type ClusterModelSettingsApi,
} from '../cluster-model-source.js'

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

type Answers = Readonly<Record<string, ClusterModelChoice | Error>>

const stored = (modelId: string): ClusterModelChoice => ({ kind: 'stored', modelId })
const absent = (defaultModelId: string): ClusterModelChoice => ({ kind: 'absent', defaultModelId })
const notReady: ClusterModelChoice = { kind: 'unreadable', reason: 'owner-not-ready' }

interface FakeOwner {
  readonly api: ClusterModelSettingsApi
  readonly calls: Array<{ stepId: string }>
  readonly viewCalls: Array<{ addonId: string }>
  answer(next: Answers): void
}

function owner(initial: Answers, view: unknown = null): FakeOwner {
  let answers = initial
  const calls: Array<{ stepId: string }> = []
  const viewCalls: Array<{ addonId: string }> = []
  return {
    calls,
    viewCalls,
    answer: (next) => {
      answers = next
    },
    api: {
      addonSettings: {
        getGlobalSettings: {
          query: async (input) => {
            viewCalls.push(input)
            return view as null
          },
        },
      },
      pipelineOrchestrator: {
        getClusterModelChoice: {
          query: async (input) => {
            calls.push(input)
            const a = answers[input.stepId]
            if (a === undefined) return notReady
            if (a instanceof Error) throw a
            return a
          },
        },
      },
    },
  }
}

const BOTH_STORED: Answers = {
  'face-embedding': stored('auraface-r100'),
  'clip-embedding': stored('siglip2-b16-224'),
}

describe('ClusterModelSource — known only when the owner answers (D658)', () => {
  it('before any answer every cluster step is UNKNOWN — no default is served', () => {
    const source = new ClusterModelSource({ logger: silentLogger })
    expect(source.current()).toEqual({})
    expect([...source.unknownSteps().keys()].toSorted()).toEqual([
      'clip-embedding',
      'face-embedding',
    ])
  })

  it('an owner that is not ready leaves the step unknown — the boot window runs NOTHING', async () => {
    const warns: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const source = new ClusterModelSource({
      logger: {
        ...silentLogger,
        warn: (message: string, extras?: { meta?: Record<string, unknown> }) =>
          warns.push({ message, ...(extras?.meta ? { meta: extras.meta } : {}) }),
      },
    })
    await source.refresh(owner({}).api)
    expect(source.current()).toEqual({})
    expect(source.unknownSteps().get('face-embedding')).toBe('owner-not-ready')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toMatch(/REFUSED/)
  })

  it('a stored choice and a default BY ABSENCE are both answers', async () => {
    const source = new ClusterModelSource({ logger: silentLogger })
    await source.refresh(
      owner({
        'face-embedding': absent('auraface-r100'),
        'clip-embedding': stored('mobileclip-s2'),
      }).api,
    )
    expect(source.current()).toEqual({
      'face-embedding': 'auraface-r100',
      'clip-embedding': 'mobileclip-s2',
    })
    expect(source.unknownSteps().size).toBe(0)
  })

  it('asks the ORCHESTRATOR, per step, with no nodeId — the choice is cluster-wide', async () => {
    const o = owner(BOTH_STORED)
    await new ClusterModelSource({ logger: silentLogger }).refresh(o.api)
    expect(o.calls.map((c) => c.stepId).toSorted()).toEqual(['clip-embedding', 'face-embedding'])
    expect(o.calls.every((c) => !('nodeId' in c))).toBe(true)
    expect(o.viewCalls).toEqual([{ addonId: CLUSTER_MODEL_OWNER_ADDON_ID }])
    expect(CLUSTER_MODEL_OWNER_ADDON_ID).toBe('pipeline-orchestrator')
  })

  it('once known, no answer — unreadable or a throw — keeps the LAST KNOWN model', async () => {
    let clock = 0
    const o = owner(BOTH_STORED)
    const source = new ClusterModelSource({ logger: silentLogger, now: () => clock, ttlMs: 10 })
    await source.refresh(o.api)
    o.answer({ 'face-embedding': notReady, 'clip-embedding': new Error('hub unreachable') })
    clock += 100
    await source.refresh(o.api)
    expect(source.current()).toEqual({
      'face-embedding': 'auraface-r100',
      'clip-embedding': 'siglip2-b16-224',
    })
    expect(source.unknownSteps().size).toBe(0)
  })

  it('an unknown step is asked again after the SHORT retry, a known row only after the TTL', async () => {
    let clock = 0
    const o = owner({})
    const source = new ClusterModelSource({
      logger: silentLogger,
      now: () => clock,
      ttlMs: 60_000,
      unknownRetryMs: 5_000,
    })
    await source.refresh(o.api)
    await source.refresh(o.api)
    expect(o.calls).toHaveLength(2) // one ask per step, then cached
    o.answer(BOTH_STORED)
    clock += 5_000
    await source.refresh(o.api)
    expect(source.unknownSteps().size).toBe(0)
    const asked = o.calls.length
    clock += 5_000
    await source.refresh(o.api)
    expect(o.calls).toHaveLength(asked)
    clock += 60_000
    await source.refresh(o.api)
    expect(o.calls.length).toBeGreaterThan(asked)
  })

  it('announces a CHANGE once, naming both models', async () => {
    const infos: Array<{ message: string; meta?: Record<string, unknown> }> = []
    let clock = 0
    const o = owner(BOTH_STORED)
    const source = new ClusterModelSource({
      logger: {
        ...silentLogger,
        info: (message: string, extras?: { meta?: Record<string, unknown> }) =>
          infos.push({ message, ...(extras?.meta ? { meta: extras.meta } : {}) }),
      },
      now: () => clock,
      ttlMs: 10,
    })
    await source.refresh(o.api)
    o.answer({ ...BOTH_STORED, 'face-embedding': stored('arcface-r100') })
    clock += 100
    await source.refresh(o.api)
    const changes = infos.filter((i) => i.message.startsWith('cluster step model changed'))
    expect(changes).toHaveLength(1)
    expect(changes[0]?.meta?.['changed']).toEqual([
      { stepId: 'face-embedding', from: 'auraface-r100', to: 'arcface-r100' },
    ])
  })

  it('reads the step knobs from the owner global view; a null view changes nothing', async () => {
    const view = {
      sections: [
        {
          fields: [
            { key: clusterStepSettingKey('face-embedding', 'minLandmarkFaceSize'), value: 32 },
          ],
        },
      ],
    }
    let clock = 0
    const source = new ClusterModelSource({ logger: silentLogger, now: () => clock, ttlMs: 10 })
    expect(source.currentSettings()['face-embedding']?.['minLandmarkFaceSize']).toBe(24)
    await source.refresh(owner(BOTH_STORED, view).api)
    expect(source.currentSettings()['face-embedding']?.['minLandmarkFaceSize']).toBe(32)
    clock += 100
    await source.refresh(owner(BOTH_STORED, null).api)
    expect(source.currentSettings()['face-embedding']?.['minLandmarkFaceSize']).toBe(32)
  })

  it('concurrent refreshes share ONE read', async () => {
    const o = owner(BOTH_STORED)
    const spy = vi.spyOn(o.api.pipelineOrchestrator.getClusterModelChoice, 'query')
    const source = new ClusterModelSource({ logger: silentLogger })
    await Promise.all([source.refresh(o.api), source.refresh(o.api), source.refresh(o.api)])
    expect(spy).toHaveBeenCalledTimes(2) // one per step
  })
})
