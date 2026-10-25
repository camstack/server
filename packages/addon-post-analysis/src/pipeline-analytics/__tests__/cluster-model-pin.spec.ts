/**
 * The pin a re-embed pass runs under.
 *
 * The one property that matters: an UNREADABLE row and an UNCONFIGURED cluster
 * must not look the same. Unconfigured means "running the defaults", which is a
 * real answer a pass may pin. Unreadable means "I could not ask", and a pass
 * that treats it as the defaults writes a whole index on a guess.
 */
import { describe, expect, it } from 'vitest'
import { clusterModelSettingKey, DEFAULT_CLUSTER_STEP_MODELS } from '@camstack/types'
import {
  CLUSTER_MODEL_OWNER_ADDON_ID,
  readClusterModelPinStrict,
  readClusterModelRow,
  resolveClusterModelPin,
} from '../cluster-model-pin.js'

const silent = { warn: () => undefined }

const apiReturning = (view: unknown, calls: unknown[] = []) => ({
  addonSettings: {
    getGlobalSettings: {
      query: async (input: { addonId: string }) => {
        calls.push(input)
        return view as never
      },
    },
  },
})

const apiThrowing = () => ({
  addonSettings: {
    getGlobalSettings: {
      query: async () => {
        throw new Error('hub unreachable')
      },
    },
  },
})

describe('readClusterModelRow', () => {
  it('reads the ORCHESTRATOR global settings, with no nodeId', async () => {
    const calls: Array<Record<string, unknown>> = []
    await readClusterModelRow(
      apiReturning(
        {
          sections: [
            { fields: [{ key: clusterModelSettingKey('clip-embedding'), value: 'mobileclip-s2' }] },
          ],
        },
        calls,
      ),
      silent,
    )
    expect(calls).toEqual([{ addonId: CLUSTER_MODEL_OWNER_ADDON_ID }])
    expect(calls[0]).not.toHaveProperty('nodeId')
  })

  it('an UNCONFIGURED cluster is the defaults — a real answer a pass may pin', async () => {
    expect(await readClusterModelRow(apiReturning(null), silent)).toEqual(
      DEFAULT_CLUSTER_STEP_MODELS,
    )
  })

  it('an UNREADABLE row is null — never the defaults', async () => {
    expect(await readClusterModelRow(apiThrowing(), silent)).toBeNull()
  })

  it('says so when the read fails: a silent guess is what this exists to prevent', async () => {
    const warns: string[] = []
    await readClusterModelRow(apiThrowing(), { warn: (m: string) => warns.push(m) })
    expect(warns).toHaveLength(1)
  })
})

describe('resolveClusterModelPin', () => {
  it('pins the chosen model for a cluster-scoped step', async () => {
    const view = {
      sections: [
        { fields: [{ key: clusterModelSettingKey('face-embedding'), value: 'auraface-r100' }] },
      ],
    }
    expect(await resolveClusterModelPin(apiReturning(view), 'face-embedding', silent)).toBe(
      'auraface-r100',
    )
  })

  it('refuses a step that is not cluster-scoped rather than inventing a pin', async () => {
    const warns: string[] = []
    const pin = await resolveClusterModelPin(apiReturning(null), 'object-detection', {
      warn: (m: string) => warns.push(m),
    })
    expect(pin).toBeNull()
    expect(warns).toHaveLength(1)
  })

  it('refuses when the row cannot be read', async () => {
    expect(await resolveClusterModelPin(apiThrowing(), 'clip-embedding', silent)).toBeNull()
  })
})

/**
 * D651 fix round 3: the pin a pass that REWRITES an index runs under is the
 * OWNER's answer — `pipelineOrchestrator.getClusterModelChoice`, a three-way
 * read of the orchestrator's own store once its boot has settled. Not the
 * hydrated view (which answers `value ?? default`), and not the owner's
 * private store layout.
 */
describe('readClusterModelPinStrict — the owner answers', () => {
  function ownerAnswering(answer: unknown, calls: unknown[] = []) {
    return {
      pipelineOrchestrator: {
        getClusterModelChoice: {
          query: async (input: { stepId: string }) => {
            calls.push(input)
            return answer
          },
        },
      },
    }
  }
  function ownerThrowing(message: string) {
    return {
      pipelineOrchestrator: {
        getClusterModelChoice: {
          query: async () => {
            throw new Error(message)
          },
        },
      },
    }
  }

  it('asks the owner for exactly this step', async () => {
    const calls: unknown[] = []
    await readClusterModelPinStrict(
      ownerAnswering({ kind: 'absent', defaultModelId: 'x' }, calls),
      'face-embedding',
    )
    expect(calls).toEqual([{ stepId: 'face-embedding' }])
  })

  it('a stored choice is known', async () => {
    expect(
      await readClusterModelPinStrict(
        ownerAnswering({ kind: 'stored', modelId: 'arcface-r100' }),
        'face-embedding',
      ),
    ).toEqual({ kind: 'known', modelId: 'arcface-r100' })
  })

  it('an absent key is not-stored — the default BY absence, named as such', async () => {
    expect(
      await readClusterModelPinStrict(
        ownerAnswering({ kind: 'absent', defaultModelId: 'auraface-r100' }),
        'face-embedding',
      ),
    ).toEqual({ kind: 'not-stored', defaultModelId: 'auraface-r100' })
  })

  it("the owner's unreadable reason is carried through, never turned into the default", async () => {
    for (const reason of ['owner-not-ready', 'store-read-failed', 'invalid-stored'] as const) {
      expect(
        await readClusterModelPinStrict(
          ownerAnswering({ kind: 'unreadable', reason }),
          'face-embedding',
        ),
      ).toEqual({ kind: 'unknown', reason })
    }
  })

  it('an orchestrator WITHOUT the method (rolling release) is method-unavailable', async () => {
    expect(await readClusterModelPinStrict({}, 'face-embedding')).toEqual({
      kind: 'unknown',
      reason: 'method-unavailable',
    })
    expect(await readClusterModelPinStrict({ pipelineOrchestrator: {} }, 'face-embedding')).toEqual(
      { kind: 'unknown', reason: 'method-unavailable' },
    )
    for (const message of [
      'Capability "pipeline-orchestrator" has no method "getClusterModelChoice"',
      'No procedure found on path "pipelineOrchestrator.getClusterModelChoice"',
      // The hop that answers for a FORKED orchestrator (child-cap-dispatch.ts).
      "child-cap-dispatch: method 'getClusterModelChoice' not found on provider 'pipeline-orchestrator'",
    ]) {
      expect(
        await readClusterModelPinStrict(ownerThrowing(message), 'face-embedding'),
      ).toMatchObject({ kind: 'unknown', reason: 'method-unavailable' })
    }
    // An old provider whose router answers `undefined` for a missing method.
    expect(await readClusterModelPinStrict(ownerAnswering(undefined), 'face-embedding')).toEqual({
      kind: 'unknown',
      reason: 'method-unavailable',
    })
  })

  it('any other failure, or an unparseable answer, is read-failed', async () => {
    expect(await readClusterModelPinStrict(ownerThrowing('UDS timeout'), 'face-embedding')).toEqual(
      { kind: 'unknown', reason: 'read-failed', error: 'UDS timeout' },
    )
    expect(
      await readClusterModelPinStrict(ownerAnswering({ kind: 'stored' }), 'face-embedding'),
    ).toMatchObject({ kind: 'unknown', reason: 'read-failed' })
  })

  it('a TypeError thrown INSIDE the owner is read-failed, not a missing method', async () => {
    const message =
      "Cannot read properties of null (reading 'readAddonStoreResult'): read.call is not a function"
    expect(await readClusterModelPinStrict(ownerThrowing(message), 'face-embedding')).toEqual({
      kind: 'unknown',
      reason: 'read-failed',
      error: message,
    })
  })
})
