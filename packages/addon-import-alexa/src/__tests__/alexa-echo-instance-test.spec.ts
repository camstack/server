/**
 * The Echo instance can be TESTED: the old probe (the Amazon account of the target is signed in on its
 * broker) answers the tri-state of `testInstance` instead of `unsupported`.
 */
import { makeInMemoryRecords, notificationTargetParts } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { alexaNotifyRecordKinds, echoTargetProbe } from '../speak/echo-store.js'
import { alexaTargetKind } from '../speak/provider.js'

async function echoInstances(ready: boolean | null) {
  const memory = makeInMemoryRecords('import-alexa')
  await memory.records.declare(alexaNotifyRecordKinds)
  const [part] = notificationTargetParts(memory.records, {
    descriptors: [alexaTargetKind()],
    kinds: alexaNotifyRecordKinds,
    mintId: () => 'minted',
    probe: echoTargetProbe(() =>
      ready === null
        ? null
        : {
            provider: {
              probeTargetConfig: async () =>
                ready
                  ? { ok: true, resolvedUrl: 'alexa://session' }
                  : {
                      ok: false,
                      resolvedUrl: 'alexa://session',
                      error: 'the Amazon account is not signed in on its broker',
                    },
            },
          },
    ),
    canProbe: () => true,
  })
  if (part === undefined) throw new Error('no Echo instance kind')
  return part
}

describe('testing an Echo instance', () => {
  it('declares itself testable', async () => {
    expect((await echoInstances(true)).kind.canTest).toBe(true)
  })

  it('validates when the broker account is signed in', async () => {
    const part = await echoInstances(true)
    expect(await part.provider.testInstance?.({ id: null, values: {} })).toMatchObject({
      success: true,
      status: 'validated',
    })
  })

  it('is inconclusive, with the reason, when the account is not signed in', async () => {
    const part = await echoInstances(false)
    expect(await part.provider.testInstance?.({ id: null, values: {} })).toMatchObject({
      success: false,
      status: 'inconclusive',
      error: 'the Amazon account is not signed in on its broker',
    })
  })

  it('is inconclusive, never unsupported, while speech is not running', async () => {
    const part = await echoInstances(null)
    expect(await part.provider.testInstance?.({ id: null, values: {} })).toMatchObject({
      status: 'inconclusive',
    })
  })
})
